import { config } from '../config.js';

const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Calendar date (YYYY-MM-DD) of an instant in the app time zone. */
export function localDate(d: Date = new Date()): string {
  return dateFmt.format(d);
}

export function today(): string {
  return localDate(new Date());
}

/** SQL expression for the app-time-zone calendar date of a timestamptz column. */
export function sqlLocalDate(column: string): string {
  return `(${column} AT TIME ZONE '${config.timeZone}')::date`;
}

/** Adds days to a YYYY-MM-DD date. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
