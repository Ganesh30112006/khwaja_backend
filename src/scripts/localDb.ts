/**
 * Development only: runs a local PostgreSQL server (real Postgres binaries from npm, no Docker)
 * with its data in Backend/.pgdata. Keep it running in its own terminal: npm run db:local
 */
import { existsSync } from 'node:fs';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const port = Number(process.env.LOCAL_DB_PORT ?? 5433);
const dir = '.pgdata';
const fresh = !existsSync(dir);
const server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
if (fresh) await server.initialise();
await server.start();
if (fresh) {
  const client = new pg.Client({ host: 'localhost', port, user: 'postgres', password: 'postgres', database: 'postgres' });
  await client.connect();
  await client.query(`CREATE DATABASE voterdesk ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
  await client.end();
}
console.log(`Local PostgreSQL ready: postgres://postgres:postgres@localhost:${port}/voterdesk (Ctrl+C to stop)`);

const stop = () => server.stop().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
