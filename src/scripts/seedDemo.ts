/**
 * Fills an EMPTY development database with the same demo data the frontend mock uses.
 *   npm run seed:demo            (password for every account: SEED_PASSWORD, default demo@123)
 * Refuses to run in production or when voters already exist.
 */
import { pool, withTransaction } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { seedDemo } from '../db/seed.js';

if (process.env.NODE_ENV === 'production') throw new Error('seed:demo must not run in production');
const password = process.env.SEED_PASSWORD || 'demo@123';

const client = await pool.connect();
try {
  await migrate(client, (msg) => console.log(msg));
} finally {
  client.release();
}

try {
  await withTransaction(async (db) => {
    const used = (await db.query('SELECT 1 FROM admins LIMIT 1')).rowCount;
    if (used) throw new Error('The database already has data; seed:demo only fills an empty database.');
    await seedDemo(db, password);
  });
  console.log(`Demo data added. Sign in as Super Admin 9000000001 (or "Super Administrator") with password ${password}.`);
} finally {
  await pool.end();
}
