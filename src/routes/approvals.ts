import { Router } from 'express';
import { Params, pool, withTransaction, type Db } from '../db/pool.js';
import { covers, coversSql, ownsWard } from '../lib/admins.js';
import { addAudit } from '../lib/audit.js';
import { fail } from '../lib/errors.js';
import { str } from '../lib/validation.js';
import { auth, authenticate, requireWardManager } from '../middleware/auth.js';
import { loadVoter, votersView } from '../services/voters.js';

export const approvalsRouter = Router();

export type ShiftedApproval = 'Pending' | 'Approved' | 'Rejected';

/** A team's latest permission state for each voter (only voters with a row are returned). */
export async function shiftedApprovals(db: Db, recordIds: string[], teamId: string): Promise<Map<string, ShiftedApproval>> {
  if (!recordIds.length) return new Map();
  const { rows } = await db.query<{ id: string; status: ShiftedApproval }>(
    'SELECT voter_record_id AS id, status FROM shifted_approvals WHERE voter_record_id = ANY($1) AND team_id = $2',
    [recordIds, teamId],
  );
  return new Map(rows.map((r) => [r.id, r.status]));
}

/** Whether this voter (Shifted) may be paid by the team's BLOs. */
export async function isShiftedApproved(db: Db, recordId: string, teamId: string): Promise<boolean> {
  return (await shiftedApprovals(db, [recordId], teamId)).get(recordId) === 'Approved';
}

async function hasPayment(db: Db, recordId: string, teamId: string): Promise<boolean> {
  return !!(await db.query(`SELECT 1 FROM payment_transactions WHERE voter_record_id = $1 AND status = 'Success' AND team_id = $2`, [recordId, teamId])).rowCount;
}

/**
 * The team's permission requests for Shifted voters in the caller's area: a Corporator sees its wards, a BLO the
 * voters it covers, the Super Admin every team's (or the team it is viewing). Who decided is never returned (it
 * may be a Super Admin). Status is the team's own view of the voter.
 */
approvalsRouter.get('/shifted-approvals', authenticate, async (req, res) => {
  const { scope } = auth(req);
  const p = new Params();
  const where = [coversSql(scope, (v) => p.add(v), 'v.ward_id', 'v.booth_id'), `v.status = 'Shifted'`, 'NOT v.hidden'];
  if (scope.teamId) where.push(`a.team_id = ${p.add(scope.teamId)}`);
  const status = str(req.query.status);
  if (status === 'Pending' || status === 'Approved' || status === 'Rejected') where.push(`a.status = ${p.add(status)}`);
  const { rows } = await pool.query(
    `SELECT v.record_id AS "recordId", v.voter_id AS "voterId", v.full_name AS "fullName", v.ward_id AS "wardId",
       COALESCE(v.booth_id, '') AS "boothId", v.house_number AS "houseNumber", a.status,
       COALESCE(a.requested_by, '') AS "requestedBy", a.requested_at AS "requestedAt", a.decided_at AS "decidedAt"
     FROM shifted_approvals a JOIN LATERAL ${votersView('a.team_id')} v ON v.record_id = a.voter_record_id
     WHERE ${where.join(' AND ')}
       AND NOT EXISTS (SELECT 1 FROM payment_transactions t WHERE t.voter_record_id = v.record_id AND t.status = 'Success' AND t.team_id = a.team_id)
     ORDER BY a.requested_at DESC NULLS LAST, v.voter_id
     LIMIT 500`,
    p.values,
  );
  res.json(rows);
});

/** A BLO asks its Corporator for permission to pay a Shifted voter. */
approvalsRouter.post('/voters/:recordId/shifted-approval/request', authenticate, async (req, res) => {
  const { admin, scope } = auth(req);
  if (admin.role !== 'BLO') fail(403, 'FORBIDDEN', 'Only BLOs need to ask for permission.');
  const team = admin.corporatorId!;
  const status = await withTransaction(async (db) => {
    const voter = await loadVoter(db, str(req.params.recordId), true, team);
    if (!covers(scope, voter)) fail(404, 'NOT_FOUND', 'Voter not found.');
    if (voter.status !== 'Shifted') fail(409, 'CONFLICT', 'Permission is only needed for Shifted voters.');
    if (await hasPayment(db, voter.recordId, team)) fail(409, 'CONFLICT', 'This voter has already received a payment.');
    const current = (await shiftedApprovals(db, [voter.recordId], team)).get(voter.recordId);
    if (current === 'Approved' || current === 'Pending') return current;
    await db.query(
      `INSERT INTO shifted_approvals (voter_record_id, team_id, status, requested_by, requested_at) VALUES ($1, $3, 'Pending', $2, now())
       ON CONFLICT (voter_record_id, team_id) DO UPDATE SET status = 'Pending', requested_by = $2, requested_at = now(), decided_by = NULL, decided_at = NULL`,
      [voter.recordId, admin.id, team],
    );
    await addAudit(db, admin, 'Shifted payment permission requested', 'Voter', voter.voterId, `${voter.fullName} (Shifted)`);
    return 'Pending';
  });
  res.json({ recordId: str(req.params.recordId), status });
});

/**
 * A Corporator allows or refuses its BLOs paying a Shifted voter. A Super Admin can decide for the team it is
 * viewing.
 */
approvalsRouter.post('/voters/:recordId/shifted-approval', authenticate, requireWardManager, async (req, res) => {
  const { admin, scope } = auth(req);
  const decision = req.body?.decision;
  if (decision !== 'Approved' && decision !== 'Rejected') fail(400, 'VALIDATION', 'Choose Approved or Rejected.', { decision: 'Choose Approved or Rejected' });
  const team = scope.teamId;
  if (!team) fail(400, 'VALIDATION', 'Choose which Corporator to view first.');
  await withTransaction(async (db) => {
    const voter = await loadVoter(db, str(req.params.recordId), true, team);
    if (!ownsWard(admin, voter.wardId)) fail(404, 'NOT_FOUND', 'Voter not found.');
    if (voter.status !== 'Shifted') fail(409, 'CONFLICT', 'Permission is only needed for Shifted voters.');
    await db.query(
      `INSERT INTO shifted_approvals (voter_record_id, team_id, status, decided_by, decided_at) VALUES ($1, $4, $2, $3, now())
       ON CONFLICT (voter_record_id, team_id) DO UPDATE SET status = $2, decided_by = $3, decided_at = now()`,
      [voter.recordId, decision, admin.id, team],
    );
    await addAudit(db, admin, decision === 'Approved' ? 'Shifted payment approved' : 'Shifted payment rejected', 'Voter', voter.voterId, `${voter.fullName} (Shifted)`);
  });
  res.json({ recordId: str(req.params.recordId), status: decision });
});
