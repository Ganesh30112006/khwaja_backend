import { Router } from 'express';
import { pool, withTransaction, type Db } from '../db/pool.js';
import { findAdmin, type Admin } from '../lib/admins.js';
import { addAudit } from '../lib/audit.js';
import { fail } from '../lib/errors.js';
import { formatInr, str } from '../lib/validation.js';
import { auth, authenticate } from '../middleware/auth.js';

export const cashRouter = Router();
cashRouter.use('/cash', authenticate);

const MAX_CASH_ENTRY = 10_000_000;

/** Money given to a BLO, what it has paid out (successful payments) and what it has left. */
export async function bloCashSummary(db: Db, bloId: string) {
  const { rows } = await db.query<{ given: number; spent: number }>(
    `SELECT COALESCE((SELECT sum(amount) FROM blo_cash WHERE blo_id = $1), 0)::int AS given,
            COALESCE((SELECT sum(amount) FROM payment_transactions WHERE admin_id = $1 AND status = 'Success'), 0)::int AS spent`,
    [bloId],
  );
  const { given, spent } = rows[0];
  return { given, spent, left: given - spent };
}

/** The BLO itself, its Corporator and the Super Admin can see a BLO's cash. */
async function loadBlo(db: Db, actor: Admin, id: string): Promise<Admin> {
  const blo = await findAdmin(db, id);
  const allowed = blo?.role === 'BLO' && (actor.role === 'SUPER_ADMIN' || actor.id === blo.id || blo.corporatorId === actor.id);
  if (!blo || !allowed) fail(404, 'NOT_FOUND', 'Account not found.');
  return blo;
}

async function cashResponse(db: Db, bloId: string) {
  const history = (await db.query(
    `SELECT c.id::text AS id, c.amount, c.note, c.given_by AS "givenBy", c.given_at AS "givenAt"
     FROM blo_cash c WHERE c.blo_id = $1 ORDER BY c.given_at DESC, c.id DESC LIMIT 100`,
    [bloId],
  )).rows;
  return { ...(await bloCashSummary(db, bloId)), history };
}

cashRouter.get('/cash/:bloId', async (req, res) => {
  const blo = await loadBlo(pool, auth(req).admin, str(req.params.bloId));
  res.json(await cashResponse(pool, blo.id));
});

/** Only the BLO's own Corporator records cash given (or, with a negative amount, taken back). */
cashRouter.post('/cash/:bloId', async (req, res) => {
  const actor = auth(req).admin;
  const amount = Number(req.body?.amount);
  const note = str(req.body?.note).trim().replace(/\s+/g, ' ');
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_CASH_ENTRY) {
    fail(400, 'VALIDATION', 'Enter a valid amount.', { amount: 'Enter a whole amount (up to ₹1,00,00,000); use a minus sign for money taken back' });
  }
  if (note.length > 200) fail(400, 'VALIDATION', 'Note is too long.', { note: 'Keep the note under 200 characters' });
  const result = await withTransaction(async (db) => {
    await db.query('SELECT 1 FROM admins WHERE id = $1 FOR UPDATE', [str(req.params.bloId)]);
    const blo = await loadBlo(db, actor, str(req.params.bloId));
    if (blo.corporatorId !== actor.id) fail(403, 'FORBIDDEN', "Only the BLO's Corporator can change the money given.");
    const before = await bloCashSummary(db, blo.id);
    if (before.given + amount < 0) fail(400, 'VALIDATION', `You can take back at most ${formatInr(before.given)}.`, { amount: `You can take back at most ${formatInr(before.given)}` });
    await db.query('INSERT INTO blo_cash (blo_id, amount, note, given_by) VALUES ($1, $2, $3, $4)', [blo.id, amount, note, actor.id]);
    await addAudit(
      db,
      actor,
      amount > 0 ? 'Cash given to BLO' : 'Cash taken back from BLO',
      'Admin',
      blo.id,
      `${formatInr(Math.abs(amount))} ${amount > 0 ? 'given to' : 'taken back from'} ${blo.id}; total given ${formatInr(before.given + amount)}`,
    );
    return cashResponse(db, blo.id);
  });
  res.status(201).json(result);
});
