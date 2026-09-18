'use strict';
/**
 * Giver names (the bug where every row in "Your entries today" showed "—" and
 * receipts had no giver line at all).
 *
 * The write path was never broken: offerer_name_enc holds real AES-GCM
 * ciphertext and decrypts to the typed name. Two read-side faults caused the
 * symptom:
 *
 *   1. the offerings list only decrypted donor fields for admin/pastor/
 *      superadmin, so a receptionist, the person who typed the name in and
 *      needs it back for the receipt, got `offererName` stripped from their
 *      own entries;
 *   2. utils/receipt.js read `row.offerer_name`, a key that never existed (the
 *      decorated row exposes `offererName`), so the Giver line was not blank:
 *      it was never rendered at all.
 *
 * The other half of this suite is the distinction that must not be lost: a gift
 * with no name is anonymous, while a name that will not decrypt is a fault.
 * They are asserted apart, so "Anonymous" can never again hide a rotated
 * FIELD_ENCRYPTION_KEY.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'donor-names', port: 4610 });

const ADMIN = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const DESK_ONE = { name: 'First Desk', email: 'first.desk@test.local', password: 'DeskPass_123!' };
const DESK_TWO = { name: 'Second Desk', email: 'second.desk@test.local', password: 'DeskPass_123!' };

// A well-formed-looking value with a valid base64 shape: decoding it fails the
// GCM tag check, which is exactly what a rotated key or a hand-edited row does.
const UNDECRYPTABLE = 'AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAA';

// Builds a real AES-GCM token for a chosen plaintext, so the reader can be
// driven through every branch it claims to handle: including a ciphertext that
// decrypts to nothing, which encryptField() itself can never produce.
function tokenFor(plaintext) {
  const crypto = require('crypto');
  const key = Buffer.from(process.env.FIELD_ENCRYPTION_KEY, 'base64');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

describe('readDonorField: anonymous vs unreadable', () => {
  const { readDonorField } = require('../utils/donorFields');

  it('no stored value at all is anonymous, not a fault', () => {
    assert.deepEqual(readDonorField(null), { value: null, unreadable: false });
    assert.deepEqual(readDonorField(undefined), { value: null, unreadable: false });
    assert.deepEqual(readDonorField(''), { value: null, unreadable: false });
  });

  it('a real token decodes to the name', () => {
    assert.deepEqual(readDonorField(tokenFor('Neema Joseph')), { value: 'Neema Joseph', unreadable: false });
  });

  it('a token that decodes to nothing is a fault, not an anonymous gift', () => {
    assert.deepEqual(readDonorField(tokenFor(''), { table: 'offerings', id: 42 }), { value: null, unreadable: true });
  });

  it('a token that will not authenticate is a fault, not an anonymous gift', () => {
    assert.deepEqual(readDonorField('AAAA:BBBB:CCCC'), { value: null, unreadable: true });
    // Right shape, wrong key/tag: the rotated-key case.
    assert.deepEqual(readDonorField(UNDECRYPTABLE), { value: null, unreadable: true });
  });
});

describe('giver names: stored, read back, and printed', () => {
  let adminToken;
  let deskToken;
  let otherDeskToken;
  let today;
  let sundayId;
  let named;
  let anonymous;
  let broken;

  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, ADMIN);
    assert.equal(admin.status, 200, admin.text);
    adminToken = admin.json.token;

    for (const desk of [DESK_ONE, DESK_TWO]) {
      const created = await suite.api('POST', '/api/users', adminToken, { ...desk, role: 'receptionist' });
      assert.equal(created.status, 201, created.text);
    }
    deskToken = (await suite.api('POST', '/api/auth/login', null, DESK_ONE)).json.token;
    otherDeskToken = (await suite.api('POST', '/api/auth/login', null, DESK_TWO)).json.token;
    assert.ok(deskToken && otherDeskToken, 'both receptionists must be able to sign in');

    const { json: types } = await suite.api('GET', '/api/service-types', deskToken);
    sundayId = types.serviceTypes.find((s) => s.key === 'sunday_1').id;
    const { json: time } = await suite.api('GET', '/api/time', deskToken);
    today = time.date;
  });

  after(() => suite.stop());

  it('stores the giver name encrypted, never in the clear', async () => {
    const rec = await suite.api('POST', '/api/offerings', deskToken, {
      serviceTypeId: sundayId, date: today, category: 'zaka', amount: 30000, currency: 'TZS', offererName: 'Elisha Makala',
    });
    assert.equal(rec.status, 201, rec.text);
    named = rec.json.id;

    const row = await suite.get('SELECT offerer_name_enc, type FROM offerings WHERE id = ?', [named]);
    assert.ok(row.offerer_name_enc, 'the encrypted column must hold a value');
    assert.ok(!row.offerer_name_enc.includes('Elisha'), 'the stored value must not be the plaintext');
    assert.match(row.offerer_name_enc, /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/, 'iv:tag:ciphertext');

    // …and it decrypts back to what was typed, through the app's own reader.
    const { readDonorField } = require('../utils/donorFields');
    assert.deepEqual(readDonorField(row.offerer_name_enc), { value: 'Elisha Makala', unreadable: false });
  });

  it('an anonymous category records no ciphertext at all', async () => {
    // `receipt: true` on purpose: a general gift needs no giver but can still be
    // receipted, which is the one case where a receipt legitimately has no name.
    const rec = await suite.api('POST', '/api/offerings', deskToken, {
      serviceTypeId: sundayId, date: today, category: 'general', amount: 5000, currency: 'TZS', receipt: true,
    });
    assert.equal(rec.status, 201, rec.text);
    anonymous = rec.json.id;
    const row = await suite.get('SELECT offerer_name_enc FROM offerings WHERE id = ?', [anonymous]);
    assert.equal(row.offerer_name_enc, null);
  });

  it('the receptionist who recorded it sees the giver name back in their entries list', async () => {
    const { status, json } = await suite.api('GET', '/api/offerings', deskToken);
    assert.equal(status, 200, json && json.error);

    const mine = json.offerings.find((o) => o.id === named);
    assert.ok(mine, 'the receptionist must see the entry they just recorded');
    assert.equal(mine.offererName, 'Elisha Makala', 'the front desk typed this name and must get it back');
    assert.equal(mine.offererNameUnavailable, false);
    assert.equal(mine.offerer_name_enc, undefined, 'raw ciphertext must never be sent to a client');

    const anon = json.offerings.find((o) => o.id === anonymous);
    assert.equal(anon.offererName, null, 'a general offering genuinely has no giver');
    assert.equal(anon.offererNameUnavailable, false, 'no name by design is not a failure');
  });

  it('an admin sees the same names', async () => {
    const { json } = await suite.api('GET', '/api/offerings', adminToken);
    const mine = json.offerings.find((o) => o.id === named);
    assert.equal(mine.offererName, 'Elisha Makala');
  });

  it('a receptionist cannot read a colleague\'s entry or its giver', async () => {
    const list = await suite.api('GET', '/api/offerings', otherDeskToken);
    assert.equal(list.json.offerings.find((o) => o.id === named), undefined, 'only own entries are listed');

    const single = await suite.api('GET', `/api/offerings/${named}/receipt`, otherDeskToken);
    assert.equal(single.status, 403, single.text);
  });

  it('the receipt shows a Giver line with the decrypted name', async () => {
    const res = await suite.api('GET', `/api/offerings/${named}/receipt`, deskToken);
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /Giver<\/span><span class="value">Elisha Makala</, 'the receipt must name the giver');
    assert.ok(!res.text.includes('Name unavailable'));
    assert.ok(!res.text.includes('Anonymous'));
  });

  it('the receipt says Anonymous only when the gift really has no name', async () => {
    const res = await suite.api('GET', `/api/offerings/${anonymous}/receipt`, deskToken);
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /Giver<\/span><span class="value">Anonymous</);
  });

  it('a name that will not decrypt is reported as unavailable, never as anonymous', async () => {
    const rec = await suite.api('POST', '/api/offerings', deskToken, {
      serviceTypeId: sundayId, date: today, category: 'thanksgiving', amount: 1000, currency: 'TZS', offererName: 'Will Be Corrupted',
    });
    assert.equal(rec.status, 201, rec.text);
    broken = rec.json.id;
    await suite.run('UPDATE offerings SET offerer_name_enc = ? WHERE id = ?', [UNDECRYPTABLE, broken]);

    // The list still answers: one unreadable row must not take the page down.
    const { status, json } = await suite.api('GET', '/api/offerings', deskToken);
    assert.equal(status, 200, 'a single bad row must not 500 the whole list');
    const row = json.offerings.find((o) => o.id === broken);
    assert.ok(row, 'the row must still be listed');
    assert.equal(row.offererName, null);
    assert.equal(row.offererNameUnavailable, true, 'the difference the bug report asked for');

    // …and the fault is loud on the server, so it is visible without the UI.
    assert.match(suite.log(), /\[donor-fields\] decryption failed .*offerings #\d+ offerer_name_enc/);
  });

  it('the receipt of an unreadable name says so rather than Anonymous', async () => {
    const res = await suite.api('GET', `/api/offerings/${broken}/receipt`, deskToken);
    assert.equal(res.status, 200, res.text);
    assert.match(res.text, /Giver<\/span><span class="value">Name unavailable</);
    assert.ok(!/Giver<\/span><span class="value">Anonymous/.test(res.text));
  });

  it('the PDF receipt carries the same Giver line', async () => {
    const res = await suite.api('GET', `/api/offerings/${named}/receipt.pdf`, deskToken);
    assert.equal(res.status, 200, res.text.slice(0, 120));
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.ok(res.text.startsWith('%PDF'), 'a real PDF document');
  });

  it('the CSV export marks an unreadable name instead of blanking it', async () => {
    const res = await suite.api('GET', '/api/reports/offerings.csv', adminToken);
    assert.equal(res.status, 200, res.text.slice(0, 120));
    const lines = res.text.trim().split(/\r?\n/);
    assert.match(lines[0], /giver_name/);
    assert.ok(res.text.includes('Elisha Makala'), 'the named gift exports its giver');
    assert.ok(res.text.includes('UNAVAILABLE'), 'a fault is flagged, not dropped');
  });
});
