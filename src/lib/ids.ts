import type { Db } from '../db/pool.js';

export type CounterName = 'super_admin' | 'corporator' | 'voter' | 'txn' | 'audit' | 'ward' | 'booth' | 'settings';

/**
 * Next value of a gapless counter. The row stays locked until the surrounding transaction ends,
 * so numbers are never reused and a rolled-back request does not leave a gap.
 */
export async function nextNumber(db: Db, name: CounterName): Promise<number> {
  const { rows } = await db.query<{ value: number }>('UPDATE counters SET value = value + 1 WHERE name = $1 RETURNING value', [name]);
  return rows[0].value;
}
