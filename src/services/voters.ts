import { isUniqueViolation, type Db } from '../db/pool.js';
import { covers, type Scope } from '../lib/admins.js';
import { ApiError, fail, failIfErrors } from '../lib/errors.js';
import { nextNumber } from '../lib/ids.js';
import { GENDERS, HOUSEHOLD_ID_PATTERN, pad, str, VOTER_STATUSES, type Gender, type VoterStatus } from '../lib/validation.js';
import { TXN_SELECT, txnFor, type PaymentTransaction } from './payments.js';

export interface VoterInput {
  voterId: string;
  fullName: string;
  wardId: string;
  /** Optional: '' when the voter has no booth (ward rolls have none). */
  boothId: string;
  houseNumber: string;
  householdId: string;
  address: string;
  status: VoterStatus;
  /** As printed on the roll (వయస్సు); null when unknown. */
  age: number | null;
  /** As printed on the roll (లింగము); '' when unknown. */
  gender: Gender;
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

export const VOTER_COLUMNS = `v.record_id AS "recordId", v.voter_id AS "voterId", v.full_name AS "fullName",
  v.ward_id AS "wardId", COALESCE(v.booth_id, '') AS "boothId", v.house_number AS "houseNumber", v.household_id AS "householdId",
  v.address, v.status, v.age, v.gender, v.created_at AS "createdAt", v.updated_at AS "updatedAt"`;

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
  const wardId = str(body.wardId);
  const boothId = str(body.boothId);
  const status = body.status as VoterStatus;
  const ageRaw = body.age === null || body.age === undefined ? '' : String(body.age).trim();
  const age = ageRaw === '' ? null : Number(ageRaw);
  const gender = str(body.gender) as Gender;

  if (!voterId) errors.voterId = 'Voter ID is required';
  else if (voterId.length > 30) errors.voterId = 'Voter ID is too long';
  if (fullName.length < 2) errors.fullName = 'Full name is required';
  else if (fullName.length > 100) errors.fullName = 'Full name is too long';
  if (!houseNumber) errors.houseNumber = 'House number is required';
  else if (houseNumber.length > 30) errors.houseNumber = 'House number is too long';
  if (address.length > 250) errors.address = 'Address is too long';
  if (!refs.has(wardId)) errors.wardId = 'Select a valid ward';
  else if (boothId && !refs.get(wardId)!.has(boothId)) errors.boothId = 'Select a booth in this ward';
  if (!VOTER_STATUSES.includes(status)) errors.status = 'Select a voter status';
  if (age !== null && (!Number.isInteger(age) || age < 18 || age > 120)) errors.age = 'Age must be a whole number from 18 to 120';
  if (gender && !(GENDERS as readonly string[]).includes(gender)) errors.gender = 'Choose Male, Female or Other';
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
  return { voterId, fullName, wardId, boothId, houseNumber, householdId, address, status, age, gender };
}

export function voterIdConflict(): ApiError {
  return new ApiError(409, 'CONFLICT', 'A voter with this Voter ID already exists.', { voterId: 'This Voter ID already exists' });
}

/** Adds payment status. A voter has at most one successful payment; lists only hold voters in the admin's area. */
export async function toListItems(db: Db, scope: Scope, voters: Voter[]): Promise<VoterListItem[]> {
  const ids = voters.map((v) => v.recordId);
  const txs = ids.length
    ? (await db.query<PaymentTransaction>(`${TXN_SELECT} WHERE t.voter_record_id = ANY($1) AND t.status = 'Success'`, [ids])).rows.map(txnFor(scope))
    : [];
  const byVoter = new Map(txs.map((t) => [t.voterRecordId, t]));
  return voters.map((v) => {
    const tx = byVoter.get(v.recordId) ?? null;
    return {
      ...v,
      paymentStatus: tx ? 'Received' : 'Not Received',
      latestPayment: tx,
      canRecordPayment: !tx && v.status === 'Active' && covers(scope, v),
    };
  });
}

export async function loadVoter(db: Db, recordId: string, lock = false): Promise<Voter> {
  const { rows } = await db.query<Voter>(`SELECT ${VOTER_COLUMNS} FROM voters v WHERE v.record_id = $1${lock ? ' FOR UPDATE' : ''}`, [recordId]);
  if (!rows[0]) fail(404, 'NOT_FOUND', 'Voter not found.');
  return rows[0];
}

/** The voter with this Voter ID (any case), if there is one. */
export async function findVoterByVoterId(db: Db, voterId: string, lock = false): Promise<Voter | undefined> {
  const { rows } = await db.query<Voter>(`SELECT ${VOTER_COLUMNS} FROM voters v WHERE upper(v.voter_id) = upper($1)${lock ? ' FOR UPDATE' : ''}`, [voterId.trim()]);
  return rows[0];
}

/** Saves validated details over an existing voter (the voter form, or an import that replaces a voter). */
export async function updateVoter(db: Db, recordId: string, input: VoterInput): Promise<Voter> {
  const { rows } = await db
    .query<Voter>(
      `UPDATE voters v SET voter_id = $2, full_name = $3, ward_id = $4, booth_id = NULLIF($5, ''), house_number = $6, household_id = $7,
         address = $8, status = $9, age = $10, gender = $11, updated_at = now()
       WHERE record_id = $1 RETURNING ${VOTER_COLUMNS}`,
      [recordId, input.voterId, input.fullName, input.wardId, input.boothId, input.houseNumber, input.householdId, input.address, input.status, input.age, input.gender],
    )
    .catch((err) => {
      if (isUniqueViolation(err, 'voters_voter_id_ci_idx')) throw voterIdConflict();
      throw err;
    });
  return rows[0];
}

/** Inserts a validated voter. Used by the voter form and the import. */
export async function insertVoter(db: Db, input: VoterInput): Promise<Voter> {
  const recordId = `VR-${pad(await nextNumber(db, 'voter'), 6)}`;
  const { rows } = await db
    .query<Voter>(
      `INSERT INTO voters AS v (record_id, voter_id, full_name, ward_id, booth_id, house_number, household_id, address, status, age, gender, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, $9, $10, $11, now(), now()) RETURNING ${VOTER_COLUMNS}`,
      [recordId, input.voterId, input.fullName, input.wardId, input.boothId, input.houseNumber, input.householdId, input.address, input.status, input.age, input.gender],
    )
    .catch((err) => {
      if (isUniqueViolation(err, 'voters_voter_id_ci_idx')) throw voterIdConflict();
      throw err;
    });
  return rows[0];
}
