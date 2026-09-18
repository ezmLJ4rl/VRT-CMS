'use strict';
/**
 * User management (superadmin CRUD) + session lifetime regression tests.
 *
 * Covers the parts that are easy to get subtly wrong:
 * - a superadmin can edit every credential, including email and password
 * - an edited password invalidates the sessions that were opened with the old one
 *   (a 30-day token must never outlive the password it was minted for)
 * - a superadmin cannot demote, deactivate or delete their own account
 * - deleting an account that recorded nothing works and leaves the audit chain
 *   verifiable; deleting one that recorded offerings is refused with the reason
 * - long sessions slide forward instead of expiring under an active user
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startServer } = require('./helpers');
const { passwordFingerprint } = require('../utils/token');

const suite = startServer({ name: 'users-crud', port: 4605 });

const ADMIN = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const DAY = 86400;

let adminToken;

async function signIn(email, password) {
  return suite.api('POST', '/api/auth/login', null, { email, password });
}

async function createUser({ name, email, role = 'receptionist', password = 'DeskPass_123!', phone }) {
  const res = await suite.api('POST', '/api/users', adminToken, { name, email, role, password, phone });
  assert.equal(res.status, 201, `create failed: ${res.text}`);
  return res.json.id;
}

async function auditVerify() {
  return suite.api('GET', '/api/reports/audit-integrity', adminToken);
}

after(() => suite.stop());

describe('user management: editing credentials', () => {
  before(async () => {
    await suite.waitReady();
    const login = await signIn(ADMIN.email, ADMIN.password);
    assert.equal(login.status, 200);
    adminToken = login.json.token;
  });

  it('edits name, email, phone and role and signs in with the new email', async () => {
    const id = await createUser({ name: 'Desk One', email: 'desk1@test.local', phone: '+255700111222' });

    const patch = await suite.api('PATCH', `/api/users/${id}`, adminToken, {
      name: 'Desk Two',
      email: 'DESK2@Test.Local', // normalized to lower case by the API
      phone: '+255700333444',
      role: 'admin',
    });
    assert.equal(patch.status, 200, patch.text);
    assert.equal(patch.json.user.name, 'Desk Two');
    assert.equal(patch.json.user.email, 'desk2@test.local');
    assert.equal(patch.json.user.phone, '+255700333444');
    assert.equal(patch.json.user.role, 'admin');
    assert.equal(patch.json.user.password_hash, undefined, 'the hash must never be returned');

    const oldEmail = await signIn('desk1@test.local', 'DeskPass_123!');
    assert.equal(oldEmail.status, 401);
    const newEmail = await signIn('desk2@test.local', 'DeskPass_123!');
    assert.equal(newEmail.status, 200);
    assert.equal(newEmail.json.user.role, 'admin');
  });

  it('refuses a duplicate email on create and on edit', async () => {
    const dupe = await suite.api('POST', '/api/users', adminToken, {
      name: 'Copy', email: 'desk2@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    assert.equal(dupe.status, 409);

    const id = await createUser({ name: 'Desk Three', email: 'desk3@test.local' });
    const clash = await suite.api('PATCH', `/api/users/${id}`, adminToken, { email: 'desk2@test.local' });
    assert.equal(clash.status, 409);
  });

  it('clears a phone number when an empty value is sent', async () => {
    const id = await createUser({ name: 'Desk Four', email: 'desk4@test.local', phone: '+255700999888' });
    const cleared = await suite.api('PATCH', `/api/users/${id}`, adminToken, { phone: '' });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.json.user.phone, null);
  });

  it('sets a password directly and kills that account\'s existing sessions', async () => {
    const id = await createUser({ name: 'Desk Five', email: 'desk5@test.local' });
    const login = await signIn('desk5@test.local', 'DeskPass_123!');
    assert.equal(login.status, 200);
    const existingToken = login.json.token;
    assert.equal((await suite.api('GET', '/api/auth/me', existingToken)).status, 200);

    const patch = await suite.api('PATCH', `/api/users/${id}`, adminToken, { password: 'BrandNew_456!' });
    assert.equal(patch.status, 200, patch.text);

    assert.equal((await signIn('desk5@test.local', 'DeskPass_123!')).status, 401, 'old password must stop working');
    assert.equal((await signIn('desk5@test.local', 'BrandNew_456!')).status, 200, 'new password must work');
    // The whole point of a 30-day session: it must not survive a credential change.
    const revoked = await suite.api('GET', '/api/auth/me', existingToken);
    assert.equal(revoked.status, 401, 'a token minted against the old password must be rejected');
  });

  it('rejects a too-short replacement password', async () => {
    const id = await createUser({ name: 'Desk Six', email: 'desk6@test.local' });
    const short = await suite.api('PATCH', `/api/users/${id}`, adminToken, { password: 'short' });
    assert.equal(short.status, 400);
    assert.equal((await signIn('desk6@test.local', 'DeskPass_123!')).status, 200, 'password must be unchanged');
  });

  it('never writes a plaintext password into the audit log', async () => {
    const { rows } = await suite.query("SELECT details FROM audit_log WHERE details ILIKE '%BrandNew_456!%'");
    assert.equal(rows.length, 0, 'the new password leaked into the audit trail');

    const entry = await suite.get(
      "SELECT action, details FROM audit_log WHERE action = 'password_set_by_admin' ORDER BY id DESC LIMIT 1"
    );
    assert.ok(entry, 'setting a password by an admin must be audited');
    assert.match(entry.details, /desk5@test\.local/);

    const chain = await auditVerify();
    assert.equal(chain.status, 200);
    assert.equal(chain.json.valid, true, `audit chain broken at ${chain.json.brokenAtId}`);
  });
});

describe('user management: self-lockout protection', () => {
  it('refuses to demote, deactivate or delete the signed-in superadmin', async () => {
    const me = await suite.api('GET', '/api/auth/me', adminToken);
    const id = me.json.user.id;

    const demote = await suite.api('PATCH', `/api/users/${id}`, adminToken, { role: 'receptionist' });
    assert.equal(demote.status, 400);
    const deactivate = await suite.api('PATCH', `/api/users/${id}`, adminToken, { isActive: false });
    assert.equal(deactivate.status, 400);
    const remove = await suite.api('DELETE', `/api/users/${id}`, adminToken);
    assert.equal(remove.status, 400);

    // Still a working superadmin afterwards.
    assert.equal((await suite.api('GET', '/api/auth/me', adminToken)).status, 200);
    const stillSuperadmin = await suite.get("SELECT role, is_active FROM users WHERE id = $1", [id]);
    assert.equal(stillSuperadmin.role, 'superadmin');
    assert.equal(Number(stillSuperadmin.is_active), 1);
  });
});

describe('user management: deletion', () => {
  it('deletes an account that never recorded data and keeps the chain verifiable', async () => {
    const id = await createUser({ name: 'Mistake Account', email: 'mistake@test.local' });
    // Signing in gives the account its own audit rows, which deletion must take
    // with it (and re-link the chain over).
    assert.equal((await signIn('mistake@test.local', 'DeskPass_123!')).status, 200);
    const ownRows = await suite.get('SELECT COUNT(*)::int AS count FROM audit_log WHERE user_id = $1', [id]);
    assert.ok(ownRows.count > 0, 'expected the login to be audited against this user');

    const removed = await suite.api('DELETE', `/api/users/${id}`, adminToken);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.json.removedAuditRows, ownRows.count);

    const gone = await suite.get('SELECT id FROM users WHERE id = $1', [id]);
    assert.equal(gone, undefined);
    assert.equal((await signIn('mistake@test.local', 'DeskPass_123!')).status, 401);

    const chain = await auditVerify();
    assert.equal(chain.json.valid, true, `audit chain broken at ${chain.json.brokenAtId}`);
    const deletion = await suite.get("SELECT details FROM audit_log WHERE action = 'user_deleted' ORDER BY id DESC LIMIT 1");
    assert.match(deletion.details, /mistake@test\.local/);
  });

  it('refuses to delete an account that recorded offerings, and names the records', async () => {
    const id = await createUser({ name: 'Recording Desk', email: 'recorder@test.local' });
    const login = await signIn('recorder@test.local', 'DeskPass_123!');
    assert.equal(login.status, 200);
    const offering = await suite.api('POST', '/api/offerings', login.json.token, {
      serviceTypeId: 1, category: 'general', amount: 1500,
    });
    assert.equal(offering.status, 201, offering.text);

    const blocked = await suite.api('DELETE', `/api/users/${id}`, adminToken);
    assert.equal(blocked.status, 409);
    assert.deepEqual(blocked.json.blockedBy, ['offerings']);
    assert.match(blocked.json.error, /deactivate/i);

    // The account is still there, and deactivating it is the supported route:
    // access ends immediately while the offering stays attributed to someone.
    const still = await suite.get('SELECT id FROM users WHERE id = $1', [id]);
    assert.ok(still);
    const deactivate = await suite.api('PATCH', `/api/users/${id}`, adminToken, { isActive: false });
    assert.equal(deactivate.status, 200, deactivate.text);
    assert.equal((await signIn('recorder@test.local', 'DeskPass_123!')).status, 401);
    const recorded = await suite.get('SELECT recorded_by FROM offerings WHERE id = $1', [offering.json.id]);
    assert.equal(Number(recorded.recorded_by), id);
  });

  it('404s for an unknown account', async () => {
    const missing = await suite.api('DELETE', '/api/users/999999', adminToken);
    assert.equal(missing.status, 404);
  });
});

describe('sessions: long-lived and self-renewing', () => {
  it('issues a long session (not the old 8-hour one)', async () => {
    const login = await signIn(ADMIN.email, ADMIN.password);
    const decoded = jwt.decode(login.json.token);
    const lifetimeDays = (decoded.exp - decoded.iat) / DAY;
    assert.ok(lifetimeDays >= 7, `session lifetime is only ${lifetimeDays} days`);
  });

  it('renews a token that is past half its life, and leaves a fresh one alone', async () => {
    const fresh = await signIn(ADMIN.email, ADMIN.password);
    const untouched = await suite.api('GET', '/api/auth/me', fresh.json.token);
    assert.equal(untouched.status, 200);
    assert.equal(untouched.headers.get('x-refreshed-token'), null, 'a fresh token must not be churned');

    const row = await suite.get('SELECT * FROM users WHERE email = $1', [ADMIN.email]);
    const now = Math.floor(Date.now() / 1000);
    // A real session that is 20 days into a 30-day life: past the halfway mark.
    // (Passing `iat` explicitly makes jsonwebtoken anchor `exp` to it, so this is
    // exactly what the API itself would have issued 20 days ago.)
    const aged = jwt.sign(
      { sub: row.id, role: row.role, pv: passwordFingerprint(row.password_hash), iat: now - 20 * DAY },
      suite.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const renewed = await suite.api('GET', '/api/auth/me', aged);
    assert.equal(renewed.status, 200, renewed.text);
    const replacement = renewed.headers.get('x-refreshed-token');
    assert.ok(replacement, 'an aging session must be handed a replacement token');

    // The replacement is a real session, and it is younger than the token it replaced.
    assert.equal((await suite.api('GET', '/api/auth/me', replacement)).status, 200);
    const before = jwt.decode(aged);
    const after = jwt.decode(replacement);
    assert.ok(after.iat > before.iat);
    assert.ok((after.exp - after.iat) / DAY >= 7);
  });

  it('keeps the session of the device that changed its own password', async () => {
    const id = await createUser({ name: 'Self Change', email: 'selfchange@test.local' });
    const login = await signIn('selfchange@test.local', 'DeskPass_123!');
    const before = login.json.token;

    const changed = await suite.api('POST', '/api/auth/change-password', before, {
      currentPassword: 'DeskPass_123!', newPassword: 'SelfChosen_789!',
    });
    assert.equal(changed.status, 200, changed.text);

    // The password change revokes the old token (fingerprint moved) but the
    // response carries a replacement so this device stays signed in.
    assert.equal((await suite.api('GET', '/api/auth/me', before)).status, 401);
    const replacement = changed.headers.get('x-refreshed-token');
    assert.ok(replacement, 'the password change must hand this device a fresh token');
    assert.equal((await suite.api('GET', '/api/auth/me', replacement)).status, 200);

    // Other devices: a second session opened before the change is now dead.
    const other = await signIn('selfchange@test.local', 'DeskPass_123!');
    assert.equal(other.status, 401, 'the old password must be gone');

    const cleanup = await suite.api('DELETE', `/api/users/${id}`, adminToken);
    assert.equal(cleanup.status, 200, cleanup.text);
  });
});
