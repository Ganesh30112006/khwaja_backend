import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/pool.js';
import { ADMIN_SELECT, loadScope, type Admin, type Scope } from '../lib/admins.js';
import { fail } from '../lib/errors.js';

export interface AuthContext {
  admin: Admin;
  sessionId: string;
  scope: Scope;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

/** Requires a valid, unexpired session belonging to an active admin. */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req);
  if (!token) fail(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');
  const { rows } = await pool.query<{ id: string; adminId: string; expired: boolean; stale: boolean }>(
    `SELECT id, admin_id AS "adminId", expires_at <= now() AS expired, last_seen_at < now() - interval '1 minute' AS stale
     FROM sessions WHERE token_hash = $1`,
    [hashToken(token)],
  );
  const session = rows[0];
  if (!session || session.expired) {
    if (session) await pool.query('DELETE FROM sessions WHERE id = $1', [session.id]);
    fail(401, 'SESSION_EXPIRED', 'Your session has expired. Please log in again.');
  }
  const admin = (await pool.query<Admin>(`${ADMIN_SELECT} WHERE a.id = $1 AND a.deleted_at IS NULL`, [session.adminId])).rows[0];
  if (!admin || admin.status !== 'Active') {
    await pool.query('DELETE FROM sessions WHERE id = $1', [session.id]);
    fail(401, 'SESSION_EXPIRED', 'Your account is no longer active. Contact the Super Admin.');
  }
  // Refresh "last seen" at most once a minute to avoid a write on every request.
  if (session.stale) await pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [session.id]);
  // A Super Admin may view one Corporator's team (X-Team-Id); everyone else always sees its own team.
  req.auth = { admin, sessionId: session.id, scope: await loadScope(pool, admin, (req.get('X-Team-Id') ?? '').trim().slice(0, 30)) };
  next();
}

export function auth(req: Request): AuthContext {
  if (!req.auth) throw new Error('authenticate middleware missing');
  return req.auth;
}

export function requireSuper(req: Request, _res: Response, next: NextFunction): void {
  if (auth(req).admin.role !== 'SUPER_ADMIN') fail(403, 'FORBIDDEN', 'Only the Super Admin can perform this action.');
  next();
}

/**
 * The Super Admin, and Corporators inside their own wards, manage voters, imports, booths and payments.
 * Routes using this must also check the ward with assertOwnWard().
 */
export function requireWardManager(req: Request, _res: Response, next: NextFunction): void {
  const role = auth(req).admin.role;
  if (role !== 'SUPER_ADMIN' && role !== 'CORPORATOR') fail(403, 'FORBIDDEN', 'Only the Super Admin and Corporators can perform this action.');
  next();
}

/** The Super Admin and Corporators manage accounts (a Corporator only its own BLOs). */
export function requireManager(req: Request, _res: Response, next: NextFunction): void {
  const role = auth(req).admin.role;
  if (role !== 'SUPER_ADMIN' && role !== 'CORPORATOR') fail(403, 'FORBIDDEN', 'You do not have permission to manage accounts.');
  next();
}
