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
    `SELECT c.id::text AS id, c.amount, c.note, c.given_by AS "givenBy", c.given_at AS "givenAt", c.edited_at AS "editedAt"
     FROM blo_cash c WHERE c.blo_id = $1 ORDER BY c.given_at DESC, c.id DESC LIMIT 100`,
    [bloId],
  )).rows;
  return { ...(await bloCashSummary(db, bloId)), history };
}

/**
 * Every cash entry and each BLO's totals, for the Excel download: a Corporator gets its own BLOs, a Super Admin
 * every BLO (or the viewed Corporator's), a BLO itself. `?bloId=` narrows it to one BLO.
 */
cashRouter.get('/cash', async (req, res) => {
  const { admin, scope } = auth(req);
  const where = [`a.role = 'BLO'`, 'a.deleted_at IS NULL'];
  const values: unknown[] = [];
  const add = (v: unknown) => `$${values.push(v)}`;
  if (admin.role === 'CORPORATOR') where.push(`a.corporator_id = ${add(admin.id)}`);
  else if (admin.role === 'BLO') where.push(`a.id = ${add(admin.id)}`);
  else if (scope.teamId) where.push(`a.corporator_id = ${add(scope.teamId)}`);
  const bloId = str(req.query.bloId).trim();
  if (bloId) where.push(`a.id = ${add(bloId)}`);
  const blos = (await pool.query(
    `SELECT a.id, a.full_name AS name, a.corporator_id AS "corporatorId",
       COALESCE((SELECT sum(c.amount) FROM blo_cash c WHERE c.blo_id = a.id), 0)::int AS given,
       COALESCE((SELECT sum(t.amount) FROM payment_transactions t WHERE t.admin_id = a.id AND t.status = 'Success'), 0)::int AS spent
     FROM admins a WHERE ${where.join(' AND ')}
     ORDER BY substring(a.id from '^C-([0-9]+)')::int, substring(a.id from 'BLO([0-9]+)$')::int`,
    values,
  )).rows.map((b) => ({ ...b, left: b.given - b.spent }));
  const entries = blos.length
    ? (await pool.query(
        `SELECT c.id::text AS id, c.blo_id AS "bloId", c.amount, c.note, c.given_at AS "givenAt", c.edited_at AS "editedAt"
         FROM blo_cash c WHERE c.blo_id = ANY($1::text[]) ORDER BY c.given_at DESC, c.id DESC`,
        [blos.map((b) => b.id)],
      )).rows
    : [];
  res.json({ blos, entries });
});

cashRouter.get('/cash/:bloId', async (req, res) => {
  const blo = await loadBlo(pool, auth(req).admin, str(req.params.bloId));
  res.json(await cashResponse(pool, blo.id));
});

function parseEntry(body: unknown): { amount: number; note: string } {
  const b = (body ?? {}) as { amount?: unknown; note?: unknown };
  const amount = Number(b.amount);
  const note = str(b.note).trim().replace(/\s+/g, ' ');
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX_CASH_ENTRY) {
    fail(400, 'VALIDATION', 'Enter a valid amount.', { amount: 'Enter a whole amount (up to ₹1,00,00,000); use a minus sign for money taken back' });
  }
  if (note.length > 200) fail(400, 'VALIDATION', 'Note is too long.', { note: 'Keep the note under 200 characters' });
  return { amount, note };
}

/** Locks the BLO and checks that the caller is its own Corporator. */
async function loadOwnBlo(db: Db, actor: Admin, id: string): Promise<Admin> {
  await db.query('SELECT 1 FROM admins WHERE id = $1 FOR UPDATE', [id]);
  const blo = await loadBlo(db, actor, id);
  if (blo.corporatorId !== actor.id) fail(403, 'FORBIDDEN', "Only the BLO's Corporator can change the money given.");
  return blo;
}

const tooMuchBack = (given: number) =>
  fail(400, 'VALIDATION', `You can take back at most ${formatInr(given)}.`, { amount: `You can take back at most ${formatInr(given)}` });

/** Only the BLO's own Corporator records cash given (or, with a negative amount, taken back). */
cashRouter.post('/cash/:bloId', async (req, res) => {
  const actor = auth(req).admin;
  const { amount, note } = parseEntry(req.body);
  const result = await withTransaction(async (db) => {
    const blo = await loadOwnBlo(db, actor, str(req.params.bloId));
    const before = await bloCashSummary(db, blo.id);
    if (before.given + amount < 0) tooMuchBack(before.given);
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

/** The BLO's own Corporator corrects an earlier entry at any time; the total given never goes below zero. */
cashRouter.put('/cash/:bloId/:entryId', async (req, res) => {
  const actor = auth(req).admin;
  const { amount, note } = parseEntry(req.body);
  const entryId = str(req.params.entryId);
  if (!/^\d{1,18}$/.test(entryId)) fail(404, 'NOT_FOUND', 'Entry not found.');
  const result = await withTransaction(async (db) => {
    const blo = await loadOwnBlo(db, actor, str(req.params.bloId));
    const old = (await db.query<{ amount: number; note: string }>('SELECT amount, note FROM blo_cash WHERE id = $1 AND blo_id = $2', [entryId, blo.id])).rows[0];
    if (!old) fail(404, 'NOT_FOUND', 'Entry not found.');
    if (old.amount === amount && old.note === note) return cashResponse(db, blo.id);
    const before = await bloCashSummary(db, blo.id);
    const total = before.given - old.amount + amount;
    if (total < 0) tooMuchBack(before.given - old.amount);
    await db.query('UPDATE blo_cash SET amount = $1, note = $2, edited_at = now() WHERE id = $3', [amount, note, entryId]);
    const show = (n: number) => (n < 0 ? `−${formatInr(-n)}` : formatInr(n));
    await addAudit(db, actor, 'Cash entry changed', 'Admin', blo.id, `Entry for ${blo.id} changed from ${show(old.amount)} to ${show(amount)}; total given ${formatInr(total)}`);
    return cashResponse(db, blo.id);
  });
  res.json(result);
});
