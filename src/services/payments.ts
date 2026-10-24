import type { Db } from '../db/pool.js';
import { today } from '../lib/time.js';

export type TransactionStatus = 'Success' | 'Cancelled' | 'Reversed';

/** A cash payment. `id` is an internal reference (never shown to people) used for details, cancel and retries. */
export interface PaymentTransaction {
  id: string;
  voterRecordId: string;
  voterId: string;
  voterName: string;
  wardId: string;
  boothId: string;
  amount: number;
  receiverName: string;
  receiverMobile: string;
  timestamp: Date;
  adminId: string;
  adminName: string;
  status: TransactionStatus;
  statusReason?: string;
}

/** Payment columns (alias t) in the API shape; statusReason is omitted when empty (see cleanTxn). */
export const TXN_COLUMNS = `t.id, t.voter_record_id AS "voterRecordId", t.voter_id AS "voterId", t.voter_name AS "voterName",
  t.ward_id AS "wardId", COALESCE(t.booth_id, '') AS "boothId", t.amount, t.receiver_name AS "receiverName",
  t.receiver_mobile AS "receiverMobile", t."timestamp", t.admin_id AS "adminId", t.admin_name AS "adminName",
  t.status, t.status_reason AS "statusReason"`;

export const TXN_SELECT = `SELECT ${TXN_COLUMNS} FROM payment_transactions t`;

export function cleanTxn<T extends { statusReason?: string | null }>(t: T): T {
  if (t.statusReason == null) delete t.statusReason;
  return t;
}

/**
 * Corporators and BLOs are never told that Super Admins exist: work a Super Admin did carries no account at all
 * (empty adminId and adminName). Only the Super Admin has a scope covering everything.
 */
export function hideSuperAdmin<T extends { adminId: string; adminName?: string }>(scope: { all: boolean }, row: T): T {
  if (scope.all || !row.adminId.startsWith('SA-')) return row;
  return { ...row, adminId: '', adminName: '' };
}

/** cleanTxn plus hideSuperAdmin, for `.map()` over payments sent to the given viewer. */
export const txnFor =
  (scope: { all: boolean }) =>
  <T extends PaymentTransaction>(t: T): T =>
    hideSuperAdmin(scope, cleanTxn(t));

export interface PaymentSettings {
  defaultAmount: number;
  currency: 'INR';
  effectiveDate: string;
  allowAmountOverride: boolean;
}

export async function loadSettings(db: Db): Promise<PaymentSettings> {
  const { rows } = await db.query<Omit<PaymentSettings, 'currency'>>(
    `SELECT default_amount AS "defaultAmount", effective_date AS "effectiveDate", allow_amount_override AS "allowAmountOverride"
     FROM payment_settings WHERE id = 1`,
  );
  if (!rows[0]) throw new Error('Payment settings are missing. Run the create-super-admin script to initialise the database.');
  return { ...rows[0], currency: 'INR' };
}

/** The most recently saved amount whose effective date has arrived; a future-dated change waits its turn. */
export async function currentAmount(db: Db, settings: PaymentSettings): Promise<number> {
  const { rows } = await db.query<{ amount: number }>(
    'SELECT default_amount AS amount FROM settings_history WHERE effective_date <= $1 ORDER BY changed_at DESC, id COLLATE natural_sort DESC LIMIT 1',
    [today()],
  );
  return rows[0]?.amount ?? settings.defaultAmount;
}
