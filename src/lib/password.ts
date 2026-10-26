import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { nameKey, NAME_KEY_SQL } from './admins.js';
import { ApiError } from './errors.js';

const KEY_LENGTH = 64;
const PARAMS = { N: 16384, r: 8, p: 1 };

function derive(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...opts, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Stored as scrypt$N$r$p$salt$hash (base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// Used when the mobile number is unknown so the response takes as long as a real check.
const DUMMY_HASH = hashPassword(randomBytes(12).toString('hex'));

export async function verifyDummy(password: string): Promise<false> {
  await verifyPassword(password, await DUMMY_HASH);
  return false;
}

/**
 * Whether another account with the same name already uses this password. Names may repeat, but
 * name + password must identify one account so people can sign in with their name.
 */
export async function passwordTakenForName(db: Db, fullName: string, password: string, excludeId = ''): Promise<boolean> {
  const { rows } = await db.query<{ hash: string }>(
    `SELECT password_hash AS hash FROM admins WHERE ${NAME_KEY_SQL('full_name')} = $1 AND id <> $2 AND deleted_at IS NULL`,
    [nameKey(fullName), excludeId],
  );
  for (const r of rows) if (await verifyPassword(password, r.hash)) return true;
  return false;
}

export function passwordTakenError(fullName: string, field: 'password' | 'newPassword'): ApiError {
  return new ApiError(400, 'VALIDATION', 'Please choose a different password.', {
    [field]: `Another account named "${fullName.trim().replace(/\s+/g, ' ')}" already uses this password. Choose a different one.`,
  });
}
