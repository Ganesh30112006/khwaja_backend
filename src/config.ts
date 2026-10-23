import { existsSync } from 'node:fs';

// Local development reads Backend/.env; in AWS the variables come from the service configuration.
if (existsSync('.env') && process.env.NODE_ENV !== 'test') process.loadEnvFile('.env');

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}`);
  return v;
}

function timeZone(): string {
  const tz = process.env.APP_TIME_ZONE || 'Asia/Kolkata';
  // The zone name is inlined into SQL (AT TIME ZONE '...'), so only accept plain IANA names.
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(tz)) throw new Error(`Invalid APP_TIME_ZONE "${tz}"`);
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }); // throws for an unknown zone
  return tz;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL'),
  /** Require TLS to the database (RDS). Set DATABASE_SSL=false for a local Docker database. */
  databaseSsl: (process.env.DATABASE_SSL ?? 'true') !== 'false',
  /** Comma-separated list of allowed browser origins, e.g. https://main.xxxx.amplifyapp.com */
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Number of proxy hops in front of the app (load balancer = 1), so rate limiting sees the real client IP. */
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  /** Calendar used for date filters, "today" and daily/monthly report groups. */
  timeZone: timeZone(),
  loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT ?? 20),
  /** When set, API requests must carry this value in X-Origin-Verify (added by CloudFront), so the server cannot be called directly. */
  originSecret: process.env.ORIGIN_SECRET ?? '',
};

export const SESSION_HOURS = 8;
export const REMEMBER_DAYS = 7;
