import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { pool, withTransaction } from '../db/pool.js';
import { addAudit } from '../lib/audit.js';
import { ApiError, fail } from '../lib/errors.js';
import { str } from '../lib/validation.js';
import { auth, authenticate, requireSuper } from '../middleware/auth.js';
import { insertVoter, loadLocationRefs, validateVoterInput } from '../services/voters.js';

export const importsRouter = Router();
importsRouter.use('/imports', authenticate, requireSuper);

const MAX_BATCH_ROWS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  errors: { rowNumber: number; message: string }[];
}

/** Existing voter IDs and household wards so the browser can flag duplicates before uploading. */
importsRouter.get('/imports/context', async (_req, res) => {
  const ids = (await pool.query<{ id: string }>('SELECT upper(voter_id) AS id FROM voters ORDER BY record_id')).rows;
  const households = (await pool.query<{ key: string; wardId: string }>(
    `SELECT DISTINCT ON (upper(household_id)) upper(household_id) AS key, ward_id AS "wardId"
     FROM voters WHERE household_id <> '' ORDER BY upper(household_id), record_id DESC`,
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

/** Re-validates and inserts each row on its own: a duplicate Voter ID is skipped, any other problem fails that row. */
importsRouter.post('/imports/:id/rows', async (req, res) => {
  const { admin } = auth(req);
  await findJob(str(req.params.id), admin.id, 'Import session not found. Start the import again.');
  const rows: unknown[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rows.length > MAX_BATCH_ROWS) fail(400, 'VALIDATION', `Send at most ${MAX_BATCH_ROWS} rows per batch.`);
  const refs = await loadLocationRefs(pool);
  const result: ImportResult = { imported: 0, skipped: 0, failed: 0, errors: [] };
  for (const raw of rows) {
    const row = (raw ?? {}) as { rowNumber?: unknown; voter?: unknown };
    const rowNumber = Number.isInteger(row.rowNumber) ? (row.rowNumber as number) : 0;
    try {
      await withTransaction(async (db) => {
        const input = await validateVoterInput(db, refs, (row.voter ?? {}) as Record<string, unknown>);
        await insertVoter(db, input);
      });
      result.imported++;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'CONFLICT') result.skipped++;
      else result.failed++;
      result.errors.push({ rowNumber, message: err.fieldErrors ? Object.values(err.fieldErrors).join('; ') : err.message });
    }
  }
  await pool.query(
    'UPDATE import_jobs SET imported = imported + $2, skipped = skipped + $3, failed = failed + $4, errors = errors || $5::jsonb WHERE id = $1',
    [str(req.params.id), result.imported, result.skipped, result.failed, JSON.stringify(result.errors)],
  );
  res.json(result);
});

importsRouter.post('/imports/:id/complete', async (req, res) => {
  const { admin } = auth(req);
  const skippedBefore = Math.max(0, Math.floor(Number(req.body?.skippedBeforeUpload)) || 0);
  const total = await withTransaction(async (db) => {
    const job = UUID.test(str(req.params.id))
      ? (await db.query<{ fileName: string; imported: number; skipped: number; failed: number; errors: ImportResult['errors'] }>(
          'DELETE FROM import_jobs WHERE id = $1 AND admin_id = $2 RETURNING file_name AS "fileName", imported, skipped, failed, errors',
          [str(req.params.id), admin.id],
        )).rows[0]
      : undefined;
    if (!job) fail(404, 'NOT_FOUND', 'Import session not found.');
    const result: ImportResult = { imported: job.imported, skipped: job.skipped + skippedBefore, failed: job.failed, errors: job.errors };
    await addAudit(
      db,
      admin,
      'Voters imported',
      'Import',
      job.fileName,
      `${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed`,
      result.imported > 0 || result.failed === 0 ? 'Success' : 'Failure',
    );
    return result;
  });
  res.json(total);
});
