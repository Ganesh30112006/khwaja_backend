import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { BLO_MOBILE, C1_MOBILE, C2_MOBILE, call, expectStatus, login, PASSWORD, resetDb, SUPER_MOBILE } from './helpers.js';

beforeEach(resetDb);

interface VoterRow {
  recordId: string;
  voterId: string;
  fullName: string;
  mobile: string;
  wardId: string;
  boothId: string;
  householdId: string;
  status: string;
  houseNumber: string;
  address: string;
}

async function voters(token: string, query: Record<string, unknown> = {}): Promise<VoterRow[]> {
  return (await expectStatus(call('get', '/voters', token, undefined, { pageSize: 500, ...query }), 200)).items;
}

/** A voter (visible to this account) who has not received a payment yet. */
async function notReceivedVoter(token: string, query: Record<string, unknown> = {}): Promise<VoterRow> {
  return (await voters(token, { paymentStatus: 'Not Received', ...query }))[0];
}

const pay = (voterRecordId: string, idempotencyKey: string) => ({ voterRecordId, amount: 2000, receiverName: 'Ravi', receiverMobile: '9123412345', idempotencyKey });

describe('authentication', () => {
  it('logs in with a mobile number (any format) or the full name', async () => {
    const r = await expectStatus(call('post', '/auth/login', null, { identifier: `+91 ${C1_MOBILE}`, password: PASSWORD }), 200);
    expect(r.admin).toMatchObject({ id: 'C-1', role: 'CORPORATOR', location: 'Gandhi Nagar, Main Road' });
    expect(r.token).toBeTruthy();
    const byName = await expectStatus(call('post', '/auth/login', null, { identifier: '  lakshmi   PRASAD ', password: PASSWORD }), 200);
    expect(byName.admin).toMatchObject({ id: 'C-1-BLO1', corporatorId: 'C-1', boothIds: ['B1-1', 'B1-2'] });
  });

  it('rejects wrong passwords, unknown names and deactivated accounts', async () => {
    expect((await expectStatus(call('post', '/auth/login', null, { identifier: C1_MOBILE, password: 'wrong' }), 401)).code).toBe('INVALID_CREDENTIALS');
    await expectStatus(call('post', '/auth/login', null, { identifier: 'Nobody Here', password: PASSWORD }), 401);
    await expectStatus(call('post', '/auth/login', null, { identifier: '8098765432', password: PASSWORD }), 403); // C-4 is inactive
    const audit = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'Login failed' AND admin_id = 'C-1'`);
    expect(audit.rowCount).toBe(1);
  });

  it('rejects missing or unknown tokens and never stores raw tokens', async () => {
    expect((await expectStatus(call('get', '/auth/me', null), 401)).code).toBe('SESSION_EXPIRED');
    await expectStatus(call('get', '/auth/me', 'nope'), 401);
    const token = await login(C1_MOBILE);
    expect((await pool.query('SELECT 1 FROM sessions WHERE token_hash = $1', [token])).rowCount).toBe(0);
    await expectStatus(call('get', '/auth/me', token), 200);
    await expectStatus(call('post', '/auth/logout', token), 204);
    await expectStatus(call('get', '/auth/me', token), 401);
  });

  it('lists and revokes the current account sessions only', async () => {
    const a = await login(C1_MOBILE);
    const b = await login(C1_MOBILE);
    await login(C2_MOBILE);
    const sessions = await expectStatus(call('get', '/auth/sessions', a), 200);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expect(sessions[0].token).toBeUndefined();
    const other = sessions.find((s: { current: boolean }) => !s.current);
    await expectStatus(call('delete', `/auth/sessions/${other.id}`, a), 204);
    await expectStatus(call('get', '/auth/me', b), 401);
    const mine = sessions.find((s: { current: boolean }) => s.current);
    await expectStatus(call('delete', `/auth/sessions/${mine.id}`, a), 400);
    expect((await expectStatus(call('post', '/auth/sessions/revoke-others', a), 200)).revoked).toBe(0);
  });

  it('same names are told apart by password, and a name + password pair cannot repeat', async () => {
    const sa = await login(SUPER_MOBILE);
    const base = { fullName: 'Ravi Kumar', wardIds: ['W1'], boothIds: [], role: 'CORPORATOR' };
    const first = await expectStatus(call('post', '/admins', sa, { ...base, mobile: '9988776601', password: 'firstPass1' }), 201);
    const second = await expectStatus(call('post', '/admins', sa, { ...base, mobile: '9988776602', password: 'secondPass2' }), 201);
    expect((await expectStatus(call('post', '/auth/login', null, { identifier: 'Ravi Kumar', password: 'firstPass1' }), 200)).admin.id).toBe(first.id);
    expect((await expectStatus(call('post', '/auth/login', null, { identifier: 'ravi kumar', password: 'secondPass2' }), 200)).admin.id).toBe(second.id);
    const dup = await expectStatus(call('post', '/admins', sa, { ...base, mobile: '9988776603', password: 'firstPass1' }), 400);
    expect(dup.fieldErrors.password).toMatch(/already uses this password/);
    await expectStatus(call('put', `/admins/${second.id}/password`, sa, { password: 'firstPass1' }), 400);
    const token = await login('9988776602', 'secondPass2');
    const change = await expectStatus(call('post', '/auth/change-password', token, { currentPassword: 'secondPass2', newPassword: 'firstPass1' }), 400);
    expect(change.fieldErrors.newPassword).toBeDefined();
    await expectStatus(call('post', '/admins', sa, { ...base, fullName: 'Ravi Teja', mobile: '9988776604', password: 'firstPass1' }), 201);
  });

  it('asks for the mobile number when a rename makes name + password ambiguous', async () => {
    const sa = await login(SUPER_MOBILE);
    // C-2 and C-3 share the seed password; renaming C-3 to C-2's name makes the pair ambiguous.
    await expectStatus(call('put', '/admins/C-3', sa, { fullName: 'Sunitha Devi', mobile: '9123456780', wardIds: ['W4'], boothIds: [], location: '' }), 200);
    const r = await expectStatus(call('post', '/auth/login', null, { identifier: 'Sunitha Devi', password: PASSWORD }), 401);
    expect(r.message).toMatch(/mobile number/);
    expect((await expectStatus(call('post', '/auth/login', null, { identifier: '9123456780', password: PASSWORD }), 200)).admin.id).toBe('C-3');
  });
});

describe('payments', () => {
  it('records the payment with server data and marks the voter Received', async () => {
    const token = await login(C1_MOBILE);
    const voter = await notReceivedVoter(token);
    const before = Date.now();
    const tx = await expectStatus(call('post', '/payments', token, { ...pay(voter.recordId, 'k1'), receiverName: 'Someone Else', receiverMobile: '+91 91234 12345' }), 201);
    expect(tx).toMatchObject({ adminId: 'C-1', adminName: 'Ramesh Babu', receiverMobile: '9123412345', status: 'Success', amount: 2000 });
    expect(new Date(tx.timestamp).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(tx.statusReason).toBeUndefined();
    const detail = await expectStatus(call('get', `/voters/${voter.recordId}`, token), 200);
    expect(detail.voter).toMatchObject({ paymentStatus: 'Received', canRecordPayment: false, fullName: voter.fullName, mobile: voter.mobile, status: voter.status });
    expect(detail.voter.latestPayment.receiverName).toBe('Someone Else');
    expect(detail.transactions).toHaveLength(1);
  });

  it('blocks a second payment to the same voter, also when two requests race', async () => {
    const token = await login(C1_MOBILE);
    const voter = await notReceivedVoter(token);
    const results = await Promise.all([1, 2, 3, 4].map((n) => call('post', '/payments', token, pay(voter.recordId, `race-${n}`))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect((await pool.query(`SELECT 1 FROM payment_transactions WHERE voter_record_id = $1 AND status = 'Success'`, [voter.recordId])).rowCount).toBe(1);
  });

  it('returns the original payment when a request is retried, even concurrently', async () => {
    const token = await login(C1_MOBILE);
    const voter = await notReceivedVoter(token);
    const [a, b] = await Promise.all([call('post', '/payments', token, pay(voter.recordId, 'same')), call('post', '/payments', token, pay(voter.recordId, 'same'))]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    const viaHeader = await call('post', '/payments', token, pay(voter.recordId, '')).set('Idempotency-Key', 'same');
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body.id).toBe(a.body.id);
    expect((await expectStatus(call('get', `/voters/${voter.recordId}`, token), 200)).transactions).toHaveLength(1);
  });

  it('one person may receive for every member of a household', async () => {
    const sa = await login(SUPER_MOBILE);
    const list = await voters(sa, { paymentStatus: 'Not Received' });
    const byHousehold = new Map<string, VoterRow[]>();
    for (const v of list) byHousehold.set(v.householdId, [...(byHousehold.get(v.householdId) ?? []), v]);
    const members = [...byHousehold.values()].find((m) => m.length >= 2)!;
    for (const [i, m] of members.entries()) {
      await expectStatus(call('post', '/payments', sa, { ...pay(m.recordId, `hh-${i}`), receiverName: 'Head of Family', receiverMobile: '9123412345' }), 201);
    }
    await expectStatus(call('post', '/payments', sa, { ...pay(members[0].recordId, 'hh-again'), receiverName: 'Head of Family' }), 409);
  });

  it('Corporators and BLOs cannot see or pay voters outside their area', async () => {
    const sa = await login(SUPER_MOBILE);
    const inW5 = await notReceivedVoter(sa, { wardId: 'W5' });
    const inB13 = await notReceivedVoter(sa, { boothId: 'B1-3' });
    const c1 = await login(C1_MOBILE);
    await expectStatus(call('get', `/voters/${inW5.recordId}`, c1), 404);
    expect((await expectStatus(call('post', '/payments', c1, pay(inW5.recordId, 'x')), 403)).code).toBe('FORBIDDEN');
    expect((await expectStatus(call('get', `/voters/${inB13.recordId}`, c1), 200)).voter.canRecordPayment).toBe(true);
    const blo = await login(BLO_MOBILE);
    await expectStatus(call('get', `/voters/${inB13.recordId}`, blo), 404);
    await expectStatus(call('post', '/payments', blo, pay(inB13.recordId, 'y')), 403);
  });

  it('payment history, details and exports follow the same area', async () => {
    const blo = await login(BLO_MOBILE);
    const mine = (await expectStatus(call('get', '/payments', blo, undefined, { pageSize: 500 }), 200)).items;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t: VoterRow) => t.wardId === 'W1' && ['B1-1', 'B1-2'].includes(t.boothId))).toBe(true);
    const sa = await login(SUPER_MOBILE);
    const all = (await expectStatus(call('get', '/payments', sa, undefined, { pageSize: 500 }), 200)).items;
    const outside = all.find((t: VoterRow) => t.wardId !== 'W1');
    await expectStatus(call('get', `/payments/${outside.id}`, blo), 404);
    const exported = await expectStatus(call('get', '/payments/export', blo), 200);
    expect(exported).toHaveLength(mine.length);
    // The Super Admin-only "recorded by" filter is ignored for others.
    const filtered = (await expectStatus(call('get', '/payments', blo, undefined, { adminId: 'C-2', pageSize: 500 }), 200)).items;
    expect(filtered).toHaveLength(mine.length);
  });

  it('cancelled payments do not count, and the voter can receive again', async () => {
    const sa = await login(SUPER_MOBILE);
    const voter = await notReceivedVoter(sa);
    const tx = await expectStatus(call('post', '/payments', sa, pay(voter.recordId, 'c1')), 201);
    await expectStatus(call('post', `/payments/${tx.id}/cancel`, sa, { kind: 'Cancelled', reason: 'x' }), 400);
    const cancelled = await expectStatus(call('post', `/payments/${tx.id}/cancel`, sa, { kind: 'Cancelled', reason: 'Wrong voter' }), 200);
    expect(cancelled).toMatchObject({ status: 'Cancelled', statusReason: 'Wrong voter' });
    await expectStatus(call('post', `/payments/${tx.id}/cancel`, sa, { kind: 'Reversed', reason: 'Again' }), 409);
    expect((await expectStatus(call('get', `/voters/${voter.recordId}`, sa), 200)).voter.paymentStatus).toBe('Not Received');
    await expectStatus(call('post', '/payments', sa, pay(voter.recordId, 'c2')), 201);
    const detail = await expectStatus(call('get', `/payments/${tx.id}`, sa), 200);
    expect(detail.audit.map((a: { action: string }) => a.action)).toEqual(['Payment cancelled', 'Payment recorded']);
  });

  it('only the Super Admin can cancel a payment', async () => {
    const c1 = await login(C1_MOBILE);
    const tx = await expectStatus(call('post', '/payments', c1, pay((await notReceivedVoter(c1)).recordId, 'cx')), 201);
    await expectStatus(call('post', `/payments/${tx.id}/cancel`, c1, { kind: 'Cancelled', reason: 'Mistake' }), 403);
  });

  it('validates the amount and receiver, and enforces a fixed amount', async () => {
    const sa = await login(SUPER_MOBILE);
    const voter = await notReceivedVoter(sa);
    const bad = await expectStatus(call('post', '/payments', sa, { voterRecordId: voter.recordId, amount: 10.5, receiverName: 'R', receiverMobile: '12345' }), 400);
    expect(Object.keys(bad.fieldErrors).sort()).toEqual(['amount', 'receiverMobile', 'receiverName']);
    await expectStatus(call('put', '/settings/payment', sa, { defaultAmount: 1500, effectiveDate: '2000-01-01', allowAmountOverride: false }), 200);
    const c1 = await login(C1_MOBILE);
    expect(await expectStatus(call('get', '/payments/context', c1), 200)).toEqual({ suggestedAmount: 1500, amountEditable: false });
    const err = await expectStatus(call('post', '/payments', c1, { ...pay((await notReceivedVoter(c1)).recordId, 'amt'), amount: 9999 }), 400);
    expect(err.fieldErrors.amount).toBe('Amount must be ₹1,500');
  });

  it('applies a future-dated amount only from its effective date', async () => {
    const sa = await login(SUPER_MOBILE);
    const r = await expectStatus(call('put', '/settings/payment', sa, { defaultAmount: 3000, effectiveDate: '2999-01-01', allowAmountOverride: true }), 200);
    expect(r.currentAmount).toBe(2000);
    expect(r.settings).toMatchObject({ defaultAmount: 3000, effectiveDate: '2999-01-01', currency: 'INR' });
    expect(r.history[0]).toMatchObject({ id: 'CFG-2', changedBy: 'SA-1', defaultAmount: 3000 });
    await expectStatus(call('put', '/settings/payment', sa, { defaultAmount: 3000, effectiveDate: '2026-02-31', allowAmountOverride: true }), 400);
  });

  it('keeps unique voter counts separate from payment counts', async () => {
    const sa = await login(SUPER_MOBILE);
    const voter = await notReceivedVoter(sa);
    const before = await expectStatus(call('get', '/reports/dashboard', sa), 200);
    const tx = await expectStatus(call('post', '/payments', sa, pay(voter.recordId, 'u1')), 201);
    await expectStatus(call('post', `/payments/${tx.id}/cancel`, sa, { kind: 'Reversed', reason: 'Returned' }), 200);
    await expectStatus(call('post', '/payments', sa, pay(voter.recordId, 'u2')), 201);
    const after = await expectStatus(call('get', '/reports/dashboard', sa), 200);
    expect(after.votersReceived).toBe(before.votersReceived + 1);
    expect(after.totalTransactions).toBe(before.totalTransactions + 1);
    expect(after.votersReceived + after.votersNotReceived).toBe(after.totalVoters);
    expect(after.totalAmount).toBe(after.totalTransactions * 2000);
  });
});

describe('Corporators and BLOs', () => {
  const corporator = { fullName: 'New Corporator', mobile: '9988776655', wardIds: ['W1'], boothIds: [], password: 'secret123', role: 'CORPORATOR' };

  it('generates C-n IDs for Corporators and C-n-BLOm IDs for BLOs, and they can sign in', async () => {
    const sa = await login(SUPER_MOBILE);
    expect((await expectStatus(call('post', '/admins', sa, corporator), 201)).id).toBe('C-5');
    expect((await expectStatus(call('post', '/admins', sa, { ...corporator, fullName: 'Second Corporator', mobile: '9988776656' }), 201)).id).toBe('C-6');
    const blo = await expectStatus(call('post', '/admins', sa, { ...corporator, fullName: 'New BLO', role: 'BLO', corporatorId: 'C-1', mobile: '9988776657', boothIds: ['B1-3'] }), 201);
    expect(blo).toMatchObject({ id: 'C-1-BLO3', corporatorId: 'C-1', boothIds: ['B1-3'], location: '' });
    expect((await expectStatus(call('post', '/auth/login', null, { identifier: '9988776655', password: 'secret123' }), 200)).admin.id).toBe('C-5');
  });

  it('a Super Admin creates Super Admins (SA-n) with full rights, who manage every account but their own', async () => {
    const sa = await login(SUPER_MOBILE);
    const input = { fullName: 'Second Admin', mobile: '9988776600', password: 'secret123', role: 'SUPER_ADMIN', wardIds: ['W1'], boothIds: ['B1-1'], location: 'x' };
    const created = await expectStatus(call('post', '/admins', sa, input), 201);
    expect(created).toMatchObject({ id: 'SA-2', role: 'SUPER_ADMIN', wardIds: [], boothIds: [], location: '', corporatorId: null });
    await expectStatus(call('post', '/admins', await login(C1_MOBILE), { ...input, mobile: '9988776601' }), 403);
    const sa2 = await login('9988776600', 'secret123');
    await expectStatus(call('get', '/audit-logs', sa2), 200);
    const supers = await expectStatus(call('get', '/admins', sa2, undefined, { role: 'SUPER_ADMIN' }), 200);
    expect(supers.items.map((a: { id: string }) => a.id)).toEqual(['SA-1']);
    await expectStatus(call('get', '/admins/SA-2', sa2), 404);
    await expectStatus(call('put', '/admins/SA-1/password', sa2, { password: 'changed99' }), 204);
    await expectStatus(call('get', '/auth/me', sa), 401);
    const audit = await expectStatus(call('get', '/audit-logs', sa2, undefined, { recordRef: 'SA-2' }), 200);
    expect(audit.items.map((a: { action: string }) => a.action)).toContain('Super Admin created');
  });

  it('stores a location for Corporators only and audits changes', async () => {
    const sa = await login(SUPER_MOBILE);
    const created = await expectStatus(call('post', '/admins', sa, { ...corporator, location: '  Gandhi Nagar office  ' }), 201);
    expect(created.location).toBe('Gandhi Nagar office');
    const blo = await expectStatus(call('post', '/admins', sa, { ...corporator, fullName: 'Another Person', role: 'BLO', corporatorId: created.id, mobile: '9988776650', location: 'ignored' }), 201);
    expect(blo.location).toBe('');
    await expectStatus(call('put', `/admins/${created.id}`, sa, { ...corporator, location: 'x'.repeat(201) }), 400);
    const updated = await expectStatus(call('put', `/admins/${created.id}`, sa, { ...corporator, location: 'Market Street' }), 200);
    expect(updated.location).toBe('Market Street');
    const audit = await expectStatus(call('get', '/audit-logs', sa, undefined, { recordRef: created.id }), 200);
    expect(audit.items.some((a: { summary: string }) => a.summary.includes('location'))).toBe(true);
  });

  it('a Corporator creates BLOs only for itself and only inside its wards', async () => {
    const c1 = await login(C1_MOBILE);
    const blo = await expectStatus(call('post', '/admins', c1, { ...corporator, role: 'BLO', corporatorId: 'C-2', wardIds: ['W2'] }), 201);
    expect(blo).toMatchObject({ id: 'C-1-BLO3', corporatorId: 'C-1' });
    const wrongWard = await expectStatus(call('post', '/admins', c1, { ...corporator, fullName: 'Other', role: 'BLO', mobile: '9988776658', wardIds: ['W3'] }), 400);
    expect(wrongWard.fieldErrors.wardIds).toBeDefined();
    await expectStatus(call('post', '/admins', c1, { ...corporator, mobile: '9988776659' }), 403);
  });

  it('a Corporator manages only its own BLOs', async () => {
    const c1 = await login(C1_MOBILE);
    const list = await expectStatus(call('get', '/admins', c1, undefined, { pageSize: 50 }), 200);
    expect(list.items.map((a: { id: string }) => a.id)).toEqual(['C-1-BLO1', 'C-1-BLO2']);
    await expectStatus(call('put', '/admins/C-1-BLO1/password', c1, { password: 'bloPass99' }), 204);
    expect((await expectStatus(call('post', '/auth/login', null, { identifier: BLO_MOBILE, password: 'bloPass99' }), 200)).admin.id).toBe('C-1-BLO1');
    await expectStatus(call('patch', '/admins/C-2-BLO1/status', c1, { status: 'Inactive' }), 404);
    await expectStatus(call('get', '/admins/C-2', c1), 404);
    const options = await expectStatus(call('get', '/admins/options', c1), 200);
    expect(options.map((o: { id: string }) => o.id)).toEqual(['C-1', 'C-1-BLO1', 'C-1-BLO2']);
  });

  it('removing a ward from a Corporator removes it from its BLOs', async () => {
    const sa = await login(SUPER_MOBILE);
    await expectStatus(call('put', '/admins/C-1', sa, { fullName: 'Ramesh Babu', mobile: C1_MOBILE, wardIds: ['W2'], boothIds: [], location: '' }), 200);
    expect(await expectStatus(call('get', '/admins/C-1-BLO1', sa), 200)).toMatchObject({ wardIds: [], boothIds: [] });
    expect((await expectStatus(call('get', '/admins/C-1-BLO2', sa), 200)).wardIds).toEqual(['W2']);
    await expectStatus(call('put', '/wards/W2/admins', sa, { adminIds: [] }), 204);
    expect((await expectStatus(call('get', '/admins/C-1-BLO2', sa), 200)).wardIds).toEqual([]);
  });

  it('a BLO can be put on a booth only inside its Corporator wards', async () => {
    const sa = await login(SUPER_MOBILE);
    await expectStatus(call('put', '/booths/B3-2/admins', sa, { adminIds: ['C-1-BLO1'] }), 400);
    await expectStatus(call('put', '/booths/B1-3/admins', sa, { adminIds: ['C-1-BLO1'] }), 204);
    expect((await expectStatus(call('get', '/admins/C-1-BLO1', sa), 200)).boothIds).toContain('B1-3');
    const summary = await expectStatus(call('get', '/wards/summary', sa), 200);
    const w1 = summary.find((w: { id: string }) => w.id === 'W1');
    expect(w1.adminIds).toEqual(['C-1']);
    expect(w1.booths.find((b: { id: string }) => b.id === 'B1-3').adminIds).toEqual(['C-1-BLO1']);
  });

  it('rejects a duplicate mobile number', async () => {
    const sa = await login(SUPER_MOBILE);
    expect((await expectStatus(call('post', '/admins', sa, { ...corporator, mobile: C1_MOBILE }), 400)).fieldErrors.mobile).toBeDefined();
  });

  it('a password set by the Super Admin signs the account out everywhere', async () => {
    const c1 = await login(C1_MOBILE);
    const sa = await login(SUPER_MOBILE);
    await expectStatus(call('put', '/admins/C-1/password', sa, { password: 'newpass99' }), 204);
    await expectStatus(call('get', '/auth/me', c1), 401);
    await expectStatus(call('post', '/auth/login', null, { identifier: C1_MOBILE, password: PASSWORD }), 401);
    await login(C1_MOBILE, 'newpass99');
  });

  it('Corporators and BLOs can change their own password; other sessions end', async () => {
    const other = await login(BLO_MOBILE);
    const blo = await login(BLO_MOBILE);
    await expectStatus(call('post', '/auth/change-password', blo, { currentPassword: 'wrong', newPassword: 'mynewpass1' }), 400);
    await expectStatus(call('post', '/auth/change-password', blo, { currentPassword: PASSWORD, newPassword: 'short' }), 400);
    await expectStatus(call('post', '/auth/change-password', blo, { currentPassword: PASSWORD, newPassword: 'mynewpass1' }), 204);
    await expectStatus(call('get', '/auth/me', other), 401);
    await expectStatus(call('get', '/auth/me', blo), 200);
    await login(BLO_MOBILE, 'mynewpass1');
  });

  it('Corporators and BLOs cannot use Super Admin endpoints', async () => {
    for (const token of [await login(C2_MOBILE), await login(BLO_MOBILE)]) {
      await expectStatus(call('get', '/audit-logs', token), 403);
      await expectStatus(call('get', '/settings/payment', token), 403);
      await expectStatus(call('get', '/wards/summary', token), 403);
      await expectStatus(call('post', '/wards', token, { number: 9, name: 'Nine' }), 403);
      await expectStatus(call('get', '/imports/context', token), 403);
      await expectStatus(call('get', '/voters/export', token), 403);
      const voter = await notReceivedVoter(token);
      await expectStatus(call('put', `/voters/${voter.recordId}`, token, voter), 403);
    }
    await expectStatus(call('get', '/admins', await login(BLO_MOBILE)), 403);
  });

  it('deactivating an account ends its sessions', async () => {
    const c1 = await login(C1_MOBILE);
    const sa = await login(SUPER_MOBILE);
    expect((await expectStatus(call('patch', '/admins/C-1/status', sa, { status: 'Inactive' }), 200)).status).toBe('Inactive');
    await expectStatus(call('get', '/auth/me', c1), 401);
    await expectStatus(call('patch', '/admins/SA-1/status', sa, { status: 'Inactive' }), 404);
  });
});

describe('voters', () => {
  const base = { fullName: 'Test Voter', mobile: '', wardId: 'W1', boothId: 'B1-1', houseNumber: '1', householdId: '', address: '', status: 'Active' };

  it('rejects a duplicate voter ID (any case), keeps leading zeros and requires a booth in the ward', async () => {
    const sa = await login(SUPER_MOBILE);
    const existing = (await voters(sa, { pageSize: 1 }))[0];
    expect((await expectStatus(call('post', '/voters', sa, { ...base, voterId: existing.voterId.toLowerCase() }), 409)).code).toBe('CONFLICT');
    expect((await expectStatus(call('post', '/voters', sa, { ...base, voterId: 'NEW1', boothId: 'B2-1' }), 400)).fieldErrors.boothId).toBeDefined();
    const created = await expectStatus(call('post', '/voters', sa, { ...base, voterId: '000NEW' }), 201);
    expect(created).toMatchObject({ voterId: '000NEW', recordId: expect.stringMatching(/^VR-\d{6}$/) });
  });

  it('never defaults the status and keeps a household inside one ward', async () => {
    const sa = await login(SUPER_MOBILE);
    expect((await expectStatus(call('post', '/voters', sa, { ...base, voterId: 'S1', status: '' }), 400)).fieldErrors.status).toBeDefined();
    const w1 = (await voters(sa, { wardId: 'W1', pageSize: 1 }))[0];
    const r = await expectStatus(call('post', '/voters', sa, { ...base, voterId: 'H1', wardId: 'W2', boothId: 'B2-1', householdId: w1.householdId.toLowerCase() }), 400);
    expect(r.fieldErrors.householdId).toMatch(/different ward/);
  });

  it('updates a voter and audits status changes separately', async () => {
    const sa = await login(SUPER_MOBILE);
    const v = (await voters(sa, { status: 'Active', pageSize: 1 }))[0];
    const updated = await expectStatus(call('put', `/voters/${v.recordId}`, sa, { ...v, status: 'Shifted', address: 'New address' }), 200);
    expect(updated).toMatchObject({ status: 'Shifted', address: 'New address' });
    const audit = (await expectStatus(call('get', '/audit-logs', sa, undefined, { recordRef: v.voterId }), 200)).items.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['Voter updated', 'Voter status changed']));
  });

  it('lists only the account\'s own area, with search, filters and paging', async () => {
    const corporatorVoters = await voters(await login(C1_MOBILE));
    expect(corporatorVoters.length).toBeGreaterThan(0);
    expect(corporatorVoters.every((v) => ['W1', 'W2'].includes(v.wardId))).toBe(true);
    const bloVoters = await voters(await login(BLO_MOBILE));
    expect(bloVoters.length).toBeGreaterThan(0);
    expect(bloVoters.every((v) => ['B1-1', 'B1-2'].includes(v.boothId))).toBe(true);
    const sa = await login(SUPER_MOBILE);
    const all = await voters(sa);
    const target = all.find((v) => v.mobile)!;
    expect((await voters(sa, { search: target.voterId.toLowerCase() })).map((v) => v.recordId)).toEqual([target.recordId]);
    expect((await voters(sa, { search: target.mobile.slice(2, 8) })).some((v) => v.recordId === target.recordId)).toBe(true);
    const page = await expectStatus(call('get', '/voters', sa, undefined, { page: 999, pageSize: 10 }), 200);
    expect(page.page).toBe(Math.ceil(page.total / 10));
    const byName = await voters(sa, { sortBy: 'fullName', sortDir: 'desc' });
    expect(byName[0].fullName.localeCompare(byName[byName.length - 1].fullName)).toBeGreaterThanOrEqual(0);
  });

  it('treats sort and search input as data, never as SQL', async () => {
    const sa = await login(SUPER_MOBILE);
    const total = (await voters(sa)).length;
    expect((await voters(sa, { sortBy: 'fullName; DROP TABLE voters; --', sortDir: 'sideways' })).length).toBe(total);
    expect(await voters(sa, { search: "' OR 1=1 --" })).toHaveLength(0);
    expect(await voters(sa, { search: '%' })).toHaveLength(0);
    await expectStatus(call('get', '/payments', sa, undefined, { sortBy: '1; DELETE FROM payment_transactions', search: "x' --" }), 200);
    expect((await pool.query('SELECT count(*)::int AS n FROM voters')).rows[0].n).toBe(total);
  });

  it('flags duplicates for the voter form', async () => {
    const sa = await login(SUPER_MOBILE);
    const v = (await voters(sa, { pageSize: 1 }))[0];
    const r = await expectStatus(call('get', '/voters/duplicate-check', sa, undefined, { voterId: v.voterId, fullName: v.fullName.toUpperCase(), houseNumber: v.houseNumber, wardId: v.wardId }), 200);
    expect(r.voterIdExists).toBe(true);
    expect(r.similar.map((s: { recordId: string }) => s.recordId)).toContain(v.recordId);
    const self = await expectStatus(call('get', '/voters/duplicate-check', sa, undefined, { voterId: v.voterId, fullName: '', houseNumber: '', wardId: v.wardId, excludeRecordId: v.recordId }), 200);
    expect(self.voterIdExists).toBe(false);
  });
});

describe('imports', () => {
  it('re-validates rows on the server: duplicates are skipped, invalid rows fail, one audit entry', async () => {
    const sa = await login(SUPER_MOBILE);
    const ctx = await expectStatus(call('get', '/imports/context', sa), 200);
    expect(ctx.existingVoterIds.length).toBeGreaterThan(0);
    const { importId } = await expectStatus(call('post', '/imports', sa, { fileName: 'voters.xlsx' }), 201);
    const voter = (id: string, extra = {}) => ({ voterId: id, fullName: 'Imported Person', mobile: '', wardId: 'W2', boothId: 'B2-1', houseNumber: '9', householdId: '', address: '', status: 'Active', ...extra });
    const batch = await expectStatus(call('post', `/imports/${importId}/rows`, sa, { rows: [
      { rowNumber: 2, voter: voter('IMP0001') },
      { rowNumber: 3, voter: voter(ctx.existingVoterIds[0]) },
      { rowNumber: 4, voter: voter('IMP0002', { status: 'Unknown' }) },
      { rowNumber: 5, voter: voter('imp0001') },
    ] }), 200);
    expect(batch).toMatchObject({ imported: 1, skipped: 2, failed: 1 });
    const done = await expectStatus(call('post', `/imports/${importId}/complete`, sa, { skippedBeforeUpload: 3 }), 200);
    expect(done).toMatchObject({ imported: 1, skipped: 5, failed: 1 });
    expect(done.errors.map((e: { rowNumber: number }) => e.rowNumber).sort()).toEqual([3, 4, 5]);
    await expectStatus(call('post', `/imports/${importId}/complete`, sa, {}), 404);
    expect((await pool.query(`SELECT summary FROM audit_logs WHERE entity = 'Import'`)).rows).toEqual([{ summary: '1 imported, 5 skipped, 1 failed' }]);
  });
});

describe('wards, reports and audit', () => {
  it('creates and edits wards and booths with unique numbers', async () => {
    const sa = await login(SUPER_MOBILE);
    const ward = await expectStatus(call('post', '/wards', sa, { number: 6, name: 'New Ward' }), 201);
    expect(ward.id).toBe('W6');
    await expectStatus(call('post', '/wards', sa, { number: 6, name: 'Again' }), 400);
    const booth = await expectStatus(call('post', '/booths', sa, { wardId: ward.id, number: 61, name: 'Booth 61' }), 201);
    expect(booth.id).toBe('B-16');
    await expectStatus(call('post', '/booths', sa, { wardId: ward.id, number: 61, name: 'Dup' }), 400);
    const moved = await expectStatus(call('put', `/booths/${booth.id}`, sa, { number: 62, name: 'Renamed', wardId: 'W1' }), 200);
    expect(moved).toMatchObject({ wardId: ward.id, number: 62 });
    const list = await expectStatus(call('get', '/wards', await login(BLO_MOBILE)), 200);
    expect(list.wards.map((w: { number: number }) => w.number)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('scopes dashboards and reports to the account area', async () => {
    const sa = await login(SUPER_MOBILE);
    const all = await expectStatus(call('get', '/reports/dashboard', sa), 200);
    expect(all).toMatchObject({ totalCorporators: 4, totalBlos: 4, totalWards: 5, totalBooths: 15 });
    expect(all.overTime).toHaveLength(30);
    const c1 = await expectStatus(call('get', '/reports/dashboard', await login(C1_MOBILE)), 200);
    expect(c1).toMatchObject({ totalCorporators: null, totalBlos: 2, byAdmin: [] });
    expect(c1.byWard.map((w: { key: string }) => w.key)).toEqual(['W1', 'W2']);
    const blo = await expectStatus(call('get', '/reports', await login(BLO_MOBILE)), 200);
    expect(blo.byBooth.map((b: { key: string }) => b.key)).toEqual(['B1-1', 'B1-2']);
    expect(blo.byAdmin.every((a: { adminId: string }) => a.adminId === 'C-1-BLO1')).toBe(true);
    expect(blo.summary.votersReceived + blo.summary.votersNotReceived).toBe(blo.summary.totalVoters);
    const report = await expectStatus(call('get', '/reports', sa), 200);
    expect(report.summary.transactions).toBe(report.byAdmin.reduce((s: number, a: { transactions: number }) => s + a.transactions, 0));
    expect(report.daily.reduce((s: number, d: { amount: number }) => s + d.amount, 0)).toBe(report.summary.amount);
  });

  it('keeps the audit log append-only and readable by the Super Admin only', async () => {
    const sa = await login(SUPER_MOBILE);
    const page = await expectStatus(call('get', '/audit-logs', sa, undefined, { entity: 'Auth' }), 200);
    expect(page.items[0]).toMatchObject({ action: 'Logged in', adminId: 'SA-1' });
    await expect(pool.query('DELETE FROM audit_logs')).rejects.toThrow(/append-only/);
    await expect(pool.query(`UPDATE audit_logs SET summary = 'x'`)).rejects.toThrow(/append-only/);
  });

  it('notifies field accounts about payments in their area by others', async () => {
    const sa = await login(SUPER_MOBILE);
    const target = await notReceivedVoter(sa, { boothId: 'B1-1' });
    await expectStatus(call('post', '/payments', sa, pay(target.recordId, 'n1')), 201);
    const notes = await expectStatus(call('get', '/notifications', await login(BLO_MOBILE)), 200);
    expect(notes[0]).toMatchObject({ title: 'Payment recorded by SA-1' });
    expect(notes[0].body).toContain(target.voterId);
  });

  it('answers unknown routes and bad JSON with the error shape', async () => {
    expect((await expectStatus(call('get', '/nope', null), 404)).code).toBe('NOT_FOUND');
    const bad = await call('post', '/auth/login', null).set('Content-Type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('VALIDATION');
    expect((await expectStatus(call('get', '/health', null), 200)).ok).toBe(true);
  });
});
