import { Router, type Request } from 'express';
import { Params, pool, withTransaction, type Db } from '../db/pool.js';
import { assertOwnWard, covers, coversSql, ownsWard, type Scope } from '../lib/admins.js';
import { fail } from '../lib/errors.js';
import { addAudit } from '../lib/audit.js';
import { pageWindow } from '../lib/pagination.js';
import { likePattern, str, strArray, VOTER_STATUSES, type VoterStatus } from '../lib/validation.js';
import { auth, authenticate, requireWardManager } from '../middleware/auth.js';
import { TXN_SELECT, txnFor, type PaymentTransaction } from '../services/payments.js';
import {
  hideForTeam,
  insertVoter,
  loadLocationRefs,
  loadVoter,
  saveTeamVoter,
  setTeamStatus,
  toListItems,
  updateVoter,
  validateVoterInput,
  VOTER_COLUMNS,
  votersView,
  type Voter,
  type VoterInput,
} from '../services/voters.js';

export const votersRouter = Router();

/** The voter list as the scope's team sees it (alias v), with its ward and booth (w, b) for sorting. */
function fromVoters(scope: Scope, p: Params): string {
  return `FROM ${votersView(p.add(scope.teamId))} v JOIN wards w ON w.id = v.ward_id LEFT JOIN booths b ON b.id = v.booth_id`;
}

/** WHERE clause for the voter list: always the admin's own area, plus the filters (ward, booth, status, payment status, search). */
function voterFilter(q: Request['query'], scope: Scope, p: Params): string {
  // Voters the team removed are left out.
  const where: string[] = ['NOT v.hidden'];
  // Corporators and BLOs only ever see voters in their own area.
  if (!scope.all) where.push(coversSql(scope, (v) => p.add(v), 'v.ward_id', 'v.booth_id'));
  if (str(q.wardId)) where.push(`v.ward_id = ${p.add(str(q.wardId))}`);
  if (str(q.boothId)) where.push(`v.booth_id = ${p.add(str(q.boothId))}`);
  if (str(q.status)) where.push(`v.status = ${p.add(str(q.status))}`);
  // Payment status is the team's own (in the Super Admin's shared view: paid by any team).
  if (q.paymentStatus === 'Received' || q.paymentStatus === 'Not Received') {
    const team = scope.teamId ? ` AND t.team_id = ${p.add(scope.teamId)}` : '';
    const received = `EXISTS (SELECT 1 FROM payment_transactions t WHERE t.voter_record_id = v.record_id AND t.status = 'Success'${team})`;
    where.push(q.paymentStatus === 'Received' ? received : `NOT ${received}`);
  }
  const search = str(q.search).trim();
  if (search) {
    const s = p.add(likePattern(search));
    const parts = [`v.full_name ILIKE ${s}`, `v.voter_id ILIKE ${s}`, `v.household_id ILIKE ${s}`, `v.house_number ILIKE ${s}`];
    where.push(`(${parts.join(' OR ')})`);
  }
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

function voterOrder(q: Request['query']): string {
  const dir = q.sortDir === 'desc' ? 'DESC' : 'ASC';
  const text = (col: string) => `lower(${col}) COLLATE natural_sort ${dir}`;
  const keys: Record<string, string> = {
    ward: `w.number ${dir}, b.number ${dir} NULLS FIRST`,
    booth: `b.number ${dir} NULLS FIRST`,
    voterId: text('v.voter_id'),
    fullName: text('v.full_name'),
    houseNumber: text('v.house_number'),
    status: text('v.status'),
  };
  // Voter ID order by default (the EPIC number printed on the roll).
  return `ORDER BY ${keys[str(q.sortBy)] ?? keys.voterId}, v.record_id`;
}

votersRouter.get('/voters', authenticate, async (req, res) => {
  const { admin, scope } = auth(req);
  const p = new Params();
  const from = fromVoters(scope, p);
  const filter = voterFilter(req.query, scope, p);
  const total = (await pool.query<{ n: number }>(`SELECT count(*) AS n ${from} ${filter}`, p.values)).rows[0].n;
  const win = pageWindow(total, req.query.page, req.query.pageSize);
  const voters = (await pool.query<Voter>(`SELECT ${VOTER_COLUMNS} ${from} ${filter} ${voterOrder(req.query)} LIMIT ${win.pageSize} OFFSET ${win.offset}`, p.values)).rows;
  res.json({ items: await toListItems(pool, scope, voters, admin.role), total, page: win.page, pageSize: win.pageSize });
});

const MAX_STATUS_IDS = 1000;

/**
 * Sets the status of many voters at once by Voter ID, e.g. from a list of dead or shifted
 * voters. Voter IDs are matched ignoring case; unknown IDs are reported back, not created.
 * A Corporator's list changes its own team's statuses only; the Super Admin's changes the shared list.
 */
votersRouter.post('/voters/status', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  // "Not Active" was the old name of Dead.
  const status = (req.body?.status === 'Not Active' ? 'Dead' : req.body?.status) as VoterStatus;
  if (!VOTER_STATUSES.includes(status)) fail(400, 'VALIDATION', 'Select a voter status.', { status: 'Select a voter status' });
  const ids = [...new Set(strArray(req.body?.voterIds).map((id) => id.trim().toUpperCase()).filter(Boolean))];
  if (!ids.length) fail(400, 'VALIDATION', 'No voter IDs were sent.');
  if (ids.length > MAX_STATUS_IDS) fail(400, 'VALIDATION', `Send at most ${MAX_STATUS_IDS} voter IDs per request.`);
  const fileName = str(req.body?.fileName).trim().slice(0, 255) || 'status list';
  const team = actor.role === 'CORPORATOR' ? actor.id : null;
  const result = await withTransaction(async (db) => {
    await db.query('SELECT 1 FROM voters WHERE upper(voter_id) = ANY($1) FOR UPDATE', [ids]);
    const rows = (await db.query<{ recordId: string; voterId: string; status: VoterStatus; wardId: string }>(
      `SELECT v.record_id AS "recordId", upper(v.voter_id) AS "voterId", v.status, v.ward_id AS "wardId"
       FROM ${votersView('$2')} v WHERE upper(v.voter_id) = ANY($1) AND NOT v.hidden`,
      [ids, team],
    )).rows;
    // A Corporator only sees and changes voters in its own wards; others count as not found.
    const found = rows.filter((v) => ownsWard(actor, v.wardId));
    const toChange = found.filter((v) => v.status !== status);
    if (toChange.length) {
      if (team) await setTeamStatus(db, team, toChange.map((v) => v.recordId), status);
      else await db.query('UPDATE voters SET status = $2, updated_at = now() WHERE record_id = ANY($1)', [toChange.map((v) => v.recordId), status]);
      await addAudit(db, actor, 'Voter status changed', 'Voter', fileName, `${toChange.length} voters → ${status} (from ${fileName})`);
    }
    const foundIds = new Set(found.map((v) => v.voterId));
    return { updated: toChange.length, unchanged: found.length - toChange.length, notFound: ids.filter((id) => !foundIds.has(id)) };
  });
  res.json(result);
});

votersRouter.get('/voters/export', authenticate, requireWardManager, async (req, res) => {
  const { admin, scope } = auth(req);
  const p = new Params();
  const from = fromVoters(scope, p);
  const voters = (await pool.query<Voter>(`SELECT ${VOTER_COLUMNS} ${from} ${voterFilter(req.query, scope, p)} ${voterOrder(req.query)}`, p.values)).rows;
  const items = await toListItems(pool, scope, voters, admin.role);
  await addAudit(pool, admin, 'Voters exported', 'Export', 'voters', `${items.length} voter records`);
  res.json(items);
});

votersRouter.get('/voters/duplicate-check', authenticate, requireWardManager, async (req, res) => {
  const voterId = str(req.query.voterId).trim();
  const fullName = str(req.query.fullName).trim();
  const houseNumber = str(req.query.houseNumber).trim();
  const exclude = str(req.query.excludeRecordId);
  const match = voterId
    ? (await pool.query<{ recordId: string; fullName: string; wardId: string }>(
        'SELECT record_id AS "recordId", full_name AS "fullName", ward_id AS "wardId" FROM voters WHERE upper(voter_id) = upper($1) AND record_id <> $2',
        [voterId, exclude],
      )).rows[0]
    : undefined;
  const actor = auth(req).admin;
  const voterIdExists = !!match;
  // Lets the form offer "keep the existing voter" or "replace its details". A voter outside the
  // caller's wards is only reported as existing: its name and ward stay hidden.
  const existing = match && ownsWard(actor, match.wardId) ? { ...match, canReplace: true } : null;
  const wardId = str(req.query.wardId);
  const similar =
    fullName && houseNumber && ownsWard(actor, wardId)
      ? (await pool.query(
          `SELECT record_id AS "recordId", voter_id AS "voterId", full_name AS "fullName", house_number AS "houseNumber"
           FROM voters WHERE ward_id = $1 AND lower(full_name) = lower($2) AND lower(house_number) = lower($3) AND record_id <> $4
           ORDER BY record_id LIMIT 5`,
          [wardId, fullName, houseNumber, exclude],
        )).rows
      : [];
  res.json({ voterIdExists, existing, similar });
});

votersRouter.get('/voters/:recordId', authenticate, async (req, res) => {
  const { admin, scope } = auth(req);
  const voter = await loadVoter(pool, str(req.params.recordId), false, scope.teamId);
  if (!covers(scope, voter)) fail(404, 'NOT_FOUND', 'Voter not found.');
  const [item] = await toListItems(pool, scope, [voter], admin.role);
  // Only the team's own payments (the Super Admin's shared view: every team's).
  const transactions = (await pool.query<PaymentTransaction>(
    `${TXN_SELECT} WHERE t.voter_record_id = $1 AND ($2::text IS NULL OR t.team_id = $2) ORDER BY t."timestamp" DESC, t.id DESC`,
    [voter.recordId, scope.teamId],
  )).rows;
  res.json({ voter: item, transactions: transactions.map(txnFor(scope)) });
});

async function locationLabel(db: Db, v: { wardId: string; boothId: string }): Promise<string> {
  const { rows } = await db.query<{ ward: number; booth: number | null }>(
    'SELECT w.number AS ward, b.number AS booth FROM wards w LEFT JOIN booths b ON b.id = $2 WHERE w.id = $1',
    [v.wardId, v.boothId || null],
  );
  const booth = rows[0]?.booth;
  return booth == null ? `ward ${rows[0]?.ward ?? 0}, no booth` : `ward ${rows[0]?.ward ?? 0}, booth ${booth}`;
}

votersRouter.post('/voters', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  const voter = await withTransaction(async (db) => {
    const input = await validateVoterInput(db, await loadLocationRefs(db), req.body ?? {});
    assertOwnWard(actor, input.wardId);
    const created = await insertVoter(db, input);
    await addAudit(db, actor, 'Voter created', 'Voter', created.voterId, `${created.fullName}, ${await locationLabel(db, created)}, ${created.status}`);
    return created;
  });
  res.status(201).json(voter);
});

const FIELD_LABELS: Record<keyof VoterInput, string> = {
  voterId: 'Voter ID',
  fullName: 'name',
  wardId: 'ward',
  boothId: 'booth',
  houseNumber: 'house number',
  householdId: 'household ID',
  address: 'address',
  status: 'status',
  age: 'age',
  gender: 'gender',
};

/**
 * Removes a voter. A Corporator removes it from its own team's list only (other Corporators keep it); the Super
 * Admin deletes it for everyone. A voter the team (Super Admin: any team) has paid is kept: cancel the payment
 * first. When the Super Admin deletes a voter, its cancelled payments go with it.
 */
votersRouter.delete('/voters/:recordId', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  const team = actor.role === 'CORPORATOR' ? actor.id : null;
  await withTransaction(async (db) => {
    const voter = await loadVoter(db, str(req.params.recordId), true, team);
    if (!ownsWard(actor, voter.wardId)) fail(404, 'NOT_FOUND', 'Voter not found.');
    const paid = await db.query(
      `SELECT 1 FROM payment_transactions WHERE voter_record_id = $1 AND status = 'Success' AND ($2::text IS NULL OR team_id = $2)`,
      [voter.recordId, team],
    );
    if (paid.rowCount) fail(409, 'CONFLICT', 'This voter has received a payment and cannot be removed. Cancel the payment first.');
    if (team) {
      await hideForTeam(db, team, voter.recordId);
    } else {
      await db.query('DELETE FROM idempotency_keys WHERE txn_id IN (SELECT id FROM payment_transactions WHERE voter_record_id = $1)', [voter.recordId]);
      await db.query('DELETE FROM payment_transactions WHERE voter_record_id = $1', [voter.recordId]);
      await db.query('DELETE FROM voters WHERE record_id = $1', [voter.recordId]);
    }
    await addAudit(db, actor, 'Voter removed', 'Voter', voter.voterId, `${voter.fullName}, ${await locationLabel(db, voter)}`);
  });
  res.status(204).end();
});

/** Edits a voter: a Corporator's edit applies to its own team only; the Super Admin edits the shared record. */
votersRouter.put('/voters/:recordId', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  const team = actor.role === 'CORPORATOR' ? actor.id : null;
  const voter = await withTransaction(async (db) => {
    // A team may also bring back a voter it removed ("replace its details" on the voter form).
    const current = await loadVoter(db, str(req.params.recordId), true, team, true);
    if (!ownsWard(actor, current.wardId)) fail(404, 'NOT_FOUND', 'Voter not found.');
    const input = await validateVoterInput(db, await loadLocationRefs(db), req.body ?? {}, current.recordId);
    assertOwnWard(actor, input.wardId);
    const changed = (Object.keys(FIELD_LABELS) as (keyof VoterInput)[]).filter((k) => k !== 'status' && current[k] !== input[k]).map((k) => FIELD_LABELS[k]);
    const statusChange = current.status !== input.status ? `${current.status} → ${input.status}` : '';
    const updated = team ? await saveTeamVoter(db, team, current, input) : await updateVoter(db, current.recordId, input);
    if (changed.length) await addAudit(db, actor, 'Voter updated', 'Voter', input.voterId, `Changed ${changed.join(', ')}`);
    if (statusChange) await addAudit(db, actor, 'Voter status changed', 'Voter', input.voterId, statusChange);
    return updated;
  });
  res.json(voter);
});

