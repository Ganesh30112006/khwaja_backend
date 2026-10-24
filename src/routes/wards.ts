import { Router } from 'express';
import { isUniqueViolation, pool, withTransaction, type Db } from '../db/pool.js';
import { assertOwnWard, ownsWard } from '../lib/admins.js';
import { addAudit } from '../lib/audit.js';
import { fail, failIfErrors } from '../lib/errors.js';
import { nextNumber } from '../lib/ids.js';
import { str, strArray } from '../lib/validation.js';
import { auth, authenticate, requireSuper, requireWardManager } from '../middleware/auth.js';
import { trimBlosToCorporator } from './admins.js';

export const wardsRouter = Router();

interface Ward {
  id: string;
  number: number;
  name: string;
}

interface Booth extends Ward {
  wardId: string;
}

const BOOTH_COLUMNS = 'id, ward_id AS "wardId", number, name';

function parseNumber(v: unknown): number {
  return typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN;
}

async function validateWard(db: Db, body: Record<string, unknown>, excludeId?: string): Promise<Omit<Ward, 'id'>> {
  const number = parseNumber(body.number);
  const name = str(body.name).trim();
  const errors: Record<string, string> = {};
  if (!Number.isInteger(number) || number <= 0 || number > 1_000_000) errors.number = 'Enter a valid ward number';
  else if ((await db.query('SELECT 1 FROM wards WHERE number = $1 AND id <> $2', [number, excludeId ?? ''])).rowCount) errors.number = `Ward ${number} already exists`;
  if (name.length < 2) errors.name = 'Ward name is required';
  else if (name.length > 80) errors.name = 'Ward name is too long';
  failIfErrors(errors);
  return { number, name };
}

async function validateBooth(db: Db, wardId: string, body: Record<string, unknown>, excludeId?: string): Promise<Omit<Booth, 'id'>> {
  const number = parseNumber(body.number);
  const name = str(body.name).trim();
  const errors: Record<string, string> = {};
  if (!(await db.query('SELECT 1 FROM wards WHERE id = $1', [wardId])).rowCount) errors.wardId = 'Select a valid ward';
  if (!Number.isInteger(number) || number <= 0 || number > 1_000_000) errors.number = 'Enter a valid booth number';
  else if ((await db.query('SELECT 1 FROM booths WHERE ward_id = $1 AND number = $2 AND id <> $3', [wardId, number, excludeId ?? ''])).rowCount) {
    errors.number = `Booth ${number} already exists in this ward`;
  }
  if (name.length < 2) errors.name = 'Booth name is required';
  else if (name.length > 80) errors.name = 'Booth name is too long';
  failIfErrors(errors);
  return { wardId, number, name };
}

/** A duplicate number that slipped past validation because of a concurrent request. */
function numberTaken(message: string) {
  return (err: unknown): never => {
    if (isUniqueViolation(err)) fail(400, 'VALIDATION', 'Please correct the highlighted fields.', { number: message });
    throw err;
  };
}

async function wardNumber(db: Db, id: string): Promise<number> {
  return (await db.query<{ number: number }>('SELECT number FROM wards WHERE id = $1', [id])).rows[0]?.number ?? 0;
}

/** Wards and booths are readable by every admin (filters, forms, labels). */
wardsRouter.get('/wards', authenticate, async (_req, res) => {
  const wards = (await pool.query<Ward>('SELECT id, number, name FROM wards ORDER BY number')).rows;
  const booths = (await pool.query<Booth>(`SELECT ${BOOTH_COLUMNS} FROM booths ORDER BY number, id`)).rows;
  res.json({ wards, booths });
});

/** Wards with their booths, voter counts and assigned accounts. A Corporator sees only its own wards. */
wardsRouter.get('/wards/summary', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  const wards = (await pool.query<Ward & { voterCount: number; adminIds: string[] }>(
    `SELECT w.id, w.number, w.name,
       (SELECT count(*) FROM voters v WHERE v.ward_id = w.id) AS "voterCount",
       COALESCE((SELECT array_agg(a.id ORDER BY split_part(a.id, '-', 2)::int) FROM admin_wards aw JOIN admins a ON a.id = aw.admin_id
                 WHERE aw.ward_id = w.id AND a.role = 'CORPORATOR'), '{}') AS "adminIds"
     FROM wards w ORDER BY w.number`,
  )).rows;
  const booths = (await pool.query<Booth & { voterCount: number; adminIds: string[] }>(
    `SELECT b.id, b.ward_id AS "wardId", b.number, b.name,
       (SELECT count(*) FROM voters v WHERE v.booth_id = b.id) AS "voterCount",
       COALESCE((SELECT array_agg(a.id ORDER BY split_part(a.id, '-', 2)::int) FROM admin_booths ab JOIN admins a ON a.id = ab.admin_id
                 WHERE ab.booth_id = b.id AND a.role = 'BLO'), '{}') AS "adminIds"
     FROM booths b ORDER BY b.number, b.id`,
  )).rows;
  res.json(wards.filter((w) => ownsWard(actor, w.id)).map((w) => ({ ...w, booths: booths.filter((b) => b.wardId === w.id) })));
});

wardsRouter.post('/wards', authenticate, requireSuper, async (req, res) => {
  const actor = auth(req).admin;
  const ward = await withTransaction(async (db) => {
    const clean = await validateWard(db, req.body ?? {});
    // Skip IDs already taken by seeded or manually numbered wards.
    let id: string;
    do id = `W${await nextNumber(db, 'ward')}`;
    while ((await db.query('SELECT 1 FROM wards WHERE id = $1', [id])).rowCount);
    await db.query('INSERT INTO wards (id, number, name) VALUES ($1, $2, $3)', [id, clean.number, clean.name]).catch(numberTaken(`Ward ${clean.number} already exists`));
    await addAudit(db, actor, 'Ward created', 'Ward', id, `Ward ${clean.number} – ${clean.name}`);
    return { id, ...clean };
  });
  res.status(201).json(ward);
});

wardsRouter.put('/wards/:id', authenticate, requireSuper, async (req, res) => {
  const actor = auth(req).admin;
  const ward = await withTransaction(async (db) => {
    const current = (await db.query<Ward>('SELECT id, number, name FROM wards WHERE id = $1 FOR UPDATE', [str(req.params.id)])).rows[0];
    if (!current) fail(404, 'NOT_FOUND', 'Ward not found.');
    const clean = await validateWard(db, req.body ?? {}, current.id);
    await db.query('UPDATE wards SET number = $1, name = $2 WHERE id = $3', [clean.number, clean.name, current.id]).catch(numberTaken(`Ward ${clean.number} already exists`));
    await addAudit(db, actor, 'Ward updated', 'Ward', current.id, `Ward ${current.number} – ${current.name} → Ward ${clean.number} – ${clean.name}`);
    return { id: current.id, ...clean };
  });
  res.json(ward);
});

wardsRouter.post('/booths', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  const booth = await withTransaction(async (db) => {
    const clean = await validateBooth(db, str(req.body?.wardId), req.body ?? {});
    assertOwnWard(actor, clean.wardId);
    let id: string;
    do id = `B-${await nextNumber(db, 'booth')}`;
    while ((await db.query('SELECT 1 FROM booths WHERE id = $1', [id])).rowCount);
    await db
      .query('INSERT INTO booths (id, ward_id, number, name) VALUES ($1, $2, $3, $4)', [id, clean.wardId, clean.number, clean.name])
      .catch(numberTaken(`Booth ${clean.number} already exists in this ward`));
    await addAudit(db, actor, 'Booth created', 'Booth', id, `Booth ${clean.number} in ward ${await wardNumber(db, clean.wardId)}`);
    return { id, ...clean };
  });
  res.status(201).json(booth);
});

wardsRouter.put('/booths/:id', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  const booth = await withTransaction(async (db) => {
    const current = (await db.query<Booth>(`SELECT ${BOOTH_COLUMNS} FROM booths WHERE id = $1 FOR UPDATE`, [str(req.params.id)])).rows[0];
    if (!current || !ownsWard(actor, current.wardId)) fail(404, 'NOT_FOUND', 'Booth not found.');
    // A booth stays in its ward so existing voter records remain consistent.
    const clean = await validateBooth(db, current.wardId, req.body ?? {}, current.id);
    await db
      .query('UPDATE booths SET number = $1, name = $2 WHERE id = $3', [clean.number, clean.name, current.id])
      .catch(numberTaken(`Booth ${clean.number} already exists in this ward`));
    await addAudit(db, actor, 'Booth updated', 'Booth', current.id, `Booth ${current.number} – ${current.name} → Booth ${clean.number} – ${clean.name}`);
    return { id: current.id, ...clean };
  });
  res.json(booth);
});

/**
 * Sets the Corporator of a ward (a ward has at most one). Choosing a different Corporator moves the ward:
 * the previous Corporator, and its BLOs, lose it.
 */
wardsRouter.put('/wards/:id/admins', authenticate, requireSuper, async (req, res) => {
  const actor = auth(req).admin;
  const wanted = strArray(req.body?.adminIds);
  if (wanted.length > 1) fail(400, 'VALIDATION', 'A ward has one Corporator. Choose only one.');
  await withTransaction(async (db) => {
    const ward = (await db.query<Ward>('SELECT id, number FROM wards WHERE id = $1 FOR UPDATE', [str(req.params.id)])).rows[0];
    if (!ward) fail(404, 'NOT_FOUND', 'Ward not found.');
    const admins = (await db.query<{ id: string; has: boolean }>(
      `SELECT a.id, EXISTS (SELECT 1 FROM admin_wards aw WHERE aw.admin_id = a.id AND aw.ward_id = $1) AS has
       FROM admins a WHERE a.role = 'CORPORATOR' ORDER BY split_part(a.id, '-', 2)::int FOR UPDATE OF a`,
      [ward.id],
    )).rows;
    const changed: string[] = [];
    for (const a of admins) {
      const want = wanted.includes(a.id);
      if (want && !a.has) {
        await db.query('INSERT INTO admin_wards (admin_id, ward_id) VALUES ($1, $2)', [a.id, ward.id]);
        changed.push(`+${a.id}`);
      } else if (!want && a.has) {
        await db.query('DELETE FROM admin_wards WHERE admin_id = $1 AND ward_id = $2', [a.id, ward.id]);
        await trimBlosToCorporator(db, a.id);
        changed.push(`-${a.id}`);
      }
    }
    if (changed.length) await addAudit(db, actor, 'Ward assignment changed', 'Ward', ward.id, `Ward ${ward.number}: ${changed.join(', ')}`);
  });
  res.status(204).end();
});

/**
 * Sets which BLOs work this booth. Assigning a booth also assigns its ward; the BLO's Corporator must cover that ward.
 * A Corporator changes only its own BLOs, on booths in its wards.
 */
wardsRouter.put('/booths/:id/admins', authenticate, requireWardManager, async (req, res) => {
  const actor = auth(req).admin;
  const wanted = strArray(req.body?.adminIds);
  await withTransaction(async (db) => {
    const booth = (await db.query<Booth>(`SELECT ${BOOTH_COLUMNS} FROM booths WHERE id = $1 FOR UPDATE`, [str(req.params.id)])).rows[0];
    if (!booth || !ownsWard(actor, booth.wardId)) fail(404, 'NOT_FOUND', 'Booth not found.');
    const admins = (await db.query<{ id: string; has: boolean; allowed: boolean }>(
      `SELECT a.id, EXISTS (SELECT 1 FROM admin_booths ab WHERE ab.admin_id = a.id AND ab.booth_id = $1) AS has,
         EXISTS (SELECT 1 FROM admin_wards cw WHERE cw.admin_id = a.corporator_id AND cw.ward_id = $2) AS allowed
       FROM admins a WHERE a.role = 'BLO' AND ($3::text IS NULL OR a.corporator_id = $3) ORDER BY a.id FOR UPDATE OF a`,
      [booth.id, booth.wardId, actor.role === 'CORPORATOR' ? actor.id : null],
    )).rows;
    const outside = admins.filter((a) => wanted.includes(a.id) && !a.has && !a.allowed).map((a) => a.id);
    if (outside.length) {
      fail(400, 'VALIDATION', `${outside.join(', ')} cannot be assigned here: their Corporator is not assigned to ward ${await wardNumber(db, booth.wardId)}.`);
    }
    const changed: string[] = [];
    for (const a of admins) {
      const want = wanted.includes(a.id);
      if (want && !a.has) {
        await db.query('INSERT INTO admin_booths (admin_id, booth_id) VALUES ($1, $2)', [a.id, booth.id]);
        await db.query('INSERT INTO admin_wards (admin_id, ward_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [a.id, booth.wardId]);
        changed.push(`+${a.id}`);
      } else if (!want && a.has) {
        await db.query('DELETE FROM admin_booths WHERE admin_id = $1 AND booth_id = $2', [a.id, booth.id]);
        changed.push(`-${a.id}`);
      }
    }
    if (changed.length) await addAudit(db, actor, 'Booth assignment changed', 'Booth', booth.id, `Booth ${booth.number}: ${changed.join(', ')}`);
  });
  res.status(204).end();
});
