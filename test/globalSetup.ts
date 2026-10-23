import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { TEST_DB_PORT } from '../vitest.config.js';

/** Starts a throwaway PostgreSQL server (real Postgres binaries from npm, no Docker) for the test run. */
export default async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'voterdesk-pg-'));
  const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test-pw', port: TEST_DB_PORT, persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => undefined });
  await server.initialise();
  await server.start();
  const admin = new pg.Client({ host: 'localhost', port: TEST_DB_PORT, user: 'postgres', password: 'test-pw', database: 'postgres' });
  await admin.connect();
  // UTF-8 like RDS (the Windows default code page cannot store ₹).
  await admin.query(`CREATE DATABASE voterdesk_test ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
  await admin.end();
  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
