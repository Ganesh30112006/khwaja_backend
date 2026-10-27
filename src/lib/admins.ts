import type { Db } from '../db/pool.js';
import { fail } from './errors.js';

export type Role = 'SUPER_ADMIN' | 'CORPORATOR' | 'BLO';
/** Roles an account can be created with (a Super Admin can create any role, a Corporator only BLOs). */
export type ManagedRole = Role;
export type AccountStatus = 'Active' | 'Inactive';

export interface Admin {
  id: string;
  fullName: string;
  mobile: string;
  role: Role;
  /** The Corporator a BLO belongs to; null for other roles. */
  corporatorId: string | null;
  /** Where a Corporator is based; empty for other roles. */
  location: string;
  wardIds: string[];
  boothIds: string[];
  status: AccountStatus;
  createdAt: Date;
}

/** Selects accounts in the API shape. Ward and booth IDs are ordered by their numbers. */
export const ADMIN_SELECT = `
  SELECT a.id, a.full_name AS "fullName", a.mobile, a.role, a.corporator_id AS "corporatorId", a.location, a.status, a.created_at AS "createdAt",
    COALESCE((SELECT array_agg(aw.ward_id ORDER BY w.number) FROM admin_wards aw JOIN wards w ON w.id = aw.ward_id WHERE aw.admin_id = a.id), '{}') AS "wardIds",
    COALESCE((SELECT array_agg(ab.booth_id ORDER BY b.number) FROM admin_booths ab JOIN booths b ON b.id = ab.booth_id WHERE ab.admin_id = a.id), '{}') AS "boothIds"
  FROM admins a`;

/** Numeric parts of an account ID: C-2 before C-10, and C-1-BLO2 before C-1-BLO10. */
export const ID_SORT_KEYS = [`split_part(a.id, '-', 2)::int`, `COALESCE(NULLIF(regexp_replace(a.id, '^.*-BLO', ''), a.id), '0')::int`];

/** Super Admin first, then accounts by ID. */
export const ADMIN_ORDER = [`a.role = 'SUPER_ADMIN' DESC`, ...ID_SORT_KEYS].join(', ');

export async function findAdmin(db: Db, id: string): Promise<Admin | undefined> {
  const { rows } = await db.query<Admin>(`${ADMIN_SELECT} WHERE a.id = $1 AND a.deleted_at IS NULL`, [id]);
  return rows[0];
}

/**
 * Accounts the actor may see and manage: a Super Admin manages every other account, Super Admins included
 * (their own account is changed from My Profile); a Corporator only its own BLOs.
 */
export function manages(actor: Admin, target: Pick<Admin, 'id' | 'role' | 'corporatorId'>): boolean {
  if (actor.role === 'SUPER_ADMIN') return target.id !== actor.id;
  if (target.role === 'SUPER_ADMIN') return false;
  return actor.role === 'CORPORATOR' && target.role === 'BLO' && target.corporatorId === actor.id;
}

/** A Corporator may only act inside its own wards; the Super Admin anywhere. */
export function ownsWard(actor: Admin, wardId: string): boolean {
  return actor.role === 'SUPER_ADMIN' || (actor.role === 'CORPORATOR' && actor.wardIds.includes(wardId));
}

export function assertOwnWard(actor: Admin, wardId: string): void {
  if (!ownsWard(actor, wardId)) fail(403, 'FORBIDDEN', 'This ward is not assigned to you.');
}

/**
 * A ward can have several Corporators. Each Corporator and its BLOs form a team (identified by the
 * Corporator's ID) with its own view of the shared voter list, its own payments and permissions.
 */
export function teamOf(admin: Pick<Admin, 'id' | 'role' | 'corporatorId'>): string | null {
  if (admin.role === 'CORPORATOR') return admin.id;
  if (admin.role === 'BLO') return admin.corporatorId;
  return null;
}

/**
 * The voters an account covers. A booth assignment narrows its ward to those booths;
 * a ward without booth assignments covers every booth in it. The Super Admin covers everything.
 * `teamId` is whose view of the voters, payments and permissions is used: the account's own team, or for the
 * Super Admin the Corporator it chose to view (null = the shared list and every team's payments).
 */
export interface Scope {
  all: boolean;
  fullWardIds: string[];
  boothIds: string[];
  teamId: string | null;
}

export async function loadScope(db: Db, admin: Admin, viewTeam = ''): Promise<Scope> {
  if (admin.role === 'SUPER_ADMIN') {
    const team = viewTeam
      ? (await db.query<{ id: string }>(`SELECT id FROM admins WHERE id = $1 AND role = 'CORPORATOR' AND deleted_at IS NULL`, [viewTeam])).rows[0]
      : undefined;
    return { all: true, fullWardIds: [], boothIds: [], teamId: team?.id ?? null };
  }
  const { rows } = await db.query<{ id: string; wardId: string }>('SELECT id, ward_id AS "wardId" FROM booths WHERE id = ANY($1)', [admin.boothIds]);
  const restricted = new Set(rows.map((b) => b.wardId));
  return {
    all: false,
    fullWardIds: admin.wardIds.filter((w) => !restricted.has(w)),
    boothIds: rows.filter((b) => admin.wardIds.includes(b.wardId)).map((b) => b.id),
    teamId: teamOf(admin),
  };
}

export function covers(scope: Scope, loc: { wardId: string; boothId: string }): boolean {
  return scope.all || scope.fullWardIds.includes(loc.wardId) || scope.boothIds.includes(loc.boothId);
}

/** SQL condition equivalent to covers() for the given ward/booth columns. */
export function coversSql(scope: Scope, add: (v: unknown) => string, wardCol: string, boothCol: string): string {
  if (scope.all) return 'TRUE';
  return `(${wardCol} = ANY(${add(scope.fullWardIds)}) OR ${boothCol} = ANY(${add(scope.boothIds)}))`;
}

export function deviceLabel(ua: string | undefined): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

/** Names are compared ignoring case and extra spaces ("ramesh  BABU" = "Ramesh Babu"). */
export function nameKey(name: string): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** SQL expression for nameKey() of a full_name column. */
export const NAME_KEY_SQL = (col: string) => `lower(btrim(regexp_replace(${col}, '[[:space:]]+', ' ', 'g')))`;
