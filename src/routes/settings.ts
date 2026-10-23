import { Router } from 'express';
import { pool, withTransaction, type Db } from '../db/pool.js';
import { addAudit } from '../lib/audit.js';
import { fail } from '../lib/errors.js';
import { nextNumber } from '../lib/ids.js';
import { formatInr, isValidAmount, isValidDate } from '../lib/validation.js';
import { auth, authenticate, requireSuper } from '../middleware/auth.js';
import { currentAmount, loadSettings } from '../services/payments.js';

export const settingsRouter = Router();
settingsRouter.use('/settings', authenticate, requireSuper);

async function settingsResponse(db: Db) {
  const settings = await loadSettings(db);
  const history = (await db.query(
    `SELECT id, changed_at AS "changedAt", changed_by AS "changedBy", default_amount AS "defaultAmount", effective_date AS "effectiveDate", summary
     FROM settings_history ORDER BY changed_at DESC, id COLLATE natural_sort DESC`,
  )).rows;
  return { settings, history, currentAmount: await currentAmount(db, settings) };
}

settingsRouter.get('/settings/payment', async (_req, res) => {
  res.json(await settingsResponse(pool));
});

/** Changes apply to new payments only; past payments keep their amount. */
settingsRouter.put('/settings/payment', async (req, res) => {
  const actor = auth(req).admin;
  const amount = Number(req.body?.defaultAmount);
  if (!isValidAmount(amount)) fail(400, 'VALIDATION', 'Enter a valid amount.', { defaultAmount: 'Enter a whole amount between ₹1 and ₹1,00,000' });
  const effectiveDate = req.body?.effectiveDate;
  if (!isValidDate(effectiveDate)) fail(400, 'VALIDATION', 'Enter a valid date.', { effectiveDate: 'Enter a valid date' });
  const allowAmountOverride = req.body?.allowAmountOverride === true;
  const result = await withTransaction(async (db) => {
    await db.query('SELECT 1 FROM payment_settings WHERE id = 1 FOR UPDATE');
    const prev = await loadSettings(db);
    const changes: string[] = [];
    if (prev.defaultAmount !== amount) changes.push(`amount ${formatInr(prev.defaultAmount)} → ${formatInr(amount)}`);
    if (prev.effectiveDate !== effectiveDate) changes.push(`effective ${effectiveDate}`);
    if (prev.allowAmountOverride !== allowAmountOverride) changes.push(`amount changes ${allowAmountOverride ? 'allowed' : 'locked'}`);
    if (changes.length) {
      await db.query('UPDATE payment_settings SET default_amount = $1, effective_date = $2, allow_amount_override = $3 WHERE id = 1', [amount, effectiveDate, allowAmountOverride]);
      if (prev.defaultAmount !== amount || prev.effectiveDate !== effectiveDate) {
        const n = await nextNumber(db, 'settings');
        await db.query(
          'INSERT INTO settings_history (id, changed_at, changed_by, default_amount, effective_date, summary) VALUES ($1, now(), $2, $3, $4, $5)',
          [`CFG-${n}`, actor.id, amount, effectiveDate, changes.join('; ')],
        );
      }
      await addAudit(db, actor, 'Payment settings changed', 'Settings', 'payment-settings', changes.join('; '));
    }
    return settingsResponse(db);
  });
  res.json(result);
});
