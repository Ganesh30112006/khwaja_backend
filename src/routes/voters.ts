import { Router, type Request } from 'express';
import { isUniqueViolation, Params, pool, withTransaction, type Db } from '../db/pool.js';
import { covers, coversSql, type Scope } from '../lib/admins.js';
import { fail } from '../lib/errors.js';
import { addAudit } from '../lib/audit.js';
import { pageWindow } from '../lib/pagination.js';
import { likePattern, str } from '../lib/validation.js';
import { auth, authenticate, requireSuper } from '../middleware/auth.js';
import { cleanTxn, TXN_SELECT, type PaymentTransaction } from '../services/payments.js';
import {
  insertVoter,
  loadLocationRefs,
  loadVoter,
  toListItems,
  validateVoterInput,
  VOTER_COLUMNS,
  voterIdConflict,
  type Voter,
  type VoterInput,
} from '../services/voters.js';

export const votersRouter = Router();

const FROM = 'FROM voters v JOIN wards w ON w.id = v.ward_id JOIN booths b ON b.id = v.booth_id';

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
    const digits = search.replace(/\D/g, '');
    if (digits.length >= 3) parts.push(`v.mobile LIKE ${p.add(likePattern(digits))}`);
    where.push(`(${parts.join(' OR ')})`);
  }
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

function voterOrder(q: Request['query']): string {
  const dir = q.sortDir === 'desc' ? 'DESC' : 'ASC';
  const text = (col: string) => `lower(${col}) COLLATE natural_sort ${dir}`;
  const keys: Record<string, string> = {
    ward: `w.number ${dir}, b.number ${dir}`,
    booth: `b.number ${dir}`,
    voterId: text('v.voter_id'),
    fullName: text('v.full_name'),
    houseNumber: text('v.house_number'),
    status: text('v.status'),
  };
  return `ORDER BY ${keys[str(q.sortBy)] ?? keys.ward}, v.record_id`;
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

votersRouter.get('/voters/export', authenticate, requireSuper, async (req, res) => {
  const { admin, scope } = auth(req);
  const p = new Params();
  const voters = (await pool.query<Voter>(`SELECT ${VOTER_COLUMNS} ${FROM} ${voterFilter(req.query, scope, p)} ${voterOrder(req.query)}`, p.values)).rows;
  const items = await toListItems(pool, scope, voters);
  await addAudit(pool, admin, 'Voters exported', 'Export', 'voters', `${items.length} voter records`);
  res.json(items);
});

votersRouter.get('/voters/duplicate-check', authenticate, requireSuper, async (req, res) => {
  const voterId = str(req.query.voterId).trim();
  const fullName = str(req.query.fullName).trim();
  const houseNumber = str(req.query.houseNumber).trim();
  const exclude = str(req.query.excludeRecordId);
  const voterIdExists = !!voterId && !!(await pool.query('SELECT 1 FROM voters WHERE upper(voter_id) = upper($1) AND record_id <> $2', [voterId, exclude])).rowCount;
  const similar =
    fullName && houseNumber
      ? (await pool.query(
          `SELECT record_id AS "recordId", voter_id AS "voterId", full_name AS "fullName", house_number AS "houseNumber"
           FROM voters WHERE ward_id = $1 AND lower(full_name) = lower($2) AND lower(house_number) = lower($3) AND record_id <> $4
           ORDER BY record_id LIMIT 5`,
          [str(req.query.wardId), fullName, houseNumber, exclude],
        )).rows
      : [];
  res.json({ voterIdExists, similar });
});

votersRouter.get('/voters/:recordId', authenticate, async (req, res) => {
  const { scope } = auth(req);
  const voter = await loadVoter(pool, str(req.params.recordId));
  if (!covers(scope, voter)) fail(404, 'NOT_FOUND', 'Voter not found.');
  const [item] = await toListItems(pool, scope, [voter]);
  const transactions = (await pool.query<PaymentTransaction>(`${TXN_SELECT} WHERE t.voter_record_id = $1 ORDER BY t."timestamp" DESC, t.id DESC`, [voter.recordId])).rows;
  res.json({ voter: item, transactions: transactions.map(cleanTxn) });
});

async function locationLabel(db: Db, v: { wardId: string; boothId: string }): Promise<string> {
  const { rows } = await db.query<{ ward: number; booth: number }>(
    'SELECT w.number AS ward, b.number AS booth FROM booths b JOIN wards w ON w.id = b.ward_id WHERE b.id = $1',
    [v.boothId],
  );
  return `ward ${rows[0]?.ward ?? 0}, booth ${rows[0]?.booth ?? 0}`;
}

votersRouter.post('/voters', authenticate, requireSuper, async (req, res) => {
  const actor = auth(req).admin;
  const voter = await withTransaction(async (db) => {
    const input = await validateVoterInput(db, await loadLocationRefs(db), req.body ?? {});
    const created = await insertVoter(db, input);
    await addAudit(db, actor, 'Voter created', 'Voter', created.voterId, `${created.fullName}, ${await locationLabel(db, created)}, ${created.status}`);
    return created;
  });
  res.status(201).json(voter);
});

const FIELD_LABELS: Record<keyof VoterInput, string> = {
  voterId: 'Voter ID',
  fullName: 'name',
  mobile: 'mobile',
  wardId: 'ward',
  boothId: 'booth',
  houseNumber: 'house number',
  householdId: 'household ID',
  address: 'address',
  status: 'status',
};

votersRouter.put('/voters/:recordId', authenticate, requireSuper, async (req, res) => {
  const actor = auth(req).admin;
  const voter = await withTransaction(async (db) => {
    const current = await loadVoter(db, str(req.params.recordId), true);
    const input = await validateVoterInput(db, await loadLocationRefs(db), req.body ?? {}, current.recordId);
    const changed = (Object.keys(FIELD_LABELS) as (keyof VoterInput)[]).filter((k) => k !== 'status' && current[k] !== input[k]).map((k) => FIELD_LABELS[k]);
    const statusChange = current.status !== input.status ? `${current.status} → ${input.status}` : '';
    const { rows } = await db
      .query<Voter>(
        `UPDATE voters v SET voter_id = $2, full_name = $3, mobile = $4, ward_id = $5, booth_id = $6, house_number = $7, household_id = $8,
           address = $9, status = $10, updated_at = now()
         WHERE record_id = $1 RETURNING ${VOTER_COLUMNS}`,
        [current.recordId, input.voterId, input.fullName, input.mobile, input.wardId, input.boothId, input.houseNumber, input.householdId, input.address, input.status],
      )
      .catch((err) => {
        if (isUniqueViolation(err, 'voters_voter_id_ci_idx')) throw voterIdConflict();
        throw err;
      });
    if (changed.length) await addAudit(db, actor, 'Voter updated', 'Voter', input.voterId, `Changed ${changed.join(', ')}`);
    if (statusChange) await addAudit(db, actor, 'Voter status changed', 'Voter', input.voterId, statusChange);
    return rows[0];
  });
  res.json(voter);
});

