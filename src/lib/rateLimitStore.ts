import type { IncrementResponse, Options, Store } from 'express-rate-limit';
import { pool } from '../db/pool.js';

const CLEANUP_EVERY_MS = 60 * 60 * 1000;
let lastCleanup = 0;

/**
 * express-rate-limit store kept in PostgreSQL (table rate_limits), shared by every API server behind the load
 * balancer. Fixed windows like the built-in MemoryStore; the database clock is used so servers agree.
 */
export class PgRateLimitStore implements Store {
  localKeys = false;
  private windowMs = 60_000;

  constructor(readonly prefix: string) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const { rows } = await pool.query<{ hits: number; resetAt: Date }>(
      `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, now() + $2 * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
       RETURNING hits, reset_at AS "resetAt"`,
      [this.prefix + key, this.windowMs],
    );
    if (Date.now() - lastCleanup > CLEANUP_EVERY_MS) {
      lastCleanup = Date.now();
      pool.query('DELETE FROM rate_limits WHERE reset_at < now()').catch(() => undefined);
    }
    return { totalHits: rows[0].hits, resetTime: rows[0].resetAt };
  }

  async decrement(key: string): Promise<void> {
    await pool.query('UPDATE rate_limits SET hits = hits - 1 WHERE key = $1 AND hits > 0 AND reset_at > now()', [this.prefix + key]);
  }

  async resetKey(key: string): Promise<void> {
    await pool.query('DELETE FROM rate_limits WHERE key = $1', [this.prefix + key]);
  }
}
