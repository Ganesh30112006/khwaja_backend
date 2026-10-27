import { timingSafeEqual } from 'node:crypto';
import compression from 'compression';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { ApiError } from './lib/errors.js';
import { adminsRouter } from './routes/admins.js';
import { approvalsRouter } from './routes/approvals.js';
import { authRouter } from './routes/auth.js';
import { cashRouter } from './routes/cash.js';
import { importsRouter } from './routes/imports.js';
import { paymentsRouter } from './routes/payments.js';
import { reportsRouter } from './routes/reports.js';
import { settingsRouter } from './routes/settings.js';
import { votersRouter } from './routes/voters.js';
import { wardsRouter } from './routes/wards.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(helmet());
  // Large lists and exports are JSON; gzip makes them about 10x smaller over mobile networks.
  app.use(compression());
  // Same-origin deployments need no CORS; otherwise list the frontend origins in CORS_ORIGINS.
  if (config.corsOrigins.length) app.use(cors({ origin: config.corsOrigins, allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Team-Id'] }));
  app.use(express.json({ limit: '1mb' }));

  // Load balancer / Elastic Beanstalk health check (also confirms the database is reachable).
  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  });

  if (config.originSecret) {
    const expected = Buffer.from(config.originSecret);
    app.use('/api', (req, res, next) => {
      const given = Buffer.from(req.get('x-origin-verify') ?? '');
      if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
      res.status(403).json({ message: 'Forbidden.', code: 'FORBIDDEN' });
    });
  }

  const api = express.Router();
  for (const router of [authRouter, adminsRouter, wardsRouter, votersRouter, importsRouter, paymentsRouter, settingsRouter, reportsRouter, cashRouter, approvalsRouter]) api.use(router);
  app.use('/api', api);

  app.use((_req, res) => {
    res.status(404).json({ message: 'Not found.', code: 'NOT_FOUND' });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ApiError) {
      res.status(err.status).json({ message: err.message, code: err.code, fieldErrors: err.fieldErrors });
      return;
    }
    const e = err as { type?: string; status?: number };
    if (e.type === 'entity.parse.failed') {
      res.status(400).json({ message: 'The request body is not valid JSON.', code: 'VALIDATION' });
      return;
    }
    if (e.type === 'entity.too.large') {
      res.status(413).json({ message: 'The request is too large.', code: 'VALIDATION' });
      return;
    }
    console.error(err);
    res.status(500).json({ message: 'Something went wrong on the server. Please try again.' });
  };
  app.use(onError);
  return app;
}
