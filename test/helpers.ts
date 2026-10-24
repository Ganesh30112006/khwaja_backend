import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool, withTransaction } from '../src/db/pool.js';
import { seedDemo } from './fixtures.js';

export const PASSWORD = 'test-pass-1';
export const SUPER_MOBILE = '9000000001';
export const C1_MOBILE = '9876543210'; // Corporator C-1: wards W1, W2
export const C2_MOBILE = '9876500011'; // Corporator C-2: ward W3
export const BLO_MOBILE = '9876543211'; // C-1-BLO1: ward W1, booths B1-1 and B1-2

export const app = createApp();

let migrated = false;
const DATA_TABLES = [
  'audit_logs', 'idempotency_keys', 'payment_transactions', 'import_jobs', 'sessions', 'admin_booths', 'admin_wards',
  'voters', 'booths', 'wards', 'admins', 'settings_history', 'payment_settings',
];

/** Fresh demo data (the same as the frontend mock) before each test. */
export async function resetDb(): Promise<void> {
  if (!migrated) {
    const client = await pool.connect();
    try {
      await migrate(client);
    } finally {
      client.release();
    }
    migrated = true;
  }
  await withTransaction(async (db) => {
    await db.query(`TRUNCATE ${DATA_TABLES.join(', ')} CASCADE`);
    await db.query('UPDATE counters SET value = 0');
    await seedDemo(db, PASSWORD);
  });
}

export async function login(identifier: string, password = PASSWORD): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ identifier, password, remember: false });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.token as string;
}

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Calls the API as a signed-in account (token may be null for anonymous calls). */
export function call(method: Method, url: string, token: string | null, body?: unknown, query?: Record<string, unknown>) {
  let req = request(app)[method](`/api${url}`);
  if (token) req = req.set('Authorization', `Bearer ${token}`);
  if (query) req = req.query(query);
  return body === undefined ? req : req.send(body as object);
}

/** Asserts the status and the error shape { message, code?, fieldErrors? }; returns the body. */
export async function expectStatus(res: Promise<request.Response> | request.Response, status: number) {
  const r = await res;
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  if (status >= 400) expect(typeof r.body.message).toBe('string');
  return r.body;
}
