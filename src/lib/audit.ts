import type { Db } from '../db/pool.js';
import { nextNumber } from './ids.js';
import { pad } from './validation.js';

export type AuditEntity = 'Admin' | 'Ward' | 'Booth' | 'Voter' | 'Import' | 'Payment' | 'Settings' | 'Export' | 'Auth';

export interface AuditLog {
  id: string;
  timestamp: string;
  adminId: string;
  adminName: string;
  action: string;
  entity: AuditEntity;
  recordRef: string;
  result: 'Success' | 'Failure';
  summary: string;
}

export const AUDIT_COLUMNS = `id, "timestamp", admin_id AS "adminId", admin_name AS "adminName", action, entity, record_ref AS "recordRef", result, summary`;

/** Appends an audit entry. Call it with the transaction client so it commits or rolls back with the change. */
export async function addAudit(
  db: Db,
  actor: { id: string; fullName: string },
  action: string,
  entity: AuditEntity,
  recordRef: string,
  summary: string,
  result: AuditLog['result'] = 'Success',
): Promise<void> {
  const seq = await nextNumber(db, 'audit');
  await db.query(
    `INSERT INTO audit_logs (id, seq, "timestamp", admin_id, admin_name, action, entity, record_ref, result, summary)
     VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9)`,
    [`AUD-${pad(seq, 6)}`, seq, actor.id, actor.fullName, action, entity, recordRef, result, summary],
  );
}
