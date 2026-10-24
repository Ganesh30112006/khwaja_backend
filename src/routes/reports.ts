import { Router, type Request } from 'express';
import { Params, pool } from '../db/pool.js';
import { coversSql, type Admin, type Scope } from '../lib/admins.js';
import { addAudit, AUDIT_COLUMNS, type AuditLog } from '../lib/audit.js';
import { fail } from '../lib/errors.js';
import { pageWindow } from '../lib/pagination.js';
import { addDays, sqlLocalDate, today } from '../lib/time.js';
import { formatInr, isValidDate, likePattern, str } from '../lib/validation.js';
import { auth, authenticate, requireSuper } from '../middleware/auth.js';
import { TXN_SELECT, txnFor, type PaymentTransaction } from '../services/payments.js';

export const reportsRouter = Router();

interface Filters {
  from?: string;
  to?: string;
  wardId?: string;
  boothId?: string;
  adminId?: string;
}

function readFilters(q: Request['query']): Filters {
  return {
    from: isValidDate(q.from) ? q.from : undefined,
    to: isValidDate(q.to) ? q.to : undefined,
    wardId: str(q.wardId) || undefined,
    boothId: str(q.boothId) || undefined,
    adminId: str(q.adminId) || undefined,
  };
}

interface GroupRow {
  key: string;
  label: string;
  voters: number;
  active: number;
  notActive: number;
  shifted: number;
  received: number;
  notReceived: number;
  transactions: number;
  amount: number;
}

interface AdminRow {
  adminId: string;
  adminName: string;
  transactions: number;
  amount: number;
  uniqueVoters: number;
}

/** Voters in the admin's area matching the ward/booth filters (alias v). */
function voterWhere(scope: Scope, f: Filters, p: Params): string {
  const where = [coversSql(scope, (v) => p.add(v), 'v.ward_id', 'v.booth_id')];
  if (f.wardId) where.push(`v.ward_id = ${p.add(f.wardId)}`);
  if (f.boothId) where.push(`v.booth_id = ${p.add(f.boothId)}`);
  return where.join(' AND ');
}

/** Successful payments in the date range (and for one admin, Super Admin filter only) (alias t). */
function txWhere(admin: Admin, f: Filters, p: Params): string {
  const where = [`t.status = 'Success'`];
  if (f.from) where.push(`${sqlLocalDate('t."timestamp"')} >= ${p.add(f.from)}::date`);
  if (f.to) where.push(`${sqlLocalDate('t."timestamp"')} <= ${p.add(f.to)}::date`);
  if (f.adminId && admin.role === 'SUPER_ADMIN') where.push(`t.admin_id = ${p.add(f.adminId)}`);
  return where.join(' AND ');
}

/**
 * Voter and payment totals for the admin's area. Only successful payments count; payments are grouped by
 * the voter's current ward/booth so they line up with voter counts, and unique voters are counted
 * separately from payments.
 */
async function buildAggregates(admin: Admin, scope: Scope, f: Filters) {
  const p = new Params();
  const vw = voterWhere(scope, f, p);
  const tw = txWhere(admin, f, p);
  const cells = (await pool.query<{
    wardId: string; boothId: string; voters: number; active: number; notActive: number; shifted: number; received: number; transactions: number; amount: number;
  }>(
    `WITH sv AS (SELECT v.record_id, v.ward_id, v.booth_id, v.status FROM voters v WHERE ${vw}),
          tx AS (SELECT t.voter_record_id, t.amount FROM payment_transactions t JOIN sv ON sv.record_id = t.voter_record_id WHERE ${tw}),
          vt AS (SELECT voter_record_id, count(*) AS n, sum(amount) AS amount FROM tx GROUP BY voter_record_id)
     SELECT sv.ward_id AS "wardId", COALESCE(sv.booth_id, '') AS "boothId", count(*)::int AS voters,
       count(*) FILTER (WHERE sv.status = 'Active')::int AS active,
       count(*) FILTER (WHERE sv.status = 'Not Active')::int AS "notActive",
       count(*) FILTER (WHERE sv.status = 'Shifted')::int AS shifted,
       count(vt.voter_record_id)::int AS received,
       COALESCE(sum(vt.n), 0)::int AS transactions,
       COALESCE(sum(vt.amount), 0)::int AS amount
     FROM sv LEFT JOIN vt ON vt.voter_record_id = sv.record_id
     GROUP BY sv.ward_id, sv.booth_id`,
    p.values,
  )).rows;

  const wards = (await pool.query<{ id: string; number: number }>('SELECT id, number FROM wards')).rows;
  const booths = (await pool.query<{ id: string; number: number }>('SELECT id, number FROM booths')).rows;
  const wardNo = new Map(wards.map((w) => [w.id, w.number]));
  const boothNo = new Map(booths.map((b) => [b.id, b.number]));
  const empty = (key: string, label: string): GroupRow => ({ key, label, voters: 0, active: 0, notActive: 0, shifted: 0, received: 0, notReceived: 0, transactions: 0, amount: 0 });
  const byWardMap = new Map<string, GroupRow>();
  const byBoothMap = new Map<string, GroupRow>();
  // Assigned/selected wards with no voters still appear, so charts show them.
  if (!f.boothId) {
    for (const w of wards) {
      const inScope = admin.role === 'SUPER_ADMIN' ? !f.wardId || f.wardId === w.id : admin.wardIds.includes(w.id) && (!f.wardId || f.wardId === w.id);
      if (inScope) byWardMap.set(w.id, empty(w.id, `Ward ${w.number}`));
    }
  }
  for (const c of cells) {
    const w = byWardMap.get(c.wardId) ?? empty(c.wardId, `Ward ${wardNo.get(c.wardId) ?? 0}`);
    const b = byBoothMap.get(c.boothId) ?? empty(c.boothId, c.boothId ? `Booth ${boothNo.get(c.boothId) ?? 0}` : 'No booth');
    for (const r of [w, b]) {
      r.voters += c.voters;
      r.active += c.active;
      r.notActive += c.notActive;
      r.shifted += c.shifted;
      r.received += c.received;
      r.notReceived += c.voters - c.received;
      r.transactions += c.transactions;
      r.amount += c.amount;
    }
    byWardMap.set(c.wardId, w);
    byBoothMap.set(c.boothId, b);
  }
  const byWard = [...byWardMap.values()].sort((a, b) => (wardNo.get(a.key) ?? 0) - (wardNo.get(b.key) ?? 0));
  const byBooth = [...byBoothMap.values()].sort((a, b) => (boothNo.get(a.key) ?? 0) - (boothNo.get(b.key) ?? 0));

  const q2 = new Params();
  const scopedTx = `FROM payment_transactions t JOIN voters v ON v.record_id = t.voter_record_id WHERE ${voterWhere(scope, f, q2)} AND ${txWhere(admin, f, q2)}`;
  const byAdmin = (await pool.query<AdminRow>(
    `SELECT t.admin_id AS "adminId", (array_agg(t.admin_name ORDER BY t."timestamp" DESC))[1] AS "adminName",
       count(*)::int AS transactions, sum(t.amount)::int AS amount, count(DISTINCT t.voter_record_id)::int AS "uniqueVoters"
     ${scopedTx} GROUP BY t.admin_id ORDER BY sum(t.amount) DESC, t.admin_id`,
    q2.values,
  )).rows;
  const daily = (await pool.query<{ date: string; transactions: number; uniqueVoters: number; amount: number }>(
    `SELECT to_char(${sqlLocalDate('t."timestamp"')}, 'YYYY-MM-DD') AS date, count(*)::int AS transactions,
       count(DISTINCT t.voter_record_id)::int AS "uniqueVoters", sum(t.amount)::int AS amount
     ${scopedTx} GROUP BY 1 ORDER BY 1 DESC`,
    q2.values,
  )).rows;

  const sum = (k: keyof GroupRow) => byBooth.reduce((s, r) => s + (r[k] as number), 0);
  const totals = {
    totalVoters: sum('voters'),
    active: sum('active'),
    notActive: sum('notActive'),
    shifted: sum('shifted'),
    received: sum('received'),
    transactions: sum('transactions'),
    amount: sum('amount'),
  };
  return { byWard, byBooth, byAdmin, daily, totals };
}

reportsRouter.get('/reports/dashboard', authenticate, async (req, res) => {
  const { admin, scope } = auth(req);
  const isSuper = admin.role === 'SUPER_ADMIN';
  const f = readFilters(req.query);
  const { byWard, byBooth, byAdmin, daily, totals } = await buildAggregates(admin, scope, f);

  const end = f.to ?? today();
  const start = f.from ?? addDays(end, -29);
  const perDay = new Map(daily.map((d) => [d.date, d]));
  const overTime: { date: string; amount: number; transactions: number }[] = [];
  for (let d = start, i = 0; d <= end && i < 366; d = addDays(d, 1), i++) {
    const e = perDay.get(d);
    overTime.push({ date: d, amount: e?.amount ?? 0, transactions: e?.transactions ?? 0 });
  }

  // Everything this admin recorded, including payments that are now outside the filters.
  const pm = new Params();
  const mineWhere = [`t.status = 'Success'`, `t.admin_id = ${pm.add(admin.id)}`];
  if (f.from) mineWhere.push(`${sqlLocalDate('t."timestamp"')} >= ${pm.add(f.from)}::date`);
  if (f.to) mineWhere.push(`${sqlLocalDate('t."timestamp"')} <= ${pm.add(f.to)}::date`);
  const mine = (await pool.query<{ n: number; amount: number }>(`SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::int AS amount FROM payment_transactions t WHERE ${mineWhere.join(' AND ')}`, pm.values)).rows[0];

  const pr = new Params();
  const recentWhere = [isSuper ? 'TRUE' : `(t.admin_id = ${pr.add(admin.id)} OR ${coversSql(scope, (v) => pr.add(v), 't.ward_id', 't.booth_id')})`];
  if (f.from) recentWhere.push(`${sqlLocalDate('t."timestamp"')} >= ${pr.add(f.from)}::date`);
  if (f.to) recentWhere.push(`${sqlLocalDate('t."timestamp"')} <= ${pr.add(f.to)}::date`);
  if (f.wardId) recentWhere.push(`t.ward_id = ${pr.add(f.wardId)}`);
  if (f.boothId) recentWhere.push(`t.booth_id = ${pr.add(f.boothId)}`);
  const recentTransactions = (await pool.query<PaymentTransaction>(`${TXN_SELECT} WHERE ${recentWhere.join(' AND ')} ORDER BY t."timestamp" DESC, t.id DESC LIMIT 8`, pr.values)).rows.map(txnFor(scope));
  const recentActivity = (await pool.query<AuditLog>(
    `SELECT ${AUDIT_COLUMNS} FROM audit_logs WHERE entity <> 'Auth' ${isSuper ? '' : 'AND admin_id = $1'} ORDER BY "timestamp" DESC, seq DESC LIMIT 8`,
    isSuper ? [] : [admin.id],
  )).rows;

  const counts = (await pool.query<{ corporators: number; blos: number; myBlos: number; booths: number }>(
    `SELECT (SELECT count(*) FROM admins WHERE role = 'CORPORATOR')::int AS corporators,
            (SELECT count(*) FROM admins WHERE role = 'BLO')::int AS blos,
            (SELECT count(*) FROM admins WHERE role = 'BLO' AND corporator_id = $1)::int AS "myBlos",
            (SELECT count(*) FROM booths WHERE ($2::text IS NULL OR ward_id = $2) AND ($3::text IS NULL OR id = $3))::int AS booths`,
    [admin.id, f.wardId ?? null, f.boothId ?? null],
  )).rows[0];

  res.json({
    totalCorporators: isSuper ? counts.corporators : null,
    totalBlos: isSuper ? counts.blos : admin.role === 'CORPORATOR' ? counts.myBlos : null,
    totalVoters: totals.totalVoters,
    totalWards: byWard.length,
    totalBooths: isSuper ? counts.booths : byBooth.length,
    activeVoters: totals.active,
    notActiveVoters: totals.notActive,
    shiftedVoters: totals.shifted,
    votersReceived: totals.received,
    votersNotReceived: totals.totalVoters - totals.received,
    totalTransactions: totals.transactions,
    totalAmount: totals.amount,
    myTransactions: mine.n,
    myAmount: mine.amount,
    byWard,
    byBooth,
    byAdmin: isSuper ? byAdmin.map(({ uniqueVoters: _u, ...r }) => r) : [],
    overTime,
    recentTransactions,
    recentActivity,
  });
});

reportsRouter.get('/reports', authenticate, async (req, res) => {
  const { admin, scope } = auth(req);
  const { byWard, byBooth, byAdmin, daily, totals } = await buildAggregates(admin, scope, readFilters(req.query));
  // Monthly unique voters need their own distinct count (a voter can appear on several days in a month).
  const f = readFilters(req.query);
  const p = new Params();
  const monthly = (await pool.query<{ month: string; transactions: number; uniqueVoters: number; amount: number }>(
    `SELECT to_char(${sqlLocalDate('t."timestamp"')}, 'YYYY-MM') AS month, count(*)::int AS transactions,
       count(DISTINCT t.voter_record_id)::int AS "uniqueVoters", sum(t.amount)::int AS amount
     FROM payment_transactions t JOIN voters v ON v.record_id = t.voter_record_id
     WHERE ${voterWhere(scope, f, p)} AND ${txWhere(admin, f, p)} GROUP BY 1 ORDER BY 1 DESC`,
    p.values,
  )).rows;
  res.json({
    summary: {
      totalVoters: totals.totalVoters,
      active: totals.active,
      notActive: totals.notActive,
      shifted: totals.shifted,
      votersReceived: totals.received,
      votersNotReceived: totals.totalVoters - totals.received,
      transactions: totals.transactions,
      amount: totals.amount,
    },
    byWard,
    byBooth,
    // Super Admin: everyone. Corporator: itself and its BLOs. BLO: itself.
    byAdmin: byAdmin.filter((a) => admin.role === 'SUPER_ADMIN' || a.adminId === admin.id || (admin.role === 'CORPORATOR' && a.adminId.startsWith(`${admin.id}-BLO`))),
    daily,
    monthly,
  });
});

/** Exports are built in the browser; this only records them in the audit log. */
reportsRouter.post('/reports/exports', authenticate, async (req, res) => {
  const { admin } = auth(req);
  const name = str(req.body?.name).trim().slice(0, 100);
  const format = req.body?.format;
  if (!name || (format !== 'CSV' && format !== 'Excel')) fail(400, 'VALIDATION', 'Invalid export.');
  await addAudit(pool, admin, 'Report exported', 'Export', name, `${name} exported as ${format}`);
  res.status(204).end();
});

reportsRouter.get('/notifications', authenticate, async (req, res) => {
  const { admin, scope } = auth(req);
  if (admin.role === 'SUPER_ADMIN') {
    const { rows } = await pool.query<AuditLog>(
      `SELECT ${AUDIT_COLUMNS} FROM audit_logs WHERE admin_id <> $1 AND action <> 'Logged in' ORDER BY "timestamp" DESC, seq DESC LIMIT 10`,
      [admin.id],
    );
    res.json(rows.map((a) => ({ id: a.id, title: `${a.action} · ${a.adminId}`, body: a.summary, timestamp: a.timestamp })));
    return;
  }
  const p = new Params();
  const txs = (await pool.query<PaymentTransaction>(
    `${TXN_SELECT} WHERE t.admin_id <> ${p.add(admin.id)} AND ${coversSql(scope, (v) => p.add(v), 't.ward_id', 't.booth_id')} ORDER BY t."timestamp" DESC LIMIT 10`,
    p.values,
  )).rows.map(txnFor(scope));
  const settings = (await pool.query<AuditLog>(`SELECT ${AUDIT_COLUMNS} FROM audit_logs WHERE entity = 'Settings' ORDER BY "timestamp" DESC, seq DESC LIMIT 10`)).rows;
  const items = [
    ...txs.map((t) => ({
      id: t.id,
      title: t.status !== 'Success' ? `Payment ${t.status.toLowerCase()}` : t.adminId ? `Payment recorded by ${t.adminId}` : 'Payment recorded',
      body: `${t.voterName} (${t.voterId}) · ${formatInr(t.amount)}`,
      timestamp: t.timestamp,
    })),
    // Field accounts only learn that the payment details changed, not who changed them.
    ...settings.map((a) => ({ id: a.id, title: 'Payment details', body: 'Successfully updated', timestamp: a.timestamp })),
  ];
  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  res.json(items.slice(0, 10));
});

/** Read-only for everyone; only the Super Admin can view it. */
reportsRouter.get('/audit-logs', authenticate, requireSuper, async (req, res) => {
  const q = req.query;
  const p = new Params();
  const where: string[] = [];
  if (str(q.entity)) where.push(`entity = ${p.add(str(q.entity))}`);
  if (str(q.adminId)) where.push(`admin_id = ${p.add(str(q.adminId))}`);
  if (str(q.recordRef)) where.push(`record_ref = ${p.add(str(q.recordRef))}`);
  if (isValidDate(q.from)) where.push(`${sqlLocalDate('"timestamp"')} >= ${p.add(q.from)}::date`);
  if (isValidDate(q.to)) where.push(`${sqlLocalDate('"timestamp"')} <= ${p.add(q.to)}::date`);
  const search = str(q.search).trim();
  if (search) {
    const s = p.add(likePattern(search));
    where.push(`(action ILIKE ${s} OR record_ref ILIKE ${s} OR summary ILIKE ${s} OR admin_id ILIKE ${s} OR admin_name ILIKE ${s})`);
  }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await pool.query<{ n: number }>(`SELECT count(*) AS n FROM audit_logs ${filter}`, p.values)).rows[0].n;
  const win = pageWindow(total, q.page, q.pageSize);
  const { rows } = await pool.query<AuditLog>(`SELECT ${AUDIT_COLUMNS} FROM audit_logs ${filter} ORDER BY "timestamp" DESC, seq DESC LIMIT ${win.pageSize} OFFSET ${win.offset}`, p.values);
  res.json({ items: rows, total, page: win.page, pageSize: win.pageSize });
});
