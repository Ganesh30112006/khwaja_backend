/** Validation rules shared with the frontend (Frontend/src/utils/validation.ts). */

export const VOTER_STATUSES = ['Active', 'Not Active', 'Shifted'] as const;
export type VoterStatus = (typeof VOTER_STATUSES)[number];

/** '' when the roll does not say. */
export const GENDERS = ['Male', 'Female', 'Other'] as const;
export type Gender = (typeof GENDERS)[number] | '';

export const MAX_DONATION_AMOUNT = 100000;
export const PASSWORD_RULES = 'At least 8 characters with letters and numbers';
export const HOUSEHOLD_ID_PATTERN = /^[A-Za-z0-9\-/]+$/;

/** Strips spaces/dashes and a leading +91, 91 or 0 from an Indian mobile number. */
export function normalizeMobile(raw: string): string {
  let v = (raw ?? '').replace(/[\s\-()]/g, '');
  if (v.startsWith('+91')) v = v.slice(3);
  else if (v.length === 12 && v.startsWith('91')) v = v.slice(2);
  else if (v.length === 11 && v.startsWith('0')) v = v.slice(1);
  return v;
}

export function isValidIndianMobile(raw: string): boolean {
  return /^[6-9]\d{9}$/.test(normalizeMobile(raw));
}

export function isValidPassword(p: unknown): p is string {
  return typeof p === 'string' && p.length >= 8 && p.length <= 64 && /[A-Za-z]/.test(p) && /\d/.test(p);
}

export function isValidAmount(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= MAX_DONATION_AMOUNT;
}

/** A real calendar date in YYYY-MM-DD form. */
export function isValidDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Request values arrive untyped: treat anything that is not a string as empty. */
export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function strArray(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string'))] : [];
}

/** Escapes LIKE wildcards so user search text is matched literally. */
export function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function formatInr(n: number): string {
  return `₹${n.toLocaleString('en-IN')}`;
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
