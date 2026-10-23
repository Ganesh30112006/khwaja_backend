/**
 * One-time setup for a new database: creates the Super Admin (SA-1) and the initial payment settings.
 *
 *   SUPER_ADMIN_NAME="..." SUPER_ADMIN_MOBILE=9xxxxxxxxx SUPER_ADMIN_PASSWORD=... [INITIAL_PAYMENT_AMOUNT=2000] npm run create-super-admin
 *
 * Safe to run again: it does nothing when a Super Admin and settings already exist.
 */
import { pool, withTransaction } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../lib/password.js';
import { today } from '../lib/time.js';
import { formatInr, isValidAmount, isValidIndianMobile, isValidPassword, normalizeMobile, PASSWORD_RULES } from '../lib/validation.js';

function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Set ${name}`);
  return v;
}

const client = await pool.connect();
try {
  await migrate(client, (msg) => console.log(msg));
} finally {
  client.release();
}

try {
  await withTransaction(async (db) => {
    const existing = (await db.query<{ id: string }>(`SELECT id FROM admins WHERE role = 'SUPER_ADMIN'`)).rows[0];
    if (existing) {
      console.log(`Super Admin ${existing.id} already exists; not creating another.`);
    } else {
      const name = env('SUPER_ADMIN_NAME');
      const mobile = env('SUPER_ADMIN_MOBILE');
      const password = env('SUPER_ADMIN_PASSWORD');
      if (name.length < 2) throw new Error('SUPER_ADMIN_NAME is too short');
      if (!isValidIndianMobile(mobile)) throw new Error('SUPER_ADMIN_MOBILE must be a valid 10-digit Indian mobile number');
      if (!isValidPassword(password)) throw new Error(`SUPER_ADMIN_PASSWORD: ${PASSWORD_RULES}`);
      await db.query(
        `INSERT INTO admins (id, full_name, mobile, role, status, password_hash, created_at) VALUES ('SA-1', $1, $2, 'SUPER_ADMIN', 'Active', $3, now())`,
        [name, normalizeMobile(mobile), await hashPassword(password)],
      );
      await db.query(`UPDATE counters SET value = GREATEST(value, 1) WHERE name = 'super_admin'`);
      console.log(`Created Super Admin SA-1 (${name}, ${normalizeMobile(mobile)}).`);
    }
    const settings = (await db.query('SELECT 1 FROM payment_settings WHERE id = 1')).rowCount;
    if (!settings) {
      const amount = Number(process.env.INITIAL_PAYMENT_AMOUNT ?? 2000);
      if (!isValidAmount(amount)) throw new Error('INITIAL_PAYMENT_AMOUNT must be a whole number from 1 to 100000');
      await db.query('INSERT INTO payment_settings (id, default_amount, effective_date, allow_amount_override) VALUES (1, $1, $2, true)', [amount, today()]);
      await db.query(
        `INSERT INTO settings_history (id, changed_at, changed_by, default_amount, effective_date, summary) VALUES ('CFG-1', now(), 'SA-1', $1, $2, $3)`,
        [amount, today(), `Initial payment amount set to ${formatInr(amount)}`],
      );
      await db.query(`UPDATE counters SET value = 1 WHERE name = 'settings'`);
      console.log(`Payment amount set to ${formatInr(amount)} (the Super Admin can change it in Settings).`);
    }
  });
} finally {
  await pool.end();
}
