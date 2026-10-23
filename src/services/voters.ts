import { isUniqueViolation, type Db } from '../db/pool.js';
import { covers, type Scope } from '../lib/admins.js';
import { ApiError, fail, failIfErrors } from '../lib/errors.js';
import { nextNumber } from '../lib/ids.js';
import { HOUSEHOLD_ID_PATTERN, isValidIndianMobile, normalizeMobile, pad, str, VOTER_STATUSES, type VoterStatus } from '../lib/validation.js';
import { cleanTxn, TXN_SELECT, type PaymentTransaction } from './payments.js';

export interface VoterInput {
  voterId: string;
  fullName: string;
  mobile: string;
  wardId: string;
  boothId: string;
  houseNumber: string;
  householdId: string;
  address: string;
  status: VoterStatus;
}

export interface Voter extends VoterInput {
  recordId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface VoterListItem extends Voter {
  paymentStatus: 'Received' | 'Not Received';
  latestPayment: PaymentTransaction | null;
  canRecordPayment: boolean;
}

export const VOTER_COLUMNS = `v.record_id AS "recordId", v.voter_id AS "voterId", v.full_name AS "fullName", v.mobile,
  v.ward_id AS "wardId", v.booth_id AS "boothId", v.house_number AS "houseNumber", v.household_id AS "householdId",
  v.address, v.status, v.created_at AS "createdAt", v.updated_at AS "updatedAt"`;

/** Ward → booth IDs, loaded once per request (imports validate many rows against it). */
export type LocationRefs = Map<string, Set<string>>;

export async function loadLocationRefs(db: Db): Promise<LocationRefs> {
  const refs: LocationRefs = new Map();
  for (const w of (await db.query<{ id: string }>('SELECT id FROM wards')).rows) refs.set(w.id, new Set());
  for (const b of (await db.query<{ id: string; wardId: string }>('SELECT id, ward_id AS "wardId" FROM booths')).rows) refs.get(b.wardId)?.add(b.id);
  return refs;
}

/**
 * Validates and normalises a voter. Field problems throw 400; an existing Voter ID (any case) throws 409.
 * Status is never defaulted: it must be one of the three values.
 */
export async function validateVoterInput(db: Db, refs: LocationRefs, body: Record<string, unknown>, excludeRecordId?: string): Promise<VoterInput> {
  const errors: Record<string, string> = {};
  const voterId = str(body.voterId).trim();
  const fullName = str(body.fullName).trim();
  const houseNumber = str(body.houseNumber).trim();
  const householdId = str(body.householdId).trim();
  const address = str(body.address).trim();
  const mobileRaw = str(body.mobile).trim();
  const wardId = str(body.wardId);
  const boothId = str(body.boothId);
  const status = body.status as VoterStatus;

  if (!voterId) errors.voterId = 'Voter ID is required';
  else if (voterId.length > 30) errors.voterId = 'Voter ID is too long';
  if (fullName.length < 2) errors.fullName = 'Full name is required';
  else if (fullName.length > 100) errors.fullName = 'Full name is too long';
  if (!houseNumber) errors.houseNumber = 'House number is required';
  else if (houseNumber.length > 30) errors.houseNumber = 'House number is too long';
  if (address.length > 250) errors.address = 'Address is too long';
  if (mobileRaw && !isValidIndianMobile(mobileRaw)) errors.mobile = 'Enter a valid 10-digit Indian mobile number';
  if (!refs.has(wardId)) errors.wardId = 'Select a valid ward';
  else if (!refs.get(wardId)!.has(boothId)) errors.boothId = 'Select a booth in this ward';
  if (!VOTER_STATUSES.includes(status)) errors.status = 'Select a voter status';
  if (householdId) {
    if (householdId.length > 30) errors.householdId = 'Household ID is too long';
    else if (!HOUSEHOLD_ID_PATTERN.test(householdId)) errors.householdId = 'Use letters, numbers, - or / only';
    else if (!errors.wardId) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM voters WHERE upper(household_id) = upper($1) AND household_id <> '' AND record_id <> $2 AND ward_id <> $3 LIMIT 1`,
        [householdId, excludeRecordId ?? '', wardId],
      );
      if (rowCount) errors.householdId = 'This household belongs to a different ward';
    }
  }
  failIfErrors(errors);
  const { rowCount } = await db.query('SELECT 1 FROM voters WHERE upper(voter_id) = upper($1) AND record_id <> $2', [voterId, excludeRecordId ?? '']);
  if (rowCount) throw voterIdConflict();
  return { voterId, fullName, mobile: mobileRaw ? normalizeMobile(mobileRaw) : '', wardId, boothId, houseNumber, householdId, address, status };
}

export function voterIdConflict(): ApiError {
  return new ApiError(409, 'CONFLICT', 'A voter with this Voter ID already exists.', { voterId: 'This Voter ID already exists' });
}

/** Adds payment status. A voter has at most one successful payment; lists only hold voters in the admin's area. */
export async function toListItems(db: Db, scope: Scope, voters: Voter[]): Promise<VoterListItem[]> {
  const ids = voters.map((v) => v.recordId);
  const txs = ids.length
    ? (await db.query<PaymentTransaction>(`${TXN_SELECT} WHERE t.voter_record_id = ANY($1) AND t.status = 'Success'`, [ids])).rows.map(cleanTxn)
    : [];
  const byVoter = new Map(txs.map((t) => [t.voterRecordId, t]));
  return voters.map((v) => {
    const tx = byVoter.get(v.recordId) ?? null;
    return {
      ...v,
      paymentStatus: tx ? 'Received' : 'Not Received',
      latestPayment: tx,
      canRecordPayment: !tx && covers(scope, v),
    };
  });
}

export async function loadVoter(db: Db, recordId: string, lock = false): Promise<Voter> {
  const { rows } = await db.query<Voter>(`SELECT ${VOTER_COLUMNS} FROM voters v WHERE v.record_id = $1${lock ? ' FOR UPDATE' : ''}`, [recordId]);
  if (!rows[0]) fail(404, 'NOT_FOUND', 'Voter not found.');
  return rows[0];
}

/** Inserts a validated voter. Used by the voter form and the import. */
export async function insertVoter(db: Db, input: VoterInput): Promise<Voter> {
  const recordId = `VR-${pad(await nextNumber(db, 'voter'), 6)}`;
  const { rows } = await db
    .query<Voter>(
      `INSERT INTO voters AS v (record_id, voter_id, full_name, mobile, ward_id, booth_id, house_number, household_id, address, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now()) RETURNING ${VOTER_COLUMNS}`,
      [recordId, input.voterId, input.fullName, input.mobile, input.wardId, input.boothId, input.houseNumber, input.householdId, input.address, input.status],
    )
    .catch((err) => {
      if (isUniqueViolation(err, 'voters_voter_id_ci_idx')) throw voterIdConflict();
      throw err;
    });
  return rows[0];
}
