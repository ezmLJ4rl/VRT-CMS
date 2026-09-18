'use strict';
/**
 * Phase 3 (security enforcement) regression tests.
 * - login is a single email+password step (no 2FA/QR enrollment, no device pairing)
 * - the same account can hold several independent sessions (any-device login)
 * - receptionists cannot backdate offerings through either path
 * - users PATCH validates role/language and blocks self-lockout
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'phase3-security', port: 4602 });
let adminToken;
let recToken;
let recId;
let deskId;

// The server must live for BOTH describes in this file: stop it once, at file end.
after(() => suite.stop());

describe('phase 3: single-step login + multi-device sessions', () => {
  before(async () => {
    await suite.waitReady();
  });

  it('login returns a full session from credentials alone (no 2FA step)', async () => {
    const login = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    assert.equal(login.status, 200);
    assert.equal(login.json.mustSetup2fa, undefined);
    assert.ok(login.json.token);
    assert.equal(login.json.user.role, 'superadmin');
    const data = await suite.api('GET', '/api/offerings', login.json.token);
    assert.equal(data.status, 200);
    adminToken = login.json.token;
  });

  it('the same account can be signed in on two devices at once', async () => {
    // Device B logs in independently; both tokens stay valid side by side.
    const second = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    assert.equal(second.status, 200);
    assert.ok(second.json.token);
    const meA = await suite.api('GET', '/api/auth/me', adminToken);
    const meB = await suite.api('GET', '/api/auth/me', second.json.token);
    assert.equal(meA.status, 200);
    assert.equal(meB.status, 200);
    assert.equal(meA.json.user.id, meB.json.user.id);
  });

  it('garbage TOTP tokens are simply ignored: credentials still win', async () => {
    const login = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church', password: 'TestPass_123!', totpToken: '000000',
    });
    assert.equal(login.status, 200);
    assert.ok(login.json.token);
  });
});

describe('phase 3: backdating + validation', () => {
  before(async () => {
    const create = await suite.api('POST', '/api/users', adminToken, {
      name: 'Front Desk', email: 'desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    assert.equal(create.status, 201);
    recId = create.json.id;
    const login = await suite.api('POST', '/api/auth/login', null, { email: 'desk@test.local', password: 'DeskPass_123!' });
    assert.equal(login.status, 200);
    recToken = login.json.token;
  });

  it('receptionist cannot backdate via serviceId of an old session', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const svc = await suite.api('POST', '/api/services', adminToken, { name: 'Legacy', date: yesterday, serviceTypeId: 1 });
    assert.equal(svc.status, 201);
    const attempt = await suite.api('POST', '/api/offerings', recToken, { serviceId: svc.json.id, category: 'general', amount: 1000 });
    assert.equal(attempt.status, 403);
  });

  it('receptionist cannot backdate via date on the typed path', async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const attempt = await suite.api('POST', '/api/offerings', recToken, { serviceTypeId: 1, date: yesterday, category: 'general', amount: 1000 });
    assert.equal(attempt.status, 403);
    const today = await suite.api('POST', '/api/offerings', recToken, { serviceTypeId: 1, category: 'general', amount: 2000 });
    assert.equal(today.status, 201);
  });

  it('PATCH /users/:id validates role and language, blocks self-lockout', async () => {
    const badRole = await suite.api('PATCH', `/api/users/${recId}`, adminToken, { role: 'hacker' });
    assert.equal(badRole.status, 400);
    const badLang = await suite.api('PATCH', `/api/users/${recId}`, adminToken, { languagePref: 'fr' });
    assert.equal(badLang.status, 400);
    const selfDemote = await suite.api('PATCH', '/api/users/1', adminToken, { role: 'receptionist' });
    assert.equal(selfDemote.status, 400);
    const selfOff = await suite.api('PATCH', '/api/users/1', adminToken, { isActive: false });
    assert.equal(selfOff.status, 400);
    const ok = await suite.api('PATCH', `/api/users/${recId}`, adminToken, { role: 'admin' });
    assert.equal(ok.status, 200);
    const role = (await suite.get('SELECT role FROM users WHERE id = ?', [recId])).role;
    assert.equal(role, 'admin');
  });

  it('audit hash chain stays valid across all of the above', async () => {
    const res = await suite.api('GET', '/api/reports/audit-integrity', adminToken);
    assert.equal(res.status, 200);
    assert.equal(res.json.valid, true);
  });
});

describe('phase 3: superadmin-only secure password reset', () => {
  it('superadmin issues a temporary password; stored + audited as hash only', async () => {
    const users = await suite.api('GET', '/api/users', adminToken);
    const desk = users.json.users.find((u) => u.email === 'desk@test.local');
    assert.ok(desk, 'desk account exists');
    deskId = desk.id;

    const reset = await suite.api('POST', `/api/users/${desk.id}/reset-password`, adminToken, {});
    assert.equal(reset.status, 200);
    assert.ok(reset.json.tempPassword.length >= 8, 'one-time temp password returned');

    // Old password stops working on next login; the temp password works.
    const oldLogin = await suite.api('POST', '/api/auth/login', null, { email: 'desk@test.local', password: 'DeskPass_123!' });
    assert.equal(oldLogin.status, 401);
    const tempLogin = await suite.api('POST', '/api/auth/login', null, { email: 'desk@test.local', password: reset.json.tempPassword });
    assert.equal(tempLogin.status, 200);

    const audit = await suite.get("SELECT details FROM audit_log WHERE action = 'password_reset' AND record_id = ? ORDER BY id DESC LIMIT 1", [desk.id]);
    const stored = await suite.get('SELECT password_hash FROM users WHERE id = ?', [desk.id]);
    assert.ok(String(stored.password_hash).startsWith('$2'), 'persisted as bcrypt hash');
    assert.ok(!String(audit.details).includes(reset.json.tempPassword), 'plaintext must never appear in the audit log');
  });

  it('receptionists and admins cannot reset passwords (superadmin only)', async () => {
    const rt = await suite.api('POST', '/api/users', adminToken, {
      name: 'Reset Tester', email: 'rt@test.local', role: 'receptionist', password: 'Pass_Word1!',
    });
    assert.equal(rt.status, 201);
    const rtLogin = await suite.api('POST', '/api/auth/login', null, { email: 'rt@test.local', password: 'Pass_Word1!' });
    assert.equal(rtLogin.status, 200);
    const deniedRec = await suite.api('POST', `/api/users/${rt.json.id}/reset-password`, rtLogin.json.token, {});
    assert.equal(deniedRec.status, 403);

    // desk is an admin after the earlier role-upgrade test: log in as admin.
    const again = await suite.api('POST', `/api/users/${deskId}/reset-password`, adminToken, {});
    const deskLogin = await suite.api('POST', '/api/auth/login', null, { email: 'desk@test.local', password: again.json.tempPassword });
    assert.equal(deskLogin.status, 200);
    const deniedAdmin = await suite.api('POST', `/api/users/${rt.json.id}/reset-password`, deskLogin.json.token, {});
    assert.equal(deniedAdmin.status, 403);
  });
});
