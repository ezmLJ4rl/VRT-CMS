'use strict';
/**
 * How a gift was paid, and the reference that came with it.
 *
 * An offering records cash, mobile money, a bank transfer or a cheque, plus the
 * number the desk wrote down beside it (a mobile-money confirmation code, a bank
 * slip or a cheque number). The rules worth protecting:
 *
 *   1. it is a CLOSED vocabulary: a method nobody can label is refused rather
 *      than stored, so no report ever shows an unreadable bucket;
 *   2. "not recorded" is stored as NULL and stays NULL: a gift whose method
 *      nobody entered is never reported as cash;
 *   3. the receipt and the public verification page both say how the gift was
 *      paid, in the language of the person reading them, with the label rather
 *      than the stored key;
 *   4. a correction keeps the payment facts (the money did not change hands a
 *      second time), and may restate the method when it was typed wrong;
 *   5. the reports can total and drill by method, and the offerings export
 *      carries the two columns.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'payment-methods', port: 4631 });

const ADMIN = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const DESK = { email: 'payments.desk@test.local', password: 'DeskPass_123!' };
const SW = { 'X-Language': 'sw' };

let adminToken;
let deskToken;

after(() => suite.stop());

/** A receipted gift, the way the front desk records it. */
async function record(extra = {}) {
  const res = await suite.api('POST', '/api/offerings', deskToken, {
    serviceTypeId: 1, category: 'zaka', amount: 50000, currency: 'TZS',
    offererName: 'Elisha Makala', receipt: true, ...extra,
  });
  return res;
}

async function row(id) {
  return suite.get('SELECT * FROM offerings WHERE id = ?', [id]);
}

async function recordOk(extra = {}) {
  const res = await record(extra);
  assert.equal(res.status, 201, res.text);
  return res.json;
}

describe('recording how a gift was paid', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, ADMIN);
    assert.equal(admin.status, 200, admin.text);
    adminToken = admin.json.token;

    const created = await suite.api('POST', '/api/users', adminToken, {
      name: 'Payments Desk', email: DESK.email, role: 'receptionist', password: DESK.password,
    });
    assert.equal(created.status, 201, created.text);
    const login = await suite.api('POST', '/api/auth/login', null, DESK);
    assert.equal(login.status, 200, login.text);
    deskToken = login.json.token;
  });

  it('stores the method and the reference the desk wrote down', async () => {
    const created = await recordOk({ paymentMethod: 'mobile_money', paymentReference: '  MP24 0916   001  ' });
    const stored = await row(created.id);

    assert.equal(stored.payment_method, 'mobile_money');
    // Stored as typed-but-tidy: outer whitespace gone, inner runs collapsed,
    // the same code pasted twice must not become two different references.
    assert.equal(stored.payment_reference, 'MP24 0916 001');
  });

  it('accepts every method the church records', async () => {
    for (const method of ['cash', 'mobile_money', 'bank', 'cheque']) {
      const created = await recordOk({ paymentMethod: method });
      assert.equal((await row(created.id)).payment_method, method);
    }
  });

  it('records "no method" as no method, never as cash', async () => {
    // A gift entered by a client that does not send one (or recorded before this
    // feature existed) must not be reported as if the church had said "cash".
    const created = await recordOk();
    assert.equal((await row(created.id)).payment_method, null);
    assert.equal((await row(created.id)).payment_reference, null);

    // An explicit empty string is the same thing as omitting it.
    const blank = await recordOk({ paymentMethod: '', paymentReference: '   ' });
    assert.equal((await row(blank.id)).payment_method, null);
    assert.equal((await row(blank.id)).payment_reference, null);
  });

  it('refuses a method it cannot label, in the caller\'s language', async () => {
    const bad = await record({ paymentMethod: 'mpesa' });
    assert.equal(bad.status, 400, bad.text);
    assert.equal(bad.json.error, 'Payment method must be cash, mobile money, bank or cheque.');
    // The value must not have been stored alongside the refusal.
    assert.equal(await suite.get('SELECT id FROM offerings WHERE payment_method = ?', ['mpesa']), undefined);

    const swahili = await suite.api('POST', '/api/offerings', deskToken, {
      serviceTypeId: 1, category: 'zaka', amount: 1000, offererName: 'Elisha Makala', paymentMethod: 'mpesa',
    }, SW);
    assert.equal(swahili.status, 400);
    assert.match(swahili.json.error, /^Njia ya malipo lazima iwe/, swahili.json.error);
  });

  it('refuses a reference with no method to place it', async () => {
    const res = await record({ paymentReference: 'MP240916001' });
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.error, 'Choose how this gift was paid. A reference number on its own cannot be filed.');
  });

  it('caps the reference so a pasted paragraph cannot reach a receipt', async () => {
    const tooLong = await record({ paymentMethod: 'bank', paymentReference: 'X'.repeat(65) });
    assert.equal(tooLong.status, 400, tooLong.text);
    assert.match(tooLong.json.error, /too long/);

    // …and the limit itself is allowed, so the boundary is exact rather than
    // off by one in whichever direction someone guessed.
    const atLimit = await recordOk({ paymentMethod: 'bank', paymentReference: 'Y'.repeat(64) });
    assert.equal((await row(atLimit.id)).payment_reference.length, 64);
  });

  it('filters the offerings list by method, which is what a report drills into', async () => {
    const created = await recordOk({ paymentMethod: 'cheque', paymentReference: 'CHQ-000123' });

    const filtered = await suite.api('GET', '/api/offerings?paymentMethod=cheque', adminToken);
    assert.equal(filtered.status, 200, filtered.text);
    const ids = filtered.json.offerings.map((o) => o.id);
    assert.ok(ids.includes(created.id), 'the cheque gift is in the filtered list');
    assert.ok(
      filtered.json.offerings.every((o) => o.payment_method === 'cheque'),
      'and nothing else is'
    );
  });
});

describe('the receipt says how the gift was paid', () => {
  let mobileMoneyId;
  let blankId;

  before(async () => {
    await suite.waitReady();
    const mobile = await record({
      paymentMethod: 'mobile_money', paymentReference: 'MP240916001',
    });
    assert.equal(mobile.status, 201, mobile.text);
    mobileMoneyId = mobile.json.id;

    const blank = await record({ amount: 2000 });
    assert.equal(blank.status, 201, blank.text);
    blankId = blank.json.id;
  });

  it('prints the method and the reference on the receipt, in English', async () => {
    const res = await suite.api('GET', `/api/offerings/${mobileMoneyId}/receipt`, deskToken);
    assert.equal(res.status, 200, res.text.slice(0, 200));

    assert.match(res.text, /Payment method<\/span><span class="value">Mobile money</);
    assert.match(res.text, /Payment reference<\/span><span class="value">MP240916001</);
    // The stored key is never what a donor reads.
    assert.ok(!res.text.includes('mobile_money'), 'the raw enum must not be printed');
  });

  it('prints them translated, with no English label left behind', async () => {
    const res = await suite.api('GET', `/api/offerings/${mobileMoneyId}/receipt`, deskToken, null, SW);
    assert.equal(res.status, 200, res.text.slice(0, 200));

    assert.match(res.text, /Njia ya malipo<\/span><span class="value">Pesa za simu</);
    assert.match(res.text, /Kumbukumbu ya malipo<\/span><span class="value">MP240916001</);
    for (const english of ['Payment method', 'Payment reference', 'Mobile money']) {
      assert.ok(!res.text.includes(english), `the Kiswahili receipt still shows "${english}"`);
    }
  });

  it('prints neither line for a gift whose method was never recorded', async () => {
    // A receipt with an empty "Payment method:" row would read as a claim that
    // something was recorded and came out blank.
    const res = await suite.api('GET', `/api/offerings/${blankId}/receipt`, deskToken);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.ok(!res.text.includes('Payment method'), 'no method row');
    assert.ok(!res.text.includes('Payment reference'), 'no reference row');
  });

  it('carries the same two lines into the PDF, in the language asked for', async () => {
    const english = await suite.api('GET', `/api/offerings/${mobileMoneyId}/receipt.pdf`, deskToken);
    const swahili = await suite.api('GET', `/api/offerings/${mobileMoneyId}/receipt.pdf`, deskToken, null, SW);
    assert.equal(english.status, 200, english.text.slice(0, 120));
    assert.equal(swahili.status, 200, swahili.text.slice(0, 120));
    assert.ok(english.text.startsWith('%PDF') && swahili.text.startsWith('%PDF'));
    assert.notEqual(english.text, swahili.text, 'the PDF follows the reader like the HTML one');
  });
});

describe('the public verification page answers with the payment too', () => {
  let token;
  let blankToken;

  before(async () => {
    await suite.waitReady();
    const mobile = await record({ paymentMethod: 'bank', paymentReference: 'CRDB-88213' });
    assert.equal(mobile.status, 201, mobile.text);
    token = (await row(mobile.json.id)).verification_token;

    const blank = await record({ amount: 3000 });
    assert.equal(blank.status, 201, blank.text);
    blankToken = (await row(blank.json.id)).verification_token;
  });

  it('returns the payment as JSON, labelled for the reader', async () => {
    const res = await suite.api('GET', `/api/verify/receipt/${token}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.verified, true);
    assert.equal(res.json.receipt.paymentMethod, 'Bank transfer');
    assert.equal(res.json.receipt.paymentReference, 'CRDB-88213');

    const swahili = await suite.api('GET', `/api/verify/receipt/${token}?lang=sw`);
    assert.equal(swahili.json.receipt.paymentMethod, 'Benki');
  });

  it('shows them on the page a member scans, in the member\'s language', async () => {
    const english = await suite.api('GET', `/verify/receipt/${token}`);
    assert.equal(english.status, 200, english.text.slice(0, 200));
    assert.match(english.text, /Payment method<\/span><span class="value">Bank transfer</);
    assert.match(english.text, /Payment reference<\/span><span class="value">CRDB-88213</);

    const swahili = await suite.api('GET', `/verify/receipt/${token}?lang=sw`);
    assert.match(swahili.text, /Njia ya malipo<\/span><span class="value">Benki</);
    assert.match(swahili.text, /Kumbukumbu ya malipo<\/span><span class="value">CRDB-88213</);
  });

  it('omits the payment rows entirely when nothing was recorded', async () => {
    const res = await suite.api('GET', `/verify/receipt/${blankToken}`);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.ok(!res.text.includes('Payment method'));
    assert.ok(!res.text.includes('Payment reference'));
    // …and the receipt still verifies: an unrecorded method is not a fault.
    assert.match(res.text, /✓/);
  });

  it('still withholds the giver, even beside a payment reference', async () => {
    // The reference is on the paper the member is holding; the giver's name is
    // not something the lookup reads at all (see utils/receiptVerification.js).
    const res = await suite.api('GET', `/verify/receipt/${token}`);
    assert.ok(!res.text.includes('Elisha Makala'), 'the giver must not appear');
    assert.ok(!res.text.includes('offerer'), 'no donor field may leak');
  });
});

describe('a correction keeps the payment facts', () => {
  it('carries the method and reference onto the corrected entry', async () => {
    const original = await recordOk({ paymentMethod: 'cheque', paymentReference: 'CHQ-000456' });
    const voided = await suite.api('PATCH', `/api/offerings/${original.id}/void`, adminToken, { reason: 'Amount mistyped' });
    assert.equal(voided.status, 200, voided.text);

    const adjusted = await suite.api('POST', `/api/offerings/${original.id}/adjust`, adminToken, { amount: 60000, reason: 'Correct amount' });
    assert.equal(adjusted.status, 201, adjusted.text);

    const corrected = await row(adjusted.json.id);
    assert.equal(corrected.payment_method, 'cheque');
    assert.equal(corrected.payment_reference, 'CHQ-000456');
    // The receipt identity moved with it, so the paper already handed out still
    // resolves: now also showing that it was paid by cheque.
    assert.equal(corrected.receipt_number, original.receiptNumber);
    const receipt = await suite.api('GET', `/api/offerings/${corrected.id}/receipt`, adminToken);
    assert.match(receipt.text, /Payment method<\/span><span class="value">Cheque</);
  });

  it('lets a correction restate a method that was typed wrong', async () => {
    const original = await recordOk({ paymentMethod: 'cash' });
    await suite.api('PATCH', `/api/offerings/${original.id}/void`, adminToken, { reason: 'Recorded as cash by mistake' });

    const adjusted = await suite.api('POST', `/api/offerings/${original.id}/adjust`, adminToken, {
      amount: 50000, reason: 'It was a bank transfer', paymentMethod: 'bank', paymentReference: 'NMB-5512',
    });
    assert.equal(adjusted.status, 201, adjusted.text);
    const corrected = await row(adjusted.json.id);
    assert.equal(corrected.payment_method, 'bank');
    assert.equal(corrected.payment_reference, 'NMB-5512');
  });

  it('refuses a nonsense method on a correction, without touching the ledger', async () => {
    const original = await recordOk({ paymentMethod: 'cash' });
    await suite.api('PATCH', `/api/offerings/${original.id}/void`, adminToken, { reason: 'mistake' });

    const before = await suite.get('SELECT COUNT(*)::int AS n FROM offerings');
    const adjusted = await suite.api('POST', `/api/offerings/${original.id}/adjust`, adminToken, {
      amount: 50000, paymentMethod: 'crypto',
    });
    assert.equal(adjusted.status, 400, adjusted.text);
    assert.equal(adjusted.json.error, 'Payment method must be cash, mobile money, bank or cheque.');
    assert.equal((await suite.get('SELECT COUNT(*)::int AS n FROM offerings')).n, before.n, 'no correction was written');
  });
});

describe('the reports can total and drill by method', () => {
  it('breaks giving down by how it came in, with "not recorded" as its own bucket', async () => {
    const res = await suite.api('GET', '/api/reports/breakdown?groupBy=payment', adminToken);
    assert.equal(res.status, 200, res.text);

    const byKey = Object.fromEntries(res.json.breakdown.map((r) => [String(r.key), r]));

    // Each method is totalled on its own, against the ledger itself rather than
    // against a number written down in this file: a breakdown that quietly drops
    // a method, or folds one into another, fails here.
    for (const method of ['cash', 'mobile_money', 'bank', 'cheque']) {
      const expected = await suite.get(
        'SELECT COUNT(*)::int AS gifts, COALESCE(SUM(amount), 0) AS total FROM offerings WHERE payment_method = ? AND voided_at IS NULL',
        [method]
      );
      assert.ok(byKey[method], `${method} must appear in the breakdown`);
      assert.equal(byKey[method].gifts, expected.gifts, method);
      assert.equal(Number(byKey[method].amount), Number(expected.total), method);
    }

    // Gifts with no method recorded are a bucket of their own, named honestly by
    // the client, never folded into cash, which is what a default would do.
    const unrecorded = await suite.get(
      'SELECT COUNT(*)::int AS gifts, COALESCE(SUM(amount), 0) AS total FROM offerings WHERE payment_method IS NULL AND voided_at IS NULL'
    );
    assert.ok(byKey.null, 'gifts with no method recorded are reported, not hidden');
    assert.ok(unrecorded.gifts > 0, 'this suite records some gifts with no method');
    assert.equal(byKey.null.gifts, unrecorded.gifts);
    assert.equal(Number(byKey.null.amount), Number(unrecorded.total));

    // Money, not just counts: the totals add back up to the ledger.
    const total = res.json.breakdown.reduce((sum, r) => sum + Number(r.amount), 0);
    const ledger = await suite.get('SELECT COALESCE(SUM(amount), 0) AS total FROM offerings WHERE voided_at IS NULL');
    assert.equal(total, Number(ledger.total), 'the breakdown must account for every live gift');
  });

  it('refuses an unknown groupBy with a message that names the supported ones', async () => {
    const res = await suite.api('GET', '/api/reports/breakdown?groupBy=somethingelse', adminToken);
    assert.equal(res.status, 400, res.text);
    assert.equal(res.json.error, 'groupBy must be service, rehearsal, center, group, category, payment or day.');
  });

  it('adds both columns to the offerings export, keyed rather than labelled', async () => {
    const res = await suite.api('GET', '/api/reports/offerings.csv', adminToken);
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const [header, ...rows] = res.text.trim().split('\n');

    assert.ok(header.includes('payment_method'), header);
    assert.ok(header.includes('payment_reference'), header);
    // A spreadsheet has no interface language, so the export carries the stored
    // key (attendance.csv exports `mode` the same way).
    assert.ok(rows.some((r) => r.includes('mobile_money')), 'a mobile-money row');
    assert.ok(rows.some((r) => r.includes('MP240916001')), 'its reference');
    // json2csv quotes every cell, so an unrecorded method and an absent
    // reference are the pair of empty cells right after the currency.
    assert.ok(rows.some((r) => r.includes(',"","",')), 'gifts with no method export an empty cell');
  });
});
