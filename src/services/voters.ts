import { isUniqueViolation, type Db } from '../db/pool.js';
import { covers, type Admin, type Scope } from '../lib/admins.js';
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
  /** Serial number in the ward roll (shared by every team); null when unknown. */
  serialNumber: number | null;
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
  /** Permission for a BLO to pay a Shifted voter (null = never asked). */
  shiftedApproval: 'Pending' | 'Approved' | 'Rejected' | null;
}

/**
 * Voters as one team sees them (alias it `v`): the shared ward list with that team's own changes, and a
 * `hidden` flag for voters the team removed. `team` is a SQL value (a parameter); NULL gives the shared list.
 */
export function votersView(team: string): string {
  const own = (col: string) => `CASE WHEN o.details THEN o.${col} ELSE b.${col} END AS ${col}`;
  return `(SELECT b.record_id, b.voter_id, b.ward_id, b.serial_number, b.created_at, COALESCE(o.updated_at, b.updated_at) AS updated_at,
      ${['full_name', 'booth_id', 'house_number', 'household_id', 'address', 'age', 'gender'].map(own).join(', ')},
      COALESCE(o.status, b.status) AS status, COALESCE(o.hidden, false) AS hidden
    FROM voters b LEFT JOIN voter_overrides o ON o.voter_record_id = b.record_id AND o.team_id = ${team})`;
}

export const VOTER_COLUMNS = `v.record_id AS "recordId", v.voter_id AS "voterId", v.full_name AS "fullName",
  v.ward_id AS "wardId", COALESCE(v.booth_id, '') AS "boothId", v.house_number AS "houseNumber", v.household_id AS "householdId",
  v.address, v.status, v.age, v.gender, v.serial_number AS "serialNumber", v.created_at AS "createdAt", v.updated_at AS "updatedAt"`;

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
  // "Not Active" was the old name of Dead.
  const status = (body.status === 'Not Active' ? 'Dead' : body.status) as VoterStatus;
  const ageRaw = body.age === null || body.age === undefined ? '' : String(body.age).trim();
  const age = ageRaw === '' ? null : Number(ageRaw);
  const gender = str(body.gender) as Gender;
  const serialNumber = parseSerialNumber(body.serialNumber);

  if (!voterId) errors.voterId = 'Voter ID is required';
  else if (voterId.length > 30) errors.voterId = 'Voter ID is too long';
  if (fullName.length < 2) errors.fullName = 'Full name is required';
  else if (fullName.length > 100) errors.fullName = 'Full name is too long';
  if (!houseNumber) errors.houseNumber = 'House number is required';
  else if (houseNumber.length > 100) errors.houseNumber = 'House number is too long (at most 100 characters)';
  if (address.length > 250) errors.address = 'Address is too long';
  if (!refs.has(wardId)) errors.wardId = 'Select a valid ward';
  else if (boothId && !refs.get(wardId)!.has(boothId)) errors.boothId = 'Select a booth in this ward';
  if (!VOTER_STATUSES.includes(status)) errors.status = 'Select a voter status';
  if (age !== null && (!Number.isInteger(age) || age < 18 || age > 120)) errors.age = 'Age must be a whole number from 18 to 120';
  if (gender && !(GENDERS as readonly string[]).includes(gender)) errors.gender = 'Choose Male, Female or Other';
  if (Number.isNaN(serialNumber)) errors.serialNumber = 'Serial number must be a whole number from 1 to 999999';
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
  return { voterId, fullName, wardId, boothId, houseNumber, householdId, address, status, age, gender, serialNumber };
}

/** Sets a voter's shared serial number from an imported roll. True when it changed. */
export async function setSerialNumber(db: Db, recordId: string, serialNumber: number): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE voters SET serial_number = $2 WHERE record_id = $1 AND serial_number IS DISTINCT FROM $2', [recordId, serialNumber]);
  return (rowCount ?? 0) > 0;
}

/** A serial number from a form or file: null when empty, NaN when not a whole number from 1 to 999999. */
export function parseSerialNumber(raw: unknown): number | null {
  const text = raw === null || raw === undefined ? '' : String(raw).trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= 999999 ? n : NaN;
}

export function voterIdConflict(): ApiError {
  return new ApiError(409, 'CONFLICT', 'A voter with this Voter ID already exists.', { voterId: 'This Voter ID already exists' });
}

/**
 * Adds the team's payment status. A voter has at most one successful payment per team; lists only hold voters in
 * the admin's area. Without a team (the Super Admin's shared view) a voter paid by any team shows as Received.
 * Active voters can be paid; Shifted voters too, but a BLO needs its Corporator's permission; Dead never.
 * Super Admins do not record payments.
 */
export async function toListItems(db: Db, scope: Scope, voters: Voter[], role: Admin['role']): Promise<VoterListItem[]> {
  const ids = voters.map((v) => v.recordId);
  const txs = ids.length
    ? (await db.query<PaymentTransaction>(
        `${TXN_SELECT} WHERE t.voter_record_id = ANY($1) AND t.status = 'Success' AND ($2::text IS NULL OR t.team_id = $2) ORDER BY t."timestamp"`,
        [ids, scope.teamId],
      )).rows.map(txnFor(scope))
    : [];
  const byVoter = new Map(txs.map((t) => [t.voterRecordId, t]));
  const shiftedIds = voters.filter((v) => v.status === 'Shifted').map((v) => v.recordId);
  const approvals = new Map(
    shiftedIds.length && scope.teamId
      ? (await db.query<{ id: string; status: VoterListItem['shiftedApproval'] }>(
          'SELECT voter_record_id AS id, status FROM shifted_approvals WHERE voter_record_id = ANY($1) AND team_id = $2',
          [shiftedIds, scope.teamId],
        )).rows.map((r) => [r.id, r.status])
      : [],
  );
  return voters.map((v) => {
    const tx = byVoter.get(v.recordId) ?? null;
    const shiftedApproval = v.status === 'Shifted' ? approvals.get(v.recordId) ?? null : null;
    const payable = v.status === 'Active' || (v.status === 'Shifted' && (role !== 'BLO' || shiftedApproval === 'Approved'));
    return {
      ...v,
      paymentStatus: tx ? 'Received' : 'Not Received',
      latestPayment: tx,
      canRecordPayment: role !== 'SUPER_ADMIN' && !tx && payable && covers(scope, v),
      shiftedApproval,
    };
  });
}

/**
 * A voter as the team sees it (null team: the shared record). A voter the team removed is not found.
 * `lock` locks the shared record (it serialises payments and changes for the voter).
 */
export async function loadVoter(db: Db, recordId: string, lock = false, teamId: string | null = null, includeHidden = false): Promise<Voter> {
  if (lock) await db.query('SELECT 1 FROM voters WHERE record_id = $1 FOR UPDATE', [recordId]);
  const { rows } = await db.query<Voter>(
    `SELECT ${VOTER_COLUMNS} FROM ${votersView('$2')} v WHERE v.record_id = $1${includeHidden ? '' : ' AND NOT v.hidden'}`,
    [recordId, teamId],
  );
  if (!rows[0]) fail(404, 'NOT_FOUND', 'Voter not found.');
  return rows[0];
}

/** The shared voter with this Voter ID (any case), if there is one; `hidden` tells whether the team removed it. */
export async function findVoterByVoterId(db: Db, voterId: string, lock = false, teamId: string | null = null): Promise<(Voter & { hidden: boolean }) | undefined> {
  if (lock) await db.query('SELECT 1 FROM voters WHERE upper(voter_id) = upper($1) FOR UPDATE', [voterId.trim()]);
  const { rows } = await db.query<Voter & { hidden: boolean }>(
    `SELECT ${VOTER_COLUMNS}, v.hidden FROM ${votersView('$2')} v WHERE upper(v.voter_id) = upper($1)`,
    [voterId.trim(), teamId],
  );
  return rows[0];
}

/**
 * Saves a team's own details for a shared voter (its voter form or an import that replaces the voter). The
 * Voter ID and ward are shared by every team, so only the Super Admin changes them. The voter is shown again
 * if the team had removed it.
 */
export async function saveTeamVoter(db: Db, teamId: string, current: Voter, input: VoterInput): Promise<Voter> {
  if (input.voterId.toUpperCase() !== current.voterId.toUpperCase() || input.wardId !== current.wardId) {
    fail(400, 'VALIDATION', 'The Voter ID and ward are shared with other Corporators and cannot be changed here.', {
      ...(input.voterId.toUpperCase() !== current.voterId.toUpperCase() ? { voterId: 'Only the Super Admin can change the Voter ID' } : {}),
      ...(input.wardId !== current.wardId ? { wardId: 'Only the Super Admin can move a voter to another ward' } : {}),
    });
  }
  await db.query(
    `INSERT INTO voter_overrides (team_id, voter_record_id, details, full_name, booth_id, house_number, household_id, address, age, gender, status, hidden, updated_at)
     VALUES ($1, $2, true, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, $10, false, now())
     ON CONFLICT (team_id, voter_record_id) DO UPDATE SET details = true, full_name = $3, booth_id = NULLIF($4, ''), house_number = $5,
       household_id = $6, address = $7, age = $8, gender = $9, status = $10, hidden = false, updated_at = now()`,
    [teamId, current.recordId, input.fullName, input.boothId, input.houseNumber, input.householdId, input.address, input.age, input.gender, input.status],
  );
  return loadVoter(db, current.recordId, false, teamId);
}

/** Sets a team's own status for shared voters (a deaths / shifted list, or its voter form). */
export async function setTeamStatus(db: Db, teamId: string, recordIds: string[], status: VoterStatus): Promise<void> {
  await db.query(
    `INSERT INTO voter_overrides (team_id, voter_record_id, status, updated_at) SELECT $1, unnest($2::text[]), $3, now()
     ON CONFLICT (team_id, voter_record_id) DO UPDATE SET status = $3, updated_at = now()`,
    [teamId, recordIds, status],
  );
}

/** Removes a shared voter from one team's list only (other Corporators keep it). */
export async function hideForTeam(db: Db, teamId: string, recordId: string): Promise<void> {
  await db.query(
    `INSERT INTO voter_overrides (team_id, voter_record_id, hidden, updated_at) VALUES ($1, $2, true, now())
     ON CONFLICT (team_id, voter_record_id) DO UPDATE SET hidden = true, updated_at = now()`,
    [teamId, recordId],
  );
}

/** Saves validated details over an existing voter (the voter form, or an import that replaces a voter). */
export async function updateVoter(db: Db, recordId: string, input: VoterInput): Promise<Voter> {
  const { rows } = await db
    .query<Voter>(
      `UPDATE voters v SET voter_id = $2, full_name = $3, ward_id = $4, booth_id = NULLIF($5, ''), house_number = $6, household_id = $7,
         address = $8, status = $9, age = $10, gender = $11, serial_number = $12, updated_at = now()
       WHERE record_id = $1 RETURNING ${VOTER_COLUMNS}`,
      [recordId, input.voterId, input.fullName, input.wardId, input.boothId, input.houseNumber, input.householdId, input.address, input.status, input.age, input.gender, input.serialNumber],
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
      `INSERT INTO voters AS v (record_id, voter_id, full_name, ward_id, booth_id, house_number, household_id, address, status, age, gender, serial_number, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, $9, $10, $11, $12, now(), now()) RETURNING ${VOTER_COLUMNS}`,
      [recordId, input.voterId, input.fullName, input.wardId, input.boothId, input.houseNumber, input.householdId, input.address, input.status, input.age, input.gender, input.serialNumber],
    )
    .catch((err) => {
      if (isUniqueViolation(err, 'voters_voter_id_ci_idx')) throw voterIdConflict();
      throw err;
    });
  return rows[0];
}
