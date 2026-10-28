import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { pool, withTransaction } from '../db/pool.js';
import { addAudit } from '../lib/audit.js';
import { ApiError, fail } from '../lib/errors.js';
import { str } from '../lib/validation.js';
import { auth, authenticate, requireWardManager } from '../middleware/auth.js';
import { ownsWard } from '../lib/admins.js';
import {
  findVoterByVoterId,
  insertVoter,
  loadLocationRefs,
  parseSerialNumber,
  saveTeamVoter,
  setSerialNumber,
  updateVoter,
  validateVoterInput,
} from '../services/voters.js';

export const importsRouter = Router();
importsRouter.use('/imports', authenticate, requireWardManager);

const MAX_BATCH_ROWS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ImportResult {
  imported: number;
  /** Existing voters whose details were replaced by the file (when the user chose "replace"). */
  replaced: number;
  skipped: number;
  failed: number;
  /** Voters that were kept (not replaced) but got their serial number from the file. */
  serials: number;
  errors: { rowNumber: number; message: string }[];
}

/**
 * Existing voter IDs and household wards so the browser can flag duplicates before uploading. A
 * Corporator gets only its own wards; the server still rejects duplicates of voters elsewhere.
 */
importsRouter.get('/imports/context', async (req, res) => {
  const admin = auth(req).admin;
  const wards = admin.role === 'SUPER_ADMIN' ? null : admin.wardIds;
  const ids = (await pool.query<{ id: string }>(
    'SELECT upper(voter_id) AS id FROM voters WHERE $1::text[] IS NULL OR ward_id = ANY($1) ORDER BY record_id',
    [wards],
  )).rows;
  const households = (await pool.query<{ key: string; wardId: string }>(
    `SELECT DISTINCT ON (upper(household_id)) upper(household_id) AS key, ward_id AS "wardId"
     FROM voters WHERE household_id <> '' AND ($1::text[] IS NULL OR ward_id = ANY($1)) ORDER BY upper(household_id), record_id DESC`,
    [wards],
  )).rows;
  res.json({ existingVoterIds: ids.map((r) => r.id), households: households.map((h) => [h.key, h.wardId]) });
});

importsRouter.post('/imports', async (req, res) => {
  const { admin } = auth(req);
  const fileName = str(req.body?.fileName).trim().slice(0, 255) || 'import';
  const importId = randomUUID();
  // Abandoned imports are cleared after a day.
  await pool.query(`DELETE FROM import_jobs WHERE created_at < now() - interval '1 day'`);
  await pool.query('INSERT INTO import_jobs (id, admin_id, file_name) VALUES ($1, $2, $3)', [importId, admin.id, fileName]);
  res.status(201).json({ importId });
});

async function findJob(id: string, adminId: string, message: string) {
  const job = UUID.test(id)
    ? (await pool.query<{ fileName: string; imported: number; skipped: number; failed: number; errors: ImportResult['errors'] }>(
        'SELECT file_name AS "fileName", imported, skipped, failed, errors FROM import_jobs WHERE id = $1 AND admin_id = $2',
        [id, adminId],
      )).rows[0]
    : undefined;
  if (!job) fail(404, 'NOT_FOUND', message);
  return job;
}

/**
 * Re-validates and saves each row on its own. New voters join the shared ward list (every Corporator of the ward
 * gets them). A row whose Voter ID already exists is skipped, unless the user chose to replace existing voters
 * (`replace: true`): then a Corporator's file replaces that voter's details for its own team only, and the Super
 * Admin's file replaces the shared details (payments stay with the voter). Corporators can only import into, and
 * replace voters in, their own wards. Any other problem fails that row.
 *
 * The serial number comes from the roll and is shared, so it is set from the file for every team, also for an
 * existing voter the user chose to keep (`keep: true`: only the serial number is used, and only when the voter is
 * in the caller's wards and in the same ward as the row).
 */
importsRouter.post('/imports/:id/rows', async (req, res) => {
  const { admin } = auth(req);
  const team = admin.role === 'CORPORATOR' ? admin.id : null;
  await findJob(str(req.params.id), admin.id, 'Import session not found. Start the import again.');
  const wardNumbers = new Map((await pool.query<{ id: string; number: number }>('SELECT id, number FROM wards')).rows.map((w) => [w.id, w.number]));
  const rows: unknown[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length > MAX_BATCH_ROWS) fail(400, 'VALIDATION', `Send at most ${MAX_BATCH_ROWS} rows per batch.`);
  const refs = await loadLocationRefs(pool);
  const result: ImportResult = { imported: 0, replaced: 0, skipped: 0, failed: 0, serials: 0, errors: [] };
  for (const raw of rows) {
    const row = (raw ?? {}) as { rowNumber?: unknown; voter?: unknown; replace?: unknown; keep?: unknown };
    const rowNumber = Number.isInteger(row.rowNumber) ? (row.rowNumber as number) : 0;
    const body = (row.voter ?? {}) as Record<string, unknown>;
    if (row.keep === true) {
      const filled = await withTransaction(async (db) => {
        const kept = await findVoterByVoterId(db, str(body.voterId), true, team);
        const serial = parseSerialNumber(body.serialNumber);
        if (!kept || !ownsWard(admin, kept.wardId) || kept.wardId !== str(body.wardId) || serial === null || Number.isNaN(serial)) return false;
        return setSerialNumber(db, kept.recordId, serial);
      });
      result.skipped++;
      if (filled) result.serials++;
      continue;
    }
    try {
      const outcome = await withTransaction(async (db) => {
        const existing = row.replace === true ? await findVoterByVoterId(db, String(body.voterId ?? ''), true, team) : undefined;
        if (existing && !ownsWard(admin, existing.wardId)) {
          fail(403, 'FORBIDDEN', 'This Voter ID belongs to a voter outside your wards.');
        }
        const input = await validateVoterInput(db, refs, body, existing?.recordId);
        if (!ownsWard(admin, input.wardId)) fail(403, 'FORBIDDEN', `Ward ${wardNumbers.get(input.wardId) ?? '?'} is not assigned to you.`);
        if (existing) {
          // A file without serial numbers keeps the voter's own.
          if (input.serialNumber === null) input.serialNumber = existing.serialNumber;
          if (team) {
            await saveTeamVoter(db, team, existing, input);
            if (input.serialNumber !== null) await setSerialNumber(db, existing.recordId, input.serialNumber);
          } else {
            await updateVoter(db, existing.recordId, input);
          }
          return 'replaced' as const;
        }
        await insertVoter(db, input);
        return 'imported' as const;
      });
      result[outcome]++;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'CONFLICT') result.skipped++;
      else result.failed++;
      result.errors.push({ rowNumber, message: err.fieldErrors ? Object.values(err.fieldErrors).join('; ') : err.message });
    }
  }
  await pool.query(
    'UPDATE import_jobs SET imported = imported + $2, replaced = replaced + $3, skipped = skipped + $4, failed = failed + $5, serials = serials + $6, errors = errors || $7::jsonb WHERE id = $1',
    [str(req.params.id), result.imported, result.replaced, result.skipped, result.failed, result.serials, JSON.stringify(result.errors)],
  );
  res.json(result);
});

importsRouter.post('/imports/:id/complete', async (req, res) => {
  const { admin } = auth(req);
  const skippedBefore = Math.max(0, Math.floor(Number(req.body?.skippedBeforeUpload)) || 0);
  const total = await withTransaction(async (db) => {
    const job = UUID.test(str(req.params.id))
      ? (await db.query<{ fileName: string; imported: number; replaced: number; skipped: number; failed: number; serials: number; errors: ImportResult['errors'] }>(
          'DELETE FROM import_jobs WHERE id = $1 AND admin_id = $2 RETURNING file_name AS "fileName", imported, replaced, skipped, failed, serials, errors',
          [str(req.params.id), admin.id],
        )).rows[0]
      : undefined;
    if (!job) fail(404, 'NOT_FOUND', 'Import session not found.');
    const result: ImportResult = {
      imported: job.imported,
      replaced: job.replaced,
      skipped: job.skipped + skippedBefore,
      failed: job.failed,
      serials: job.serials,
      errors: job.errors,
    };
    await addAudit(
      db,
      admin,
      'Voters imported',
      'Import',
      job.fileName,
      `${result.imported} imported, ${result.replaced} replaced, ${result.skipped} skipped, ${result.failed} failed` +
        (result.serials ? `, ${result.serials} serial numbers filled` : ''),
      result.imported > 0 || result.replaced > 0 || result.failed === 0 ? 'Success' : 'Failure',
    );
    return result;
  });
  res.json(total);
});
