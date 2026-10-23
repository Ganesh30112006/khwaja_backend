/** Applies pending database migrations: npm run migrate (or migrate:prod after a build). */
import { pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

const client = await pool.connect();
try {
  await migrate(client, (msg) => console.log(msg));
  console.log('Database is up to date.');
} finally {
  client.release();
  await pool.end();
}
