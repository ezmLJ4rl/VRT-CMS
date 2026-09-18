'use strict';
/**
 * Group logos: stored with the group (never on the filesystem), served per
 * group, and accepted only when the file's own bytes say image.
 *
 * The upload path is the part worth a suite of its own, because it is the one
 * place a browser sends raw bytes to this API: the tests below feed it a real
 * PNG, a JPEG, a text file wearing a .png name, and an over-limit buffer, and
 * hold the contract: what is stored, what is served back, and what is refused.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'groups-logo', port: 4626 });
let adminToken;
let recToken;
let pastorToken;

// A real 1x1 PNG, not a bare signature, so the happy path proves the bytes
// survive the round trip untouched.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF_BYTES = Buffer.from('GIF89a', 'ascii');
const TEXT_WEARING_PNG = Buffer.from('definitely not an image, despite the name.png', 'ascii');

/** Multipart upload straight through fetch: the suite's api() helper speaks JSON only.
 *  Normalized to the same { status, json, text } shape api() returns. */
async function uploadLogo(token, groupId, filename, bytes) {
  const form = new FormData();
  form.append('logo', new Blob([bytes]), filename, { type: 'application/octet-stream' });
  const res = await fetch(`${suite.base}/api/groups/${groupId}/logo`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function getLogoBytes(token, groupId) {
  const res = await fetch(`${suite.base}/api/groups/${groupId}/logo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, contentType: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
}

after(() => suite.stop());

describe('group logos', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    adminToken = admin.json.token;

    await suite.api('POST', '/api/users', adminToken, {
      name: 'Logo Desk', email: 'logo-desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const desk = await suite.api('POST', '/api/auth/login', null, {
      email: 'logo-desk@test.local', password: 'DeskPass_123!',
    });
    recToken = desk.json.token;

    const pastor = await suite.api('POST', '/api/auth/login', null, {
      email: 'pastor@victoryrevival.church', password: 'TestPass_123!',
    });
    pastorToken = pastor.json.token;
  });

  it('lists and detail reads carry has_logo and never the bytes', async () => {
    const listed = await suite.api('GET', '/api/groups', adminToken);
    assert.equal(listed.status, 200);
    for (const g of listed.json.groups) {
      assert.equal(g.has_logo, false, 'seeded groups start logoless');
      assert.equal('logo_data' in g, false, 'the list must never carry logo bytes');
    }

    const detail = await suite.api('GET', '/api/groups/1', adminToken);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.group.has_logo, false);
    assert.equal('logo_data' in detail.json.group, false);
  });

  it('a group without a logo serves 404, not an empty image', async () => {
    const res = await getLogoBytes(adminToken, 1);
    assert.equal(res.status, 404);
  });

  it('uploads a PNG and serves the same bytes back with the right type', async () => {
    const put = await uploadLogo(adminToken, 1, 'wwk.png', PNG_1X1);
    assert.equal(put.status, 200, put.text);

    const listed = await suite.api('GET', '/api/groups', adminToken);
    const one = listed.json.groups.find((g) => g.id === 1);
    assert.equal(one.has_logo, true);
    assert.equal(listed.json.groups.filter((g) => g.has_logo).length, 1, 'only the uploaded group reports a logo');

    const served = await getLogoBytes(adminToken, 1);
    assert.equal(served.status, 200);
    assert.equal(served.contentType, 'image/png');
    assert.ok(served.bytes.equals(PNG_1X1), 'the bytes served are the bytes stored');

    const stored = await suite.get('SELECT logo_mime, logo_updated_at FROM "groups" WHERE id = 1');
    assert.equal(stored.logo_mime, 'image/png');
    assert.ok(stored.logo_updated_at, 'logo_updated_at is stamped for cache-busting');
  });

  it('accepts a JPEG and a GIF by their own magic bytes', async () => {
    const jpeg = await uploadLogo(adminToken, 2, 'cmf.jpg', JPEG_BYTES);
    assert.equal(jpeg.status, 200, jpeg.text);
    assert.equal((await suite.get('SELECT logo_mime FROM "groups" WHERE id = 2')).logo_mime, 'image/jpeg');

    const gif = await uploadLogo(adminToken, 3, 'cas.gif', GIF_BYTES);
    assert.equal(gif.status, 200, gif.text);
    assert.equal((await suite.get('SELECT logo_mime FROM "groups" WHERE id = 3')).logo_mime, 'image/gif');
  });

  it('refuses a text file no matter what it is named', async () => {
    const put = await uploadLogo(adminToken, 4, 'not-really.png', TEXT_WEARING_PNG);
    assert.equal(put.status, 400);
    // Errors travel as keys and are localized by the locale middleware on the
    // way out, so assert on the rendered sentence, not the key.
    assert.match(put.text, /not a PNG, JPEG, WebP or GIF/);
    assert.equal((await suite.get('SELECT logo_data FROM "groups" WHERE id = 4')).logo_data, null);
  });

  it('refuses an upload over the 2MB cap with an honest status', async () => {
    const tooBig = Buffer.concat([PNG_1X1, Buffer.alloc(2 * 1024 * 1024)]);
    const put = await uploadLogo(adminToken, 1, 'huge.png', tooBig);
    assert.equal(put.status, 413);
    assert.match(put.text, /too large/);
    // The failed upload must not have disturbed the earlier, good one.
    const served = await getLogoBytes(adminToken, 1);
    assert.ok(served.bytes.equals(PNG_1X1));
  });

  it('a receptionist may set a logo (front desk owns the groups section)', async () => {
    const put = await uploadLogo(recToken, 5, 'choir.png', PNG_1X1);
    assert.equal(put.status, 200, put.text);
    assert.equal((await suite.get('SELECT logo_mime FROM "groups" WHERE id = 5')).logo_mime, 'image/png');
  });

  it('a pastor cannot set or remove a logo (read-only feed)', async () => {
    const put = await uploadLogo(pastorToken, 6, 'pastor.png', PNG_1X1);
    assert.equal(put.status, 403, put.text);
    const del = await suite.api('DELETE', '/api/groups/1/logo', pastorToken);
    assert.equal(del.status, 403);
    assert.equal((await suite.get('SELECT logo_data FROM "groups" WHERE id = 6')).logo_data, null);
  });

  it('removing nulls all three columns together', async () => {
    const del = await suite.api('DELETE', '/api/groups/2/logo', adminToken);
    assert.equal(del.status, 200, del.text);
    const stored = await suite.get('SELECT logo_data, logo_mime, logo_updated_at FROM "groups" WHERE id = 2');
    assert.equal(stored.logo_data, null);
    assert.equal(stored.logo_mime, null);
    assert.equal(stored.logo_updated_at, null);
    assert.equal((await getLogoBytes(adminToken, 2)).status, 404);
  });

  it('an unknown group 404s on every logo route', async () => {
    const put = await uploadLogo(adminToken, 99999, 'ghost.png', PNG_1X1);
    assert.equal(put.status, 404);
    const del = await suite.api('DELETE', '/api/groups/99999/logo', adminToken);
    assert.equal(del.status, 404);
    assert.equal((await getLogoBytes(adminToken, 99999)).status, 404);
  });

  it('the logo writes are audited', async () => {
    const setRow = await suite.get(
      "SELECT action FROM audit_log WHERE action = 'group_logo_set' AND record_id = 1 LIMIT 1"
    );
    assert.ok(setRow, 'setting is audited');
    const rmRow = await suite.get(
      "SELECT action FROM audit_log WHERE action = 'group_logo_removed' AND record_id = 2 LIMIT 1"
    );
    assert.ok(rmRow, 'removal is audited');
  });
});
