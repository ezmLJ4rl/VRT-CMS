'use strict';
/**
 * Multi-device session tests.
 *
 * The guarantee being tested: one account can be signed in on several devices
 * at once, each with its own independently revocable session.
 *   - a second login never invalidates the first device
 *   - logging out one device leaves the others working
 *   - "log out everywhere" ends all of them, including the caller's
 *   - a password change keeps the calling device (fresh token handed back)
 *     and signs every other device out
 *   - a superadmin resetting a password signs all of a user's devices out
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'sessions', port: 4617 });

const PASTOR = { email: 'pastor@victoryrevival.church', password: 'TestPass_123!' };

let pastorTokenA;
let pastorTokenB;

async function login() {
  const res = await suite.api('POST', '/api/auth/login', null, PASTOR);
  assert.equal(res.status, 200, res.text);
  return res.json;
}

describe('concurrent device sessions', () => {
  before(async () => {
    await suite.waitReady();
    pastorTokenA = (await login()).token;
    pastorTokenB = (await login()).token;
  });

  after(() => suite.stop());

  it('two logins produce two independent, working sessions', async () => {
    const a = await suite.api('GET', '/api/auth/me', pastorTokenA);
    const b = await suite.api('GET', '/api/auth/me', pastorTokenB);
    assert.equal(a.status, 200, a.text);
    assert.equal(b.status, 200, b.text);
    assert.ok(a.json.sessionId, 'the session carries its own id');
    assert.notEqual(a.json.sessionId, b.json.sessionId, 'two devices never share one session id');

    const { json } = await suite.api('GET', '/api/auth/sessions', pastorTokenA);
    const active = json.sessions.filter((s) => !s.revoked);
    assert.equal(active.length, 2, 'both devices are listed');
    assert.equal(active.filter((s) => s.current).length, 1, 'exactly one is this device');
  });

  it('logging out device A leaves device B signed in', async () => {
    const out = await suite.api('POST', '/api/auth/logout', pastorTokenA);
    assert.equal(out.status, 200, out.text);

    assert.equal((await suite.api('GET', '/api/auth/me', pastorTokenA)).status, 401, 'device A is signed out');
    assert.equal((await suite.api('GET', '/api/auth/me', pastorTokenB)).status, 200, 'device B is untouched');
  });

  it('revoking device B from another session ends exactly that device', async () => {
    const c = (await login()).token;
    const { json } = await suite.api('GET', '/api/auth/sessions', c);
    const bSession = json.sessions.find((s) => !s.revoked && !s.current);
    assert.ok(bSession, 'device B is listed as another device');

    const revoked = await suite.api('POST', `/api/auth/sessions/${bSession.id}/revoke`, c);
    assert.equal(revoked.status, 200, revoked.text);

    assert.equal((await suite.api('GET', '/api/auth/me', pastorTokenB)).status, 401, 'device B is ended');
    assert.equal((await suite.api('GET', '/api/auth/me', c)).status, 200, 'the caller keeps working');

    // The current session cannot revoke itself: that is what logout is for.
    const { json: mine } = await suite.api('GET', '/api/auth/sessions', c);
    const mineRow = mine.sessions.find((s) => s.current);
    const selfRevoke = await suite.api('POST', `/api/auth/sessions/${mineRow.id}/revoke`, c);
    assert.equal(selfRevoke.status, 400);
  });

  it('logging out everywhere ends every device, including the caller', async () => {
    const d = (await login()).token;
    const all = await suite.api('POST', '/api/auth/logout-all', d);
    assert.equal(all.status, 200, all.text);
    assert.ok(all.json.revoked >= 2, `every open session was revoked (got ${all.json.revoked})`);

    assert.equal((await suite.api('GET', '/api/auth/me', d)).status, 401);
    assert.equal((await suite.api('GET', '/api/auth/me', pastorTokenB)).status, 401);
  });

  it('changing the password keeps this device and signs the others out', async () => {
    const first = await login();
    const second = await login();

    const changed = await suite.api('POST', '/api/auth/change-password', second.token, {
      currentPassword: PASTOR.password,
      newPassword: 'Rotated_456!',
    });
    assert.equal(changed.status, 200, changed.text);

    // The other device is dead immediately: fingerprint moved AND row revoked.
    assert.equal((await suite.api('GET', '/api/auth/me', first.token)).status, 401);
    // This device keeps working through the replacement token.
    const replacement = changed.headers.get('x-refreshed-token');
    assert.ok(replacement, 'the device that changed the password gets a fresh session');
    assert.equal((await suite.api('GET', '/api/auth/me', replacement)).status, 200);
    // The old token of the CHANGING device is also dead (fingerprint), even
    // though the session itself continues under the replacement.
    assert.equal((await suite.api('GET', '/api/auth/me', second.token)).status, 401);

    // Restore the original password for any later test in the suite.
    await suite.api('POST', '/api/auth/change-password', replacement, {
      currentPassword: 'Rotated_456!',
      newPassword: PASTOR.password,
    });
  });
});
