import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type pg from 'pg';
import { isUniqueViolation, Params, pool, withTransaction, type Db } from '../db/pool.js';
import { ADMIN_ORDER, ADMIN_SELECT, findAdmin, ID_SORT_KEYS, manages, type Admin, type ManagedRole } from '../lib/admins.js';
import { addAudit } from '../lib/audit.js';
import { fail, failIfErrors } from '../lib/errors.js';
import { nextNumber } from '../lib/ids.js';
import { pageWindow } from '../lib/pagination.js';
import { hashPassword, passwordTakenError, passwordTakenForName } from '../lib/password.js';
import { isValidIndianMobile, isValidPassword, likePattern, normalizeMobile, PASSWORD_RULES, str, strArray } from '../lib/validation.js';
import { auth, authenticate, requireManager } from '../middleware/auth.js';

export const adminsRouter = Router();
adminsRouter.use('/admins', authenticate, requireManager);

/**
 * Setting a password can reveal that another account with the same name uses it, so failed
 * attempts are throttled per signed-in account, like failed logins.
 */
const passwordWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `admin:${req.auth?.admin.id ?? 'anonymous'}`,
  message: { message: 'Too many attempts. Please wait 15 minutes and try again.' },
});

interface AdminInput {
  fullName: string;
  mobile: string;
  location: string;
  wardIds: string[];
  boothIds: string[];
}

/**
 * Validates an account. Super Admins cover everything (no wards). Corporators cover whole wards (no booths)
 * and have a location. A BLO's wards must be inside its Corporator's wards, and its booths inside the chosen wards.
 */
async function validateAdminInput(db: Db, body: Record<string, unknown>, role: ManagedRole, corporator: Admin | null, excludeId?: string): Promise<AdminInput> {
  const errors: Record<string, string> = {};
  const fullName = str(body.fullName).trim();
  if (fullName.length < 2) errors.fullName = 'Full name is required';
  else if (fullName.length > 100) errors.fullName = 'Full name is too long';
  if (!isValidIndianMobile(str(body.mobile))) errors.mobile = 'Enter a valid 10-digit Indian mobile number';
  const mobile = normalizeMobile(str(body.mobile));
  if (!errors.mobile) {
    const { rowCount } = await db.query('SELECT 1 FROM admins WHERE mobile = $1 AND id <> $2', [mobile, excludeId ?? '']);
    if (rowCount) errors.mobile = 'Another account already uses this mobile number';
  }
  const location = role === 'CORPORATOR' ? str(body.location).trim() : '';
  if (location.length > 200) errors.location = 'Location is too long (200 characters at most)';
  const wardIds = role === 'SUPER_ADMIN' ? [] : strArray(body.wardIds);
  if (!wardIds.length) {
    if (role !== 'SUPER_ADMIN') errors.wardIds = 'Assign at least one ward';
  }
  else if ((await db.query('SELECT 1 FROM wards WHERE id = ANY($1)', [wardIds])).rowCount !== wardIds.length) errors.wardIds = 'One or more wards do not exist';
  else if (role === 'BLO' && corporator && wardIds.some((id) => !corporator.wardIds.includes(id))) errors.wardIds = `Choose wards assigned to ${corporator.id}`;
  const boothIds = role === 'BLO' ? strArray(body.boothIds) : [];
  if (boothIds.length) {
    const { rowCount } = await db.query('SELECT 1 FROM booths WHERE id = ANY($1) AND ward_id = ANY($2)', [boothIds, wardIds]);
    if (rowCount !== boothIds.length) errors.boothIds = 'Booths must belong to the selected wards';
  }
  failIfErrors(errors);
  return { fullName, mobile, location, wardIds, boothIds };
}

async function saveAssignments(db: pg.PoolClient, adminId: string, input: Pick<AdminInput, 'wardIds' | 'boothIds'>): Promise<void> {
  await db.query('DELETE FROM admin_wards WHERE admin_id = $1', [adminId]);
  await db.query('DELETE FROM admin_booths WHERE admin_id = $1', [adminId]);
  await db.query('INSERT INTO admin_wards (admin_id, ward_id) SELECT $1, unnest($2::text[])', [adminId, input.wardIds]);
  await db.query('INSERT INTO admin_booths (admin_id, booth_id) SELECT $1, unnest($2::text[])', [adminId, input.boothIds]);
}

/** After a Corporator loses wards, its BLOs lose those wards and the booths in them. */
export async function trimBlosToCorporator(db: Db, corporatorId: string): Promise<void> {
  await db.query(
    `DELETE FROM admin_wards aw USING admins b
     WHERE aw.admin_id = b.id AND b.corporator_id = $1
       AND aw.ward_id NOT IN (SELECT ward_id FROM admin_wards WHERE admin_id = $1)`,
    [corporatorId],
  );
  await db.query(
    `DELETE FROM admin_booths ab USING admins b, booths bo
     WHERE ab.admin_id = b.id AND b.corporator_id = $1 AND bo.id = ab.booth_id
       AND bo.ward_id NOT IN (SELECT ward_id FROM admin_wards WHERE admin_id = $1)`,
    [corporatorId],
  );
}

async function wardList(db: Db, ids: string[]): Promise<string> {
  const { rows } = await db.query<{ number: number }>('SELECT number FROM wards WHERE id = ANY($1) ORDER BY number', [ids]);
  return rows.map((r) => r.number).join(', ') || 'none';
}

async function boothList(db: Db, ids: string[]): Promise<string> {
  const { rows } = await db.query<{ number: number }>('SELECT number FROM booths WHERE id = ANY($1) ORDER BY number', [ids]);
  return rows.length ? rows.map((r) => r.number).join(', ') : 'all in ward';
}

/** A duplicate mobile that slipped past validation because of a concurrent request. */
function mobileTaken(err: unknown): never {
  if (isUniqueViolation(err, 'admins_mobile_key')) {
    fail(400, 'VALIDATION', 'Please correct the highlighted fields.', { mobile: 'Another account already uses this mobile number' });
  }
  throw err;
}

/** Loads an account the actor manages; anything else is reported as not found. */
async function loadManaged(db: Db, actor: Admin, id: string, lock = false): Promise<Admin> {
  if (lock) await db.query('SELECT 1 FROM admins WHERE id = $1 FOR UPDATE', [id]);
  const target = await findAdmin(db, id);
  if (!target || !manages(actor, target)) fail(404, 'NOT_FOUND', 'Account not found.');
  return target;
}

/** SQL filter for the accounts an actor manages. */
function managedFilter(actor: Admin, p: Params): string {
  if (actor.role === 'SUPER_ADMIN') return `a.id <> ${p.add(actor.id)}`;
  return `a.role = 'BLO' AND a.corporator_id = ${p.add(actor.id)}`;
}

const ADMIN_SORTS: Record<string, string> = {
  fullName: 'a.full_name COLLATE natural_sort',
  createdAt: 'a.created_at',
  status: 'a.status',
};

adminsRouter.get('/admins', async (req, res) => {
  const actor = auth(req).admin;
  const q = req.query;
  const p = new Params();
  const where = [managedFilter(actor, p)];
  if (q.role === 'SUPER_ADMIN' || q.role === 'CORPORATOR' || q.role === 'BLO') where.push(`a.role = ${p.add(q.role)}`);
  if (str(q.corporatorId)) where.push(`a.corporator_id = ${p.add(str(q.corporatorId))}`);
  const search = str(q.search).trim();
  if (search) {
    const s = p.add(likePattern(search));
    where.push(`(a.id ILIKE ${s} OR a.full_name ILIKE ${s} OR a.mobile LIKE ${s})`);
  }
  if (str(q.wardId)) where.push(`EXISTS (SELECT 1 FROM admin_wards aw WHERE aw.admin_id = a.id AND aw.ward_id = ${p.add(str(q.wardId))})`);
  if (str(q.status)) where.push(`a.status = ${p.add(str(q.status))}`);
  const filter = `WHERE ${where.join(' AND ')}`;
  const total = (await pool.query<{ n: number }>(`SELECT count(*) AS n FROM admins a ${filter}`, p.values)).rows[0].n;
  const win = pageWindow(total, q.page, q.pageSize);
  const dir = q.sortDir === 'desc' ? 'DESC' : 'ASC';
  const sort = ADMIN_SORTS[str(q.sortBy)];
  // ID order is numeric per part (C-2 before C-10); its direction applies to every part.
  const idOrder = ID_SORT_KEYS.map((k) => `${k} ${dir}`).join(', ');
  const order = sort ? `${sort} ${dir}, ${ID_SORT_KEYS.join(', ')}` : idOrder;
  const { rows } = await pool.query<Admin>(`${ADMIN_SELECT} ${filter} ORDER BY ${order} LIMIT ${win.pageSize} OFFSET ${win.offset}`, p.values);
  res.json({ items: rows, total, page: win.page, pageSize: win.pageSize });
});

/** Small list for filters and pickers: every account for the Super Admin; a Corporator and its BLOs otherwise. */
adminsRouter.get('/admins/options', async (req, res) => {
  const actor = auth(req).admin;
  const p = new Params();
  const where = actor.role === 'SUPER_ADMIN' ? 'TRUE' : `(a.id = ${p.add(actor.id)} OR a.corporator_id = ${p.add(actor.id)})`;
  const { rows } = await pool.query<Admin>(`${ADMIN_SELECT} WHERE ${where} ORDER BY ${ADMIN_ORDER}`, p.values);
  res.json(rows.map((a) => ({ id: a.id, fullName: a.fullName, role: a.role, corporatorId: a.corporatorId, wardIds: a.wardIds })));
});

adminsRouter.get('/admins/:id', async (req, res) => {
  res.json(await loadManaged(pool, auth(req).admin, str(req.params.id)));
});

adminsRouter.post('/admins', passwordWriteLimiter, async (req, res) => {
  const actor = auth(req).admin;
  const body = req.body ?? {};
  const role = body.role;
  if (role !== 'SUPER_ADMIN' && role !== 'CORPORATOR' && role !== 'BLO') fail(400, 'VALIDATION', 'Choose an account role.', { role: 'Choose an account role' });
  if (role !== 'BLO' && actor.role !== 'SUPER_ADMIN') fail(403, 'FORBIDDEN', 'Only a Super Admin can create Super Admins and Corporators.');
  if (!isValidPassword(body.password)) fail(400, 'VALIDATION', 'Please correct the highlighted fields.', { password: PASSWORD_RULES });
  const hash = await hashPassword(body.password);
  const created = await withTransaction(async (db) => {
    let corporator: Admin | null = null;
    if (role === 'BLO') {
      const corporatorId = actor.role === 'CORPORATOR' ? actor.id : str(body.corporatorId);
      // Lock the Corporator row: it holds the BLO counter.
      await db.query(`SELECT 1 FROM admins WHERE id = $1 AND role = 'CORPORATOR' FOR UPDATE`, [corporatorId]);
      const found = await findAdmin(db, corporatorId);
      corporator = found?.role === 'CORPORATOR' ? found : null;
      if (!corporator) fail(400, 'VALIDATION', 'Please correct the highlighted fields.', { corporatorId: 'Select a Corporator' });
    }
    const input = await validateAdminInput(db, body, role, corporator);
    if (await passwordTakenForName(db, input.fullName, body.password)) throw passwordTakenError(input.fullName, 'password');
    const id = corporator
      ? `${corporator.id}-BLO${(await db.query<{ n: number }>('UPDATE admins SET blo_counter = blo_counter + 1 WHERE id = $1 RETURNING blo_counter AS n', [corporator.id])).rows[0].n}`
      : role === 'SUPER_ADMIN'
        ? `SA-${await nextNumber(db, 'super_admin')}`
        : `C-${await nextNumber(db, 'corporator')}`;
    await db
      .query(
        `INSERT INTO admins (id, full_name, mobile, role, corporator_id, location, status, password_hash, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'Active', $7, now())`,
        [id, input.fullName, input.mobile, role, corporator?.id ?? null, input.location, hash],
      )
      .catch(mobileTaken);
    await saveAssignments(db, id, input);
    const action = role === 'SUPER_ADMIN' ? 'Super Admin created' : role === 'CORPORATOR' ? 'Corporator created' : 'BLO created';
    await addAudit(db, actor, action, 'Admin', id, role === 'SUPER_ADMIN' ? input.fullName : `${input.fullName}, wards ${await wardList(db, input.wardIds)}`);
    return findAdmin(db, id);
  });
  res.status(201).json(created);
});

adminsRouter.put('/admins/:id', async (req, res) => {
  const actor = auth(req).admin;
  const updated = await withTransaction(async (db) => {
    const target = await loadManaged(db, actor, str(req.params.id), true);
    const corporator = target.role === 'BLO' && target.corporatorId ? (await findAdmin(db, target.corporatorId)) ?? null : null;
    const input = await validateAdminInput(db, req.body ?? {}, target.role as ManagedRole, corporator, target.id);
    const changes: string[] = [];
    if (target.fullName !== input.fullName) changes.push(`name "${target.fullName}" → "${input.fullName}"`);
    if (target.mobile !== input.mobile) changes.push('mobile changed');
    if (target.location !== input.location) changes.push(`location "${target.location}" → "${input.location}"`);
    const same = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
    const assignmentChanged = !same(target.wardIds, input.wardIds) || !same(target.boothIds, input.boothIds);
    await db
      .query('UPDATE admins SET full_name = $1, mobile = $2, location = $3 WHERE id = $4', [input.fullName, input.mobile, input.location, target.id])
      .catch(mobileTaken);
    await saveAssignments(db, target.id, input);
    if (target.role === 'CORPORATOR') await trimBlosToCorporator(db, target.id);
    if (changes.length) await addAudit(db, actor, 'Account updated', 'Admin', target.id, changes.join('; '));
    if (assignmentChanged) {
      await addAudit(db, actor, 'Assignment changed', 'Admin', target.id, `Wards ${await wardList(db, input.wardIds)}; booths ${await boothList(db, input.boothIds)}`);
    }
    return findAdmin(db, target.id);
  });
  res.json(updated);
});

adminsRouter.patch('/admins/:id/status', async (req, res) => {
  const actor = auth(req).admin;
  const status = req.body?.status;
  if (status !== 'Active' && status !== 'Inactive') fail(400, 'VALIDATION', 'Choose Active or Inactive.', { status: 'Choose Active or Inactive' });
  const updated = await withTransaction(async (db) => {
    const target = await loadManaged(db, actor, str(req.params.id), true);
    if (target.status !== status) {
      await db.query('UPDATE admins SET status = $1 WHERE id = $2', [status, target.id]);
      if (status === 'Inactive') await db.query('DELETE FROM sessions WHERE admin_id = $1', [target.id]);
      await addAudit(db, actor, status === 'Active' ? 'Account activated' : 'Account deactivated', 'Admin', target.id, target.fullName);
    }
    return findAdmin(db, target.id);
  });
  res.json(updated);
});

/** Sets a new password for a managed account; that account is signed out everywhere. */
adminsRouter.put('/admins/:id/password', passwordWriteLimiter, async (req, res) => {
  const actor = auth(req).admin;
  const password = req.body?.password;
  const target = await loadManaged(pool, actor, str(req.params.id));
  if (!isValidPassword(password)) fail(400, 'VALIDATION', 'Password does not meet the requirements.', { password: PASSWORD_RULES });
  if (await passwordTakenForName(pool, target.fullName, password, target.id)) throw passwordTakenError(target.fullName, 'password');
  const hash = await hashPassword(password);
  await withTransaction(async (db) => {
    const locked = await loadManaged(db, actor, str(req.params.id), true);
    await db.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [hash, locked.id]);
    await db.query('DELETE FROM sessions WHERE admin_id = $1', [locked.id]);
    await addAudit(db, actor, 'Password changed', 'Admin', locked.id, `Password for ${locked.fullName} changed by ${actor.id}`);
  });
  res.status(204).end();
});
