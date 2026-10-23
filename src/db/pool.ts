import { readFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../config.js';

// Return DATE columns as 'YYYY-MM-DD' text and COUNT/SUM (bigint) as numbers.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // RDS certificates are signed by Amazon's own CA: point DATABASE_CA_FILE at the RDS bundle (certs/rds-global-bundle.pem).
  ssl: config.databaseSsl
    ? { rejectUnauthorized: true, ca: process.env.DATABASE_CA_FILE ? readFileSync(process.env.DATABASE_CA_FILE, 'utf8') : undefined }
    : false,
  max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
});

export type Db = pg.Pool | pg.PoolClient;

/** Runs fn inside a transaction, committing on success and rolling back on any error. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Collects positional parameters while building a SQL string. */
export class Params {
  values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Postgres unique_violation, optionally for a specific constraint/index. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (!constraint || e.constraint === constraint);
}
