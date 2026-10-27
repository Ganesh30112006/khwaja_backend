import type pg from 'pg';
import { hashPassword } from '../src/lib/password.js';
import { pad } from '../src/lib/validation.js';

/** Sample wards, accounts, voters and payments for the automated tests (never loaded into a real database). */

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ['Ravi', 'Lakshmi', 'Suresh', 'Anitha', 'Mohan', 'Priya', 'Karthik', 'Divya', 'Ganesh', 'Meena', 'Arjun', 'Kavya', 'Rajesh', 'Sita', 'Vijay', 'Pooja', 'Naveen', 'Revathi', 'Prakash', 'Swathi', 'Imran', 'Fathima', 'Joseph', 'Mary'];
const LAST = ['Kumar', 'Reddy', 'Sharma', 'Naidu', 'Rao', 'Patel', 'Iyer', 'Pillai', 'Khan', 'Das', 'Singh', 'Varma', 'Chowdary', 'Nair'];
const STREETS = ['Gandhi Road', 'Market Street', 'Temple Street', 'Lake View Road', 'Station Road', 'Nehru Nagar', 'MG Road'];
const STATUSES = ['Active', 'Active', 'Active', 'Active', 'Active', 'Active', 'Dead', 'Shifted'] as const;

interface SeedAdmin {
  id: string;
  fullName: string;
  mobile: string;
  role: 'SUPER_ADMIN' | 'CORPORATOR' | 'BLO';
  location: string;
  corporatorId: string | null;
  wardIds: string[];
  boothIds: string[];
  status: 'Active' | 'Inactive';
  createdAt: Date;
}

/** Whether a voter location is inside an account's assignment (same rule as lib/admins covers()). */
function coversVoter(admin: SeedAdmin, wardId: string, boothId: string, boothWard: Map<string, string>): boolean {
  if (admin.role === 'SUPER_ADMIN') return true;
  if (!admin.wardIds.includes(wardId)) return false;
  const boothsInWard = admin.boothIds.filter((b) => boothWard.get(b) === wardId);
  return boothsInWard.length === 0 || boothsInWard.includes(boothId);
}

/** Fills an empty, migrated database with demo data. Every account gets `password`. */
export async function seedDemo(db: pg.PoolClient, password: string, now = Date.now()): Promise<void> {
  const rand = mulberry32(20261023);
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(rand() * arr.length)];
  const day = 86400000;
  const ago = (ms: number) => new Date(now - ms);

  const wards = [
    { id: 'W1', number: 1, name: 'Gandhi Nagar' },
    { id: 'W2', number: 2, name: 'Rajiv Colony' },
    { id: 'W3', number: 3, name: 'Old Town' },
    { id: 'W4', number: 4, name: 'Lake View' },
    { id: 'W5', number: 5, name: 'Station Area' },
  ];
  const booths: { id: string; wardId: string; number: number; name: string }[] = [];
  for (const w of wards) {
    for (let b = 1; b <= 3; b++) booths.push({ id: `B${w.number}-${b}`, wardId: w.id, number: w.number * 10 + b, name: `${w.name} Booth ${b}` });
  }
  const boothWard = new Map(booths.map((b) => [b.id, b.wardId]));

  const admins: SeedAdmin[] = [
    { id: 'SA-1', fullName: 'Super Administrator', mobile: '9000000001', role: 'SUPER_ADMIN', location: '', corporatorId: null, wardIds: [], boothIds: [], status: 'Active', createdAt: ago(90 * day) },
    { id: 'C-1', fullName: 'Ramesh Babu', mobile: '9876543210', role: 'CORPORATOR', location: 'Gandhi Nagar, Main Road', corporatorId: null, wardIds: ['W1', 'W2'], boothIds: [], status: 'Active', createdAt: ago(60 * day) },
    { id: 'C-2', fullName: 'Sunitha Devi', mobile: '9876500011', role: 'CORPORATOR', location: 'Old Town, Market Street', corporatorId: null, wardIds: ['W3'], boothIds: [], status: 'Active', createdAt: ago(55 * day) },
    { id: 'C-3', fullName: 'Abdul Rahman', mobile: '9123456780', role: 'CORPORATOR', location: 'Lake View, Temple Street', corporatorId: null, wardIds: ['W4'], boothIds: [], status: 'Active', createdAt: ago(40 * day) },
    { id: 'C-4', fullName: 'Kiran Kumar', mobile: '8098765432', role: 'CORPORATOR', location: 'Station Area', corporatorId: null, wardIds: ['W5'], boothIds: [], status: 'Inactive', createdAt: ago(30 * day) },
    { id: 'C-1-BLO1', fullName: 'Lakshmi Prasad', mobile: '9876543211', role: 'BLO', location: '', corporatorId: 'C-1', wardIds: ['W1'], boothIds: ['B1-1', 'B1-2'], status: 'Active', createdAt: ago(50 * day) },
    { id: 'C-1-BLO2', fullName: 'Venkat Rao', mobile: '9876543212', role: 'BLO', location: '', corporatorId: 'C-1', wardIds: ['W2'], boothIds: [], status: 'Active', createdAt: ago(48 * day) },
    { id: 'C-2-BLO1', fullName: 'Meena Kumari', mobile: '9876500012', role: 'BLO', location: '', corporatorId: 'C-2', wardIds: ['W3'], boothIds: ['B3-1'], status: 'Active', createdAt: ago(45 * day) },
    { id: 'C-3-BLO1', fullName: 'Imran Khan', mobile: '9123456781', role: 'BLO', location: '', corporatorId: 'C-3', wardIds: ['W4'], boothIds: ['B4-1'], status: 'Active', createdAt: ago(35 * day) },
  ];

  const voters: { recordId: string; voterId: string; fullName: string; mobile: string; wardId: string; boothId: string; houseNumber: string; householdId: string; address: string; status: string; createdAt: Date }[] = [];
  const usedVoterIds = new Set<string>();
  let voterSeq = 0;
  let houseSeq = 0;
  for (const booth of booths) {
    const houses = 5 + Math.floor(rand() * 4);
    for (let h = 0; h < houses; h++) {
      houseSeq++;
      const houseNumber = `${booth.number}-${pad(h + 1, 2)}`;
      const householdId = `HH-${pad(houseSeq, 4)}`;
      const last = pick(LAST);
      const address = `${houseNumber}, ${pick(STREETS)}, Ward ${booth.wardId.slice(1)}`;
      const members = 1 + Math.floor(rand() * 4);
      for (let m = 0; m < members; m++) {
        voterSeq++;
        const createdAt = ago((80 - Math.floor(rand() * 20)) * day);
        let voterId: string;
        do voterId = `ABC${pad(Math.floor(rand() * 9_000_000) + 100, 7)}`;
        while (usedVoterIds.has(voterId));
        usedVoterIds.add(voterId);
        voters.push({
          recordId: `VR-${pad(voterSeq, 6)}`,
          voterId,
          fullName: `${pick(FIRST)} ${last}`,
          mobile: rand() < 0.85 ? `${pick(['9', '8', '7', '6'])}${pad(Math.floor(rand() * 1_000_000_000), 9)}` : '',
          wardId: booth.wardId,
          boothId: booth.id,
          houseNumber,
          householdId,
          address,
          status: pick(STATUSES),
          createdAt,
        });
      }
    }
  }

  // Payments recorded by Corporators and BLOs for voters in their own area over the last 30 days.
  const recorders = admins.filter((a) => a.role !== 'SUPER_ADMIN' && a.status === 'Active');
  const received = new Set<string>();
  const txs: { id: string; voter: (typeof voters)[number]; admin: SeedAdmin; receiverName: string; receiverMobile: string; timestamp: Date; cancelled: boolean }[] = [];
  let txnSeq = 0;
  for (let i = 0; i < 70; i++) {
    const admin = pick(recorders);
    const candidates = voters.filter((v) => coversVoter(admin, v.wardId, v.boothId, boothWard) && !received.has(v.recordId));
    if (!candidates.length) continue;
    const voter = pick(candidates);
    received.add(voter.recordId);
    txnSeq++;
    const timestamp = ago(Math.floor(rand() * 30 * day));
    const self = rand() < 0.7;
    const receiverName = self ? voter.fullName : `${pick(FIRST)} ${voter.fullName.split(' ').slice(-1)[0]}`;
    const receiverMobile = voter.mobile && self ? voter.mobile : `9${pad(Math.floor(rand() * 1_000_000_000), 9)}`;
    const cancelled = i % 23 === 7;
    if (cancelled) received.delete(voter.recordId);
    txs.push({ id: `TXN-${pad(txnSeq, 6)}`, voter, admin, receiverName, receiverMobile, timestamp, cancelled });
  }

  const hash = await hashPassword(password);
  for (const w of wards) await db.query('INSERT INTO wards (id, number, name) VALUES ($1, $2, $3)', [w.id, w.number, w.name]);
  for (const b of booths) await db.query('INSERT INTO booths (id, ward_id, number, name) VALUES ($1, $2, $3, $4)', [b.id, b.wardId, b.number, b.name]);
  for (const a of admins) {
    const bloCount = admins.filter((x) => x.corporatorId === a.id).length;
    await db.query(
      `INSERT INTO admins (id, full_name, mobile, role, corporator_id, location, blo_counter, status, password_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [a.id, a.fullName, a.mobile, a.role, a.corporatorId, a.location, bloCount, a.status, hash, a.createdAt],
    );
    await db.query('INSERT INTO admin_wards (admin_id, ward_id) SELECT $1, unnest($2::text[])', [a.id, a.wardIds]);
    await db.query('INSERT INTO admin_booths (admin_id, booth_id) SELECT $1, unnest($2::text[])', [a.id, a.boothIds]);
  }
  for (const v of voters) {
    await db.query(
      `INSERT INTO voters (record_id, voter_id, full_name, ward_id, booth_id, house_number, household_id, address, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [v.recordId, v.voterId, v.fullName, v.wardId, v.boothId, v.houseNumber, v.householdId, v.address, v.status, v.createdAt],
    );
  }
  let auditSeq = 0;
  for (const t of [...txs].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
    await db.query(
      `INSERT INTO payment_transactions (id, voter_record_id, voter_id, voter_name, ward_id, booth_id, amount, receiver_name, receiver_mobile, "timestamp", admin_id, admin_name, status, status_reason, team_id)
       VALUES ($1, $2, $3, $4, $5, $6, 2000, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [t.id, t.voter.recordId, t.voter.voterId, t.voter.fullName, t.voter.wardId, t.voter.boothId, t.receiverName, t.receiverMobile, t.timestamp, t.admin.id, t.admin.fullName,
        t.cancelled ? 'Cancelled' : 'Success', t.cancelled ? 'Entered for wrong voter' : null, t.admin.role === 'CORPORATOR' ? t.admin.id : t.admin.corporatorId],
    );
    auditSeq++;
    await db.query(
      `INSERT INTO audit_logs (id, seq, "timestamp", admin_id, admin_name, action, entity, record_ref, result, summary)
       VALUES ($1, $2, $3, $4, $5, 'Payment recorded', 'Payment', $6, 'Success', $7)`,
      [`AUD-${pad(auditSeq, 6)}`, auditSeq, t.timestamp, t.admin.id, t.admin.fullName, t.id, `₹2,000 to ${t.receiverName} for voter ${t.voter.voterId}`],
    );
  }
  const effectiveDate = new Date(now - 45 * day).toISOString().slice(0, 10);
  await db.query('INSERT INTO payment_settings (id, default_amount, effective_date, allow_amount_override) VALUES (1, 2000, $1, true)', [effectiveDate]);
  await db.query(
    `INSERT INTO settings_history (id, changed_at, changed_by, default_amount, effective_date, summary) VALUES ('CFG-1', $1, 'SA-1', 2000, $2, 'Initial payment amount set to ₹2,000')`,
    [ago(45 * day), effectiveDate],
  );
  const counters: Record<string, number> = { super_admin: 1, corporator: 4, voter: voterSeq, txn: txnSeq, audit: auditSeq, ward: wards.length, booth: booths.length, settings: 1 };
  for (const [name, value] of Object.entries(counters)) await db.query('UPDATE counters SET value = $2 WHERE name = $1', [name, value]);
}
