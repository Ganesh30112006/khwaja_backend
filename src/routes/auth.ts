import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config, REMEMBER_DAYS, SESSION_HOURS } from '../config.js';
import { pool, withTransaction } from '../db/pool.js';
import { ADMIN_SELECT, deviceLabel, NAME_KEY_SQL, nameKey, type Admin } from '../lib/admins.js';
import { addAudit } from '../lib/audit.js';
import { fail } from '../lib/errors.js';
import { hashPassword, passwordTakenError, passwordTakenForName, verifyDummy, verifyPassword } from '../lib/password.js';
import { PgRateLimitStore } from '../lib/rateLimitStore.js';
import { isValidIndianMobile, isValidPassword, normalizeMobile, PASSWORD_RULES, str } from '../lib/validation.js';
import { auth, authenticate, bearerToken, hashToken, newToken } from '../middleware/auth.js';

export const authRouter = Router();

const loginLimiter = rateLimit({
  store: new PgRateLimitStore('login:'),
  windowMs: 15 * 60 * 1000,
  limit: config.loginRateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { message: 'Too many login attempts. Please wait 15 minutes and try again.' },
});

/**
 * A new password is checked against same-named accounts, which can reveal their password, so every
 * change attempt is counted per account (right or wrong current password, accepted or not).
 */
const passwordChangeLimiter = rateLimit({
  store: new PgRateLimitStore('password-change:'),
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `admin:${req.auth?.admin.id ?? 'anonymous'}`,
  message: { message: 'Too many password changes. Please wait an hour and try again.' },
});

/** Signs in with a mobile number or a full name. Names may repeat; the password tells same-named accounts apart. */
authRouter.post('/auth/login', loginLimiter, async (req, res) => {
  const identifier = str(req.body?.identifier).trim().slice(0, 100);
  const password = str(req.body?.password);
  const remember = req.body?.remember === true;
  const byMobile = isValidIndianMobile(identifier);
  const candidates = identifier
    ? (await pool.query<Admin & { passwordHash: string }>(
        `SELECT x.*, p.password_hash AS "passwordHash"
         FROM (${ADMIN_SELECT} WHERE a.deleted_at IS NULL AND ${byMobile ? 'a.mobile = $1' : `${NAME_KEY_SQL('a.full_name')} = $1`}) x
         JOIN admins p ON p.id = x.id`,
        [byMobile ? normalizeMobile(identifier) : nameKey(identifier)],
      )).rows
    : [];
  const matches: typeof candidates = [];
  for (const c of candidates) if (await verifyPassword(password, c.passwordHash)) matches.push(c);
  if (!candidates.length) await verifyDummy(password);
  if (matches.length > 1) {
    // Only possible after a rename; the mobile number is always unique.
    fail(401, 'INVALID_CREDENTIALS', 'More than one account matches this name and password. Use your mobile number to sign in.');
  }
  const row = matches[0];
  if (!row) {
    if (candidates.length === 1) await addAudit(pool, candidates[0], 'Login failed', 'Auth', candidates[0].id, 'Incorrect password', 'Failure');
    fail(401, 'INVALID_CREDENTIALS', 'Invalid mobile number, name or password.');
  }
  if (row.status !== 'Active') fail(403, 'FORBIDDEN', 'This account has been deactivated. Contact the Super Admin.');

  const { passwordHash: _hash, ...admin } = row;
  const token = newToken();
  const device = deviceLabel(req.get('user-agent')).slice(0, 100);
  const expiresAt = new Date(Date.now() + (remember ? REMEMBER_DAYS * 24 : SESSION_HOURS) * 3600_000);
  await withTransaction(async (db) => {
    await db.query('DELETE FROM sessions WHERE admin_id = $1 AND expires_at <= now()', [admin.id]);
    await db.query(
      'INSERT INTO sessions (id, token_hash, admin_id, created_at, last_seen_at, expires_at, device) VALUES ($1, $2, $3, now(), now(), $4, $5)',
      [randomUUID(), hashToken(token), admin.id, expiresAt, device],
    );
    await addAudit(db, admin, 'Logged in', 'Auth', admin.id, device);
  });
  res.json({ token, admin, expiresAt: expiresAt.toISOString() });
});

authRouter.post('/auth/logout', async (req, res) => {
  const token = bearerToken(req);
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
  res.status(204).end();
});

authRouter.get('/auth/me', authenticate, (req, res) => {
  res.json(auth(req).admin);
});

authRouter.post('/auth/change-password', authenticate, passwordChangeLimiter, async (req, res) => {
  const { admin, sessionId } = auth(req);
  const currentPassword = str(req.body?.currentPassword);
  const newPassword = req.body?.newPassword;
  const stored = (await pool.query<{ hash: string }>('SELECT password_hash AS hash FROM admins WHERE id = $1', [admin.id])).rows[0];
  if (!(await verifyPassword(currentPassword, stored.hash))) {
    fail(400, 'VALIDATION', 'Current password is incorrect.', { currentPassword: 'Current password is incorrect' });
  }
  if (!isValidPassword(newPassword)) fail(400, 'VALIDATION', 'Password does not meet the requirements.', { newPassword: PASSWORD_RULES });
  if (await passwordTakenForName(pool, admin.fullName, newPassword, admin.id)) throw passwordTakenError(admin.fullName, 'newPassword');
  const hash = await hashPassword(newPassword);
  await withTransaction(async (db) => {
    await db.query('UPDATE admins SET password_hash = $1 WHERE id = $2', [hash, admin.id]);
    await db.query('DELETE FROM sessions WHERE admin_id = $1 AND id <> $2', [admin.id, sessionId]);
    await addAudit(db, admin, 'Password changed', 'Auth', admin.id, 'Other sessions signed out');
  });
  res.status(204).end();
});

authRouter.get('/auth/sessions', authenticate, async (req, res) => {
  const { admin, sessionId } = auth(req);
  const { rows } = await pool.query(
    `SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", device, id = $2 AS current
     FROM sessions WHERE admin_id = $1 AND expires_at > now() ORDER BY last_seen_at DESC`,
    [admin.id, sessionId],
  );
  res.json(rows);
});

authRouter.post('/auth/sessions/revoke-others', authenticate, async (req, res) => {
  const { admin, sessionId } = auth(req);
  const { rowCount } = await pool.query('DELETE FROM sessions WHERE admin_id = $1 AND id <> $2', [admin.id, sessionId]);
  res.json({ revoked: rowCount ?? 0 });
});

authRouter.delete('/auth/sessions/:id', authenticate, async (req, res) => {
  const { admin, sessionId } = auth(req);
  const id = str(req.params.id);
  // Session IDs are UUIDs; anything else cannot match.
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const target = isUuid ? (await pool.query<{ id: string }>('SELECT id FROM sessions WHERE id = $1 AND admin_id = $2', [id, admin.id])).rows[0] : undefined;
  if (!target) fail(404, 'NOT_FOUND', 'Session not found.');
  if (target.id === sessionId) fail(400, 'VALIDATION', 'Use Log out to end the current session.');
  await pool.query('DELETE FROM sessions WHERE id = $1', [target.id]);
  res.status(204).end();
});
