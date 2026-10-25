import { Router, type Request } from 'express';
import { isUniqueViolation, Params, pool, withTransaction, type Db } from '../db/pool.js';
import { covers, coversSql, type Admin, type Scope } from '../lib/admins.js';
import { addAudit, AUDIT_COLUMNS, type AuditLog } from '../lib/audit.js';
import { fail, failIfErrors } from '../lib/errors.js';
import { nextNumber } from '../lib/ids.js';
import { pageWindow } from '../lib/pagination.js';
import { sqlLocalDate } from '../lib/time.js';
import { formatInr, isValidAmount, isValidDate, isValidIndianMobile, likePattern, normalizeMobile, pad, str } from '../lib/validation.js';
import { auth, authenticate, requireWardManager } from '../middleware/auth.js';
import { cleanTxn, currentAmount, hideSuperAdmin, loadSettings, TXN_COLUMNS, TXN_SELECT, txnFor, type PaymentTransaction } from '../services/payments.js';
import { loadVoter } from '../services/voters.js';
import { bloCashSummary } from './cash.js';

export const paymentsRouter = Router();
paymentsRouter.use('/payments', authenticate);

/**
 * The amount to pay: a ward's own amount (set by its Corporator or a Super Admin) when it has one,
 * otherwise the overall amount from payment settings. Lists the own amounts of wards in the caller's area.
 */
async function paymentContext(db: Db, admin: Admin, wardId = '') {
  const settings = await loadSettings(db);
  const defaultAmount = await currentAmount(db, settings);
  const wardAmounts = (await db.query<{ wardId: string; amount: number }>(
    'SELECT id AS "wardId", payment_amount AS amount FROM wards WHERE payment_amount IS NOT NULL ORDER BY number',
  )).rows.filter((w) => admin.role === 'SUPER_ADMIN' || admin.wardIds.includes(w.wardId));
  const suggestedAmount = wardAmounts.find((w) => w.wardId === wardId)?.amount ?? defaultAmount;
  // A BLO pays out of the cash its Corporator gave it.
  const cashLeft = admin.role === 'BLO' ? (await bloCashSummary(db, admin.id)).left : null;
  return { suggestedAmount, amountEditable: settings.allowAmountOverride, defaultAmount, wardAmounts, cashLeft };
}

paymentsRouter.get('/payments/context', async (req, res) => {
  res.json(await paymentContext(pool, auth(req).admin, str(req.query.wardId)));
});

async function findReplay(db: Db, adminId: string, key: string): Promise<PaymentTransaction | undefined> {
  if (!key) return undefined;
  const { rows } = await db.query<PaymentTransaction>(`${TXN_SELECT} JOIN idempotency_keys k ON k.txn_id = t.id WHERE k.admin_id = $1 AND k.key = $2`, [adminId, key]);
  return rows[0] && cleanTxn(rows[0]);
}

/**
 * Records a cash payment. One successful payment per voter (also enforced by a unique index);
 * the receiver may be anyone, including one person receiving for a whole household.
 * A retried request with the same idempotency key returns the original payment.
 */
paymentsRouter.post('/payments', async (req, res) => {
  const { admin, scope } = auth(req);
  const body = req.body ?? {};
  const key = (str(req.get('Idempotency-Key')) || str(body.idempotencyKey)).slice(0, 100);
  const result = await withTransaction(async (db) => {
    const early = await findReplay(db, admin.id, key);
    if (early) return { tx: early, replay: true };
    // Locking the voter serialises concurrent payments for the same voter.
    const voter = await loadVoter(db, str(body.voterRecordId), true);
    const replay = await findReplay(db, admin.id, key);
    if (replay) return { tx: replay, replay: true };
    if (!covers(scope, voter)) fail(403, 'FORBIDDEN', 'This voter is outside your assigned area.');
    // Only Active voters are paid (Shifted and Not Active, e.g. deceased, are not).
    if (voter.status !== 'Active') fail(409, 'CONFLICT', `This voter is ${voter.status} and cannot receive a payment.`);

    const errors: Record<string, string> = {};
    const amount = Number(body.amount);
    const receiverName = str(body.receiverName).trim();
    const receiverMobile = str(body.receiverMobile).trim();
    const givenByName = str(body.givenByName).trim().replace(/\s+/g, ' ');
    if (!isValidAmount(amount)) errors.amount = 'Enter a whole amount between ₹1 and ₹1,00,000';
    if (receiverName.length < 2) errors.receiverName = 'Receiver name is required';
    else if (receiverName.length > 100) errors.receiverName = 'Receiver name is too long';
    if (!isValidIndianMobile(receiverMobile)) errors.receiverMobile = 'Enter a valid 10-digit Indian mobile number';
    if (givenByName.length < 2) errors.givenByName = 'Enter the name of the person giving the money';
    else if (givenByName.length > 100) errors.givenByName = 'Name is too long';
    const ctx = await paymentContext(db, admin, voter.wardId);
    if (!errors.amount && !ctx.amountEditable && amount !== ctx.suggestedAmount) errors.amount = `Amount must be ${formatInr(ctx.suggestedAmount)}`;
    failIfErrors(errors);

    const existing = (await db.query<{ amount: number; receiverName: string }>(
      `SELECT amount, receiver_name AS "receiverName" FROM payment_transactions WHERE voter_record_id = $1 AND status = 'Success'`,
      [voter.recordId],
    )).rows[0];
    if (existing) fail(409, 'CONFLICT', `This voter has already received a payment (${formatInr(existing.amount)} to ${existing.receiverName}).`);

    const id = `TXN-${pad(await nextNumber(db, 'txn'), 6)}`;
    const { rows } = await db
      .query<PaymentTransaction>(
        `INSERT INTO payment_transactions AS t (id, voter_record_id, voter_id, voter_name, ward_id, booth_id, amount, receiver_name, receiver_mobile, "timestamp", admin_id, admin_name, given_by_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12, 'Success')
         RETURNING ${TXN_COLUMNS}`,
        [id, voter.recordId, voter.voterId, voter.fullName, voter.wardId, voter.boothId || null, amount, receiverName, normalizeMobile(receiverMobile), admin.id, admin.fullName, givenByName],
      )
      .catch((err) => {
        if (isUniqueViolation(err, 'payment_one_success_per_voter_idx')) fail(409, 'CONFLICT', 'This voter has already received a payment.');
        throw err;
      });
    if (key) await db.query('INSERT INTO idempotency_keys (admin_id, key, txn_id) VALUES ($1, $2, $3)', [admin.id, key, id]);
    await addAudit(db, admin, 'Payment recorded', 'Payment', id, `${formatInr(amount)} to ${receiverName} for voter ${voter.voterId}`);
    return { tx: cleanTxn(rows[0]), replay: false };
  });
  res.status(result.replay ? 200 : 201).json(result.tx);
});

/** WHERE clause for payment history: the admin's area (where the voter was when paid) plus filters. */
function paymentFilter(q: Request['query'], admin: Admin, scope: Scope, p: Params): string {
  const where: string[] = [];
  if (!scope.all) where.push(coversSql(scope, (v) => p.add(v), 't.ward_id', 't.booth_id'));
  if (isValidDate(q.from)) where.push(`${sqlLocalDate('t."timestamp"')} >= ${p.add(q.from)}::date`);
  if (isValidDate(q.to)) where.push(`${sqlLocalDate('t."timestamp"')} <= ${p.add(q.to)}::date`);
  if (str(q.wardId)) where.push(`t.ward_id = ${p.add(str(q.wardId))}`);
  if (str(q.boothId)) where.push(`t.booth_id = ${p.add(str(q.boothId))}`);
  // "Given by" filter: a Super Admin may pick anyone, a Corporator only itself or its own BLOs.
  if (str(q.adminId) && admin.role === 'SUPER_ADMIN') where.push(`t.admin_id = ${p.add(str(q.adminId))}`);
  if (str(q.adminId) && admin.role === 'CORPORATOR') {
    const me = p.add(admin.id);
    where.push(`t.admin_id = ${p.add(str(q.adminId))}`, `t.admin_id IN (SELECT id FROM admins WHERE id = ${me} OR corporator_id = ${me})`);
  }
  if (str(q.status)) where.push(`t.status = ${p.add(str(q.status))}`);
  const search = str(q.search).trim();
  if (search) {
    const s = p.add(likePattern(search));
    where.push(`(t.voter_name ILIKE ${s} OR t.voter_id ILIKE ${s} OR t.receiver_name ILIKE ${s} OR t.receiver_mobile LIKE ${s})`);
  }
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

function paymentOrder(q: Request['query']): string {
  const by = str(q.sortBy) || 'timestamp';
  const dirRaw = q.sortDir === 'asc' || q.sortDir === 'desc' ? q.sortDir : by === 'timestamp' ? 'desc' : 'asc';
  const dir = dirRaw === 'desc' ? 'DESC' : 'ASC';
  const keys: Record<string, string> = {
    timestamp: 't."timestamp"',
    amount: 't.amount',
    voterName: 't.voter_name COLLATE natural_sort',
    receiverName: 't.receiver_name COLLATE natural_sort',
  };
  return `ORDER BY ${keys[by] ?? keys.timestamp} ${dir}, t."timestamp" DESC, t.id DESC`;
}

paymentsRouter.get('/payments', async (req, res) => {
  const { admin, scope } = auth(req);
  const p = new Params();
  const filter = paymentFilter(req.query, admin, scope, p);
  const total = (await pool.query<{ n: number }>(`SELECT count(*) AS n FROM payment_transactions t ${filter}`, p.values)).rows[0].n;
  const win = pageWindow(total, req.query.page, req.query.pageSize);
  const { rows } = await pool.query<PaymentTransaction>(`${TXN_SELECT} ${filter} ${paymentOrder(req.query)} LIMIT ${win.pageSize} OFFSET ${win.offset}`, p.values);
  res.json({ items: rows.map(txnFor(scope)), total, page: win.page, pageSize: win.pageSize });
});

paymentsRouter.get('/payments/export', async (req, res) => {
  const { admin, scope } = auth(req);
  const p = new Params();
  const { rows } = await pool.query<PaymentTransaction>(`${TXN_SELECT} ${paymentFilter(req.query, admin, scope, p)} ${paymentOrder(req.query)}`, p.values);
  await addAudit(pool, admin, 'Payments exported', 'Export', 'payments', `${rows.length} payments`);
  res.json(rows.map(txnFor(scope)));
});

async function loadVisiblePayment(db: Db, scope: Scope, id: string, lock = false): Promise<PaymentTransaction> {
  const { rows } = await db.query<PaymentTransaction>(`${TXN_SELECT} WHERE t.id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  const tx = rows[0];
  if (!tx || !covers(scope, tx)) fail(404, 'NOT_FOUND', 'Payment not found.');
  return cleanTxn(tx);
}

paymentsRouter.get('/payments/:id', async (req, res) => {
  const { scope } = auth(req);
  const transaction = await loadVisiblePayment(pool, scope, str(req.params.id));
  const audit = (await pool.query<AuditLog>(`SELECT ${AUDIT_COLUMNS} FROM audit_logs WHERE record_ref = $1 ORDER BY "timestamp" DESC, seq DESC`, [transaction.id])).rows;
  res.json({ transaction: hideSuperAdmin(scope, transaction), audit: audit.map((a) => hideSuperAdmin(scope, a)) });
});

/**
 * The Super Admin, or a Corporator for payments in its wards, cancels or reverses a mistaken payment.
 * The record is kept; the voter becomes Not Received.
 */
paymentsRouter.post('/payments/:id/cancel', requireWardManager, async (req, res) => {
  const { admin, scope } = auth(req);
  const tx = await withTransaction(async (db) => {
    const current = await loadVisiblePayment(db, scope, str(req.params.id), true);
    if (current.status !== 'Success') fail(409, 'CONFLICT', `This payment is already ${current.status.toLowerCase()}.`);
    const reason = str(req.body?.reason).trim();
    if (reason.length < 3) fail(400, 'VALIDATION', 'A reason is required.', { reason: 'Enter a reason (at least 3 characters)' });
    if (reason.length > 500) fail(400, 'VALIDATION', 'The reason is too long.', { reason: 'Use at most 500 characters' });
    const kind = req.body?.kind;
    if (kind !== 'Cancelled' && kind !== 'Reversed') fail(400, 'VALIDATION', 'Choose cancel or reverse.');
    await db.query('UPDATE payment_transactions SET status = $1, status_reason = $2 WHERE id = $3', [kind, reason, current.id]);
    await addAudit(db, admin, kind === 'Cancelled' ? 'Payment cancelled' : 'Payment reversed', 'Payment', current.id, reason);
    return { ...current, status: kind, statusReason: reason };
  });
  res.json(tx);
});
