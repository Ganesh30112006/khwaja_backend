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
  insertVoter,
  loadLocationRefs,
  loadVoter,
  toListItems,
  updateVoter,
  validateVoterInput,
  VOTER_COLUMNS,
  type Voter,
  type VoterInput,
} from '../services/voters.js';

export const votersRouter = Router();

const FROM = 'FROM voters v JOIN wards w ON w.id = v.ward_id LEFT JOIN booths b ON b.id = v.booth_id';

/** WHERE clause for the voter list: always the admin's own area, plus the filters (ward, booth, status, payment status, search). */
function voterFilter(q: Request['query'], scope: Scope, p: Params): string {
  const where: string[] = [];
  // Corporators and BLOs only ever see voters in their own area.
  if (!scope.all) where.push(coversSql(scope, (v) => p.add(v), 'v.ward_id', 'v.booth_id'));
  if (str(q.wardId)) where.push(`v.ward_id = ${p.add(str(q.wardId))}`);
  if (str(q.boothId)) where.push(`v.booth_id = ${p.add(str(q.boothId))}`);
  if (str(q.status)) where.push(`v.status = ${p.add(str(q.status))}`);
  const received = `EXISTS (SELECT 1 FROM payment_transactions t WHERE t.voter_record_id = v.record_id AND t.status = 'Success')`;
  if (q.paymentStatus === 'Received') where.push(received);
  else if (q.paymentStatus === 'Not Received') where.push(`NOT ${received}`);
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
  const { scope } = auth(req);
  const p = new Params();
  const filter = voterFilter(req.query, scope, p);
  const total = (await pool.query<{ n: number }>(`SELECT count(*) AS n ${FROM} ${filter}`, p.values)).rows[0].n;
  const win = pageWindow(total, req.query.page, req.query.pageSize);
  const voters = (await pool.query<Voter>(`SELECT ${VOTER_COLUMNS} ${FROM} ${filter} ${voterOrder(req.query)} LIMIT ${win.pageSize} OFFSET ${win.offset}`, p.values)).rows;
  res.json({ items: await toListItems(pool, scope, voters), total, page: win.page, pageSize: win.pageSize });
});

const MAX_STATUS_IDS = 1000;

/**
 * Sets the status of many voters at once by Voter ID, e.g. from a list of deceased (Not Active) or shifted
 * voters. Voter IDs are matched ignoring case; unknown IDs are reported back, not created.
 */
votersRouter.post('/voters/status', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  const status = req.body?.status as VoterStatus;
  if (!VOTER_STATUSES.includes(status)) fail(400, 'VALIDATION', 'Select a voter status.', { status: 'Select a voter status' });
  const ids = [...new Set(strArray(req.body?.voterIds).map((id) => id.trim().toUpperCase()).filter(Boolean))];
  if (!ids.length) fail(400, 'VALIDATION', 'No voter IDs were sent.');
  if (ids.length > MAX_STATUS_IDS) fail(400, 'VALIDATION', `Send at most ${MAX_STATUS_IDS} voter IDs per request.`);
  const fileName = str(req.body?.fileName).trim().slice(0, 255) || 'status list';
  const result = await withTransaction(async (db) => {
    const rows = (await db.query<{ voterId: string; status: VoterStatus; wardId: string }>(
      'SELECT upper(voter_id) AS "voterId", status, ward_id AS "wardId" FROM voters WHERE upper(voter_id) = ANY($1) FOR UPDATE',
      [ids],
    )).rows;
    // A Corporator only changes voters in its own wards; the others are reported back.
    const found = rows.filter((v) => ownsWard(actor, v.wardId));
    const outsideArea = rows.filter((v) => !ownsWard(actor, v.wardId)).map((v) => v.voterId);
    const toChange = found.filter((v) => v.status !== status).map((v) => v.voterId);
    if (toChange.length) {
      await db.query('UPDATE voters SET status = $2, updated_at = now() WHERE upper(voter_id) = ANY($1)', [toChange, status]);
      await addAudit(db, actor, 'Voter status changed', 'Voter', fileName, `${toChange.length} voters → ${status} (from ${fileName})`);
    }
    const foundIds = new Set(rows.map((v) => v.voterId));
    return { updated: toChange.length, unchanged: found.length - toChange.length, notFound: ids.filter((id) => !foundIds.has(id)), outsideArea };
  });
  res.json(result);
});

votersRouter.get('/voters/export', authenticate, requireWardManager, async (req, res) => {
  const { admin, scope } = auth(req);
  const p = new Params();
  const voters = (await pool.query<Voter>(`SELECT ${VOTER_COLUMNS} ${FROM} ${voterFilter(req.query, scope, p)} ${voterOrder(req.query)}`, p.values)).rows;
  const items = await toListItems(pool, scope, voters);
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
  const voterIdExists = !!match;
  // Lets the form offer "keep the existing voter" or "replace its details" (only inside the caller's wards).
  const existing = match ? { ...match, canReplace: ownsWard(auth(req).admin, match.wardId) } : null;
  const similar =
    fullName && houseNumber
      ? (await pool.query(
          `SELECT record_id AS "recordId", voter_id AS "voterId", full_name AS "fullName", house_number AS "houseNumber"
           FROM voters WHERE ward_id = $1 AND lower(full_name) = lower($2) AND lower(house_number) = lower($3) AND record_id <> $4
           ORDER BY record_id LIMIT 5`,
          [str(req.query.wardId), fullName, houseNumber, exclude],
        )).rows
      : [];
  res.json({ voterIdExists, existing, similar });
});

votersRouter.get('/voters/:recordId', authenticate, async (req, res) => {
  const { scope } = auth(req);
  const voter = await loadVoter(pool, str(req.params.recordId));
  if (!covers(scope, voter)) fail(404, 'NOT_FOUND', 'Voter not found.');
  const [item] = await toListItems(pool, scope, [voter]);
  const transactions = (await pool.query<PaymentTransaction>(`${TXN_SELECT} WHERE t.voter_record_id = $1 ORDER BY t."timestamp" DESC, t.id DESC`, [voter.recordId])).rows;
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

votersRouter.put('/voters/:recordId', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  const voter = await withTransaction(async (db) => {
    const current = await loadVoter(db, str(req.params.recordId), true);
    if (!ownsWard(actor, current.wardId)) fail(404, 'NOT_FOUND', 'Voter not found.');
    const input = await validateVoterInput(db, await loadLocationRefs(db), req.body ?? {}, current.recordId);
    assertOwnWard(actor, input.wardId);
    const changed = (Object.keys(FIELD_LABELS) as (keyof VoterInput)[]).filter((k) => k !== 'status' && current[k] !== input[k]).map((k) => FIELD_LABELS[k]);
    const statusChange = current.status !== input.status ? `${current.status} → ${input.status}` : '';
    const updated = await updateVoter(db, current.recordId, input);
    if (changed.length) await addAudit(db, actor, 'Voter updated', 'Voter', input.voterId, `Changed ${changed.join(', ')}`);
    if (statusChange) await addAudit(db, actor, 'Voter status changed', 'Voter', input.voterId, statusChange);
    return updated;
  });
  res.json(voter);
});

