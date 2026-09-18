'use strict';
/**
 * Receipt verification by QR code, and the boundary around it.
 *
 * Every receipt carries a QR code whose URL resolves to THAT receipt, through an
 * unguessable token. The rules worth protecting:
 *
 *   1. one token per receipt, minted with the receipt and never guessable from
 *      the receipt number, the offering id, or a neighbour's token;
 *   2. the QR code is on the receipt (screen, print and PDF) and points at
 *      /verify/receipt/<token>, never at a day's audit chain, which is a
 *      separate, admin-only check (`GET /api/reports/audit/verify`, covered in
 *      the last describe here);
 *   3. the public answer shows the receipt, not the donor: no name, no phone,
 *      no staff member;
 *   4. a receipt that has been revoked or whose offering was voided says so:
 *      it does not simply disappear, and it never keeps verifying as valid;
 *   5. a correction that reuses the receipt number keeps the SAME verification
 *      identity, so the paper already in a member's hands still resolves.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'receipt-verification', port: 4630 });

// Required AFTER startServer, deliberately: utils/receipt.js pulls in db/pg.js,
// which refuses to load under NODE_ENV=test unless DATABASE_URL already points
// at a throwaway database, and startServer is what repoints it
// synchronously. (Requiring it at the top of the file fails loudly, which is the
// guard doing its job.)
const { verificationUrl, generateVerificationToken } = require('../utils/verificationToken');
const { renderReceiptHtml } = require('../utils/receipt');
const { qrSvg } = require('../utils/qr');

const ADMIN = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const DESK = { email: 'receipt.desk@test.local', password: 'DeskPass_123!' };

let adminToken;
let deskToken;

after(() => suite.stop());

/** A receipted gift, the way the front desk records it. */
async function recordReceipted(amount = 50000, extra = {}) {
  const res = await suite.api('POST', '/api/offerings', deskToken, {
    serviceTypeId: 1, category: 'zaka', amount, currency: 'TZS', offererName: 'Elisha Makala', receipt: true, ...extra,
  });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

async function offeringRow(id) {
  return suite.get('SELECT * FROM offerings WHERE id = ?', [id]);
}

async function verifyJson(token) {
  return suite.api('GET', `/api/verify/receipt/${token}`, null);
}

describe('receipt verification', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, ADMIN);
    assert.equal(admin.status, 200, admin.text);
    adminToken = admin.json.token;

    const created = await suite.api('POST', '/api/users', adminToken, {
      name: 'Receipt Desk', email: DESK.email, role: 'receptionist', password: DESK.password,
    });
    assert.equal(created.status, 201, created.text);
    const login = await suite.api('POST', '/api/auth/login', null, DESK);
    assert.equal(login.status, 200, login.text);
    deskToken = login.json.token;
  });

  // ---------------------------------------------------------------------------
  // 1. The token
  // ---------------------------------------------------------------------------
  describe('every receipt gets its own unguessable credential', () => {
    it('mints a token with the receipt number, and never exposes the id as one', async () => {
      const created = await recordReceipted(50000);
      const row = await offeringRow(created.id);

      assert.ok(row.receipt_number, 'a receipt number was allocated');
      assert.match(row.verification_token, /^[A-Za-z0-9_-]{32,}$/, 'a 32+ character url-safe token');
      assert.equal(row.verification_status, 'active');
      // The credential must not be derivable from anything already printed or
      // guessable: not the id, not the receipt number, not a hash of either. The
      // test is on the whole receipt number's digits, which is the value that
      // would really leak (a bare "1" appears in a random token often enough
      // that asserting on it would only be a flaky test).
      assert.notEqual(row.verification_token, String(row.id));
      assert.ok(!row.verification_token.includes(row.receipt_number.replace(/[^0-9]/g, '')));
      assert.ok(!row.verification_token.includes(row.receipt_number));

      // The recording response hands the link back so the desk can print it.
      assert.equal(created.verificationUrl, verificationUrl(row.verification_token));
      assert.ok(created.verificationUrl.endsWith(`/verify/receipt/${row.verification_token}`));
      assert.ok(!created.verificationUrl.includes('/audit'), 'a receipt QR never points at the audit chain');
    });

    it('never issues the same token twice', async () => {
      const seen = new Set();
      for (let i = 0; i < 5; i += 1) {
        const created = await recordReceipted(1000 + i);
        const row = await offeringRow(created.id);
        assert.ok(!seen.has(row.verification_token), 'tokens must be unique');
        seen.add(row.verification_token);
      }
      assert.equal(seen.size, 5);
    });

    it('leaves an offering without a receipt without a credential', async () => {
      const res = await suite.api('POST', '/api/offerings', deskToken, {
        serviceTypeId: 1, category: 'general', amount: 1200, currency: 'TZS',
      });
      assert.equal(res.status, 201, res.text);
      const row = await offeringRow(res.json.id);
      assert.equal(row.receipt_number, null);
      assert.equal(row.verification_token, null);
      assert.equal(res.json.verificationUrl, null);
    });

    it('is reachable in the front desk\'s own list, so a receipt can be reprinted', async () => {
      const created = await recordReceipted(7000);
      const res = await suite.api('GET', '/api/offerings', deskToken);
      assert.equal(res.status, 200, res.text);
      const listed = res.json.offerings.find((o) => o.id === created.id);
      assert.ok(listed, 'the row is in the list');
      assert.equal(listed.verification_status, 'active');
      assert.equal(listed.verification_url, created.verificationUrl);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. The printed documents
  // ---------------------------------------------------------------------------
  describe('the QR code is on the receipt itself', () => {
    let id;
    let token;

    before(async () => {
      const created = await recordReceipted(50000);
      id = created.id;
      token = (await offeringRow(id)).verification_token;
    });

    it('prints the verification block in the HTML receipt', async () => {
      const res = await suite.api('GET', `/api/offerings/${id}/receipt`, deskToken);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      const embedded = res.text.match(/<svg[\s\S]*?<\/svg>/);
      assert.ok(embedded, 'the QR code is inline in the document');
      assert.ok(res.text.includes('Scan to verify this receipt'));
      assert.ok(res.text.includes('Verification QR code'), 'the code is labelled for screen readers');
      assert.ok(res.text.includes('cms.vrtchurch.org'), 'the host is printed as a trust cue beside the code');

      // The code printed on the receipt is the QR of THIS receipt's verification
      // URL, not of another token, and not of a day's audit chain.
      assert.equal(embedded[0], qrSvg(verificationUrl(token), { size: 150 }));
      assert.ok(verificationUrl(token).includes(token));
    });

    it('prints it in Kiswahili too, instruction and all', async () => {
      const res = await suite.api('GET', `/api/offerings/${id}/receipt`, deskToken, null, { 'X-Language': 'sw' });
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.ok(res.text.includes('Skani ili kuthibitisha risiti hii'));
      assert.ok(!res.text.includes('Scan to verify this receipt'), 'no English label may survive');
    });

    it('embeds the QR image in the PDF as well', async () => {
      const withQr = await suite.api('GET', `/api/offerings/${id}/receipt.pdf`, deskToken);
      assert.equal(withQr.status, 200, withQr.text.slice(0, 120));
      assert.ok(withQr.text.startsWith('%PDF'));
      // pdfkit writes the PNG QR as an image XObject; nothing else on a receipt
      // is an image, so this is the code's signature in the file.
      assert.ok(withQr.text.includes('/Image'), 'the PDF must carry the QR image');

      // …and a receipt-like row with no token renders without one rather than
      // printing a code that points nowhere.
      const bare = renderReceiptHtml({
        receipt_number: 'VR-2026-0001', service_date: '2026-09-13', service_name: 'Sunday Service',
        amount: 1000, currency: 'TZS', recorded_by_name: 'Front Desk',
      }, 'en');
      assert.ok(!bare.includes('<svg'), 'no QR block without a token');
      assert.ok(!bare.includes('Scan to verify'), 'and no orphaned instruction');
    });

    it('renders a crisp vector code with a quiet zone, not a blurry bitmap', () => {
      const svg = qrSvg('https://cms.vrtchurch.org/verify/receipt/abc');
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('shape-rendering="crispEdges"'), 'squares stay square when printed');
      assert.ok(svg.includes('fill="#ffffff"'), 'the quiet zone is white, for camera contrast');
      assert.ok(svg.includes('fill="#111111"'));
      // The quiet zone is part of the viewBox: a code printed flush against the
      // receipt's border cannot be found by a scanner.
      assert.ok(!/viewBox="0 0 33 33"/.test(svg), 'the viewBox includes the quiet zone');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. What a member sees when they scan
  // ---------------------------------------------------------------------------
  describe('the public verification route', () => {
    let created;
    let row;

    before(async () => {
      created = await recordReceipted(50000, { offererPhone: '+255700000009' });
      row = await offeringRow(created.id);
    });

    it('verifies the receipt over JSON, with no login at all', async () => {
      const res = await verifyJson(row.verification_token);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.verified, true);
      assert.equal(res.json.status, 'active');
      assert.equal(res.json.receipt.receiptNumber, row.receipt_number);
      assert.equal(res.json.receipt.amount, 50000);
      assert.equal(res.json.receipt.currency, 'TZS');
      assert.match(res.json.receipt.amountLabel, /TZS\s50,000/);
      assert.equal(res.json.receipt.church, 'Victory Revival Temple');
      assert.equal(res.json.receipt.offeringType, 'Zaka (Tithe)');
      assert.ok(res.json.receipt.dateLabel);
    });

    it('shows the receipt and nothing about the donor or the staff', async () => {
      const res = await verifyJson(row.verification_token);
      const body = JSON.stringify(res.json);
      assert.ok(!body.includes('Elisha'), 'the giver is never exposed by the verification route');
      assert.ok(!body.includes('255700000009'), 'nor their phone number');
      assert.ok(!body.includes('Receipt Desk'), 'nor who recorded it');
      // The internal row id is sequential and enumerable: it must not travel.
      assert.ok(!Object.values(res.json.receipt).includes(row.id));
      assert.deepEqual(
        Object.keys(res.json.receipt).sort(),
        ['amount', 'amountLabel', 'church', 'currency', 'date', 'dateLabel', 'offeringType', 'paymentMethod', 'paymentReference', 'reason', 'receiptNumber', 'recordedAt', 'recordedAtLabel', 'service', 'status', 'verified', 'voided'].sort(),
        'the public receipt view is a fixed, deliberate set of fields'
      );
      // How the gift was paid IS part of that set (the reference is printed on
      // the very paper being scanned), while the donor and the staff member are
      // not: see utils/receiptVerification.js. This gift was recorded without
      // either, so both are honestly null rather than absent.
      assert.equal(res.json.receipt.paymentMethod, null);
      assert.equal(res.json.receipt.paymentReference, null);
    });

    it('serves the page the QR code actually opens', async () => {
      const res = await suite.api('GET', `/verify/receipt/${row.verification_token}`, null);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.match(res.text, /<html lang="en">/);
      assert.ok(res.text.includes('Receipt Verified'));
      assert.ok(res.text.includes('✓'));
      assert.ok(res.text.includes(row.receipt_number));
      assert.match(res.text, /TZS\s50,000/);
      assert.ok(res.text.includes('Victory Revival Temple'));
      assert.ok(res.text.includes('noindex'), 'a shared verification URL must not be indexed');
      assert.ok(!res.text.includes('/admin/audit'), 'the audit chain is not reachable from a receipt');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    it('answers in the scanner\'s own language', async () => {
      const res = await suite.api('GET', `/verify/receipt/${row.verification_token}`, null, null, { 'X-Language': 'sw' });
      assert.match(res.text, /<html lang="sw">/);
      assert.ok(res.text.includes('Risiti imethibitishwa'));
      assert.ok(res.text.includes('Namba ya risiti'));
      assert.ok(!res.text.includes('Receipt Verified'), 'no English label may survive');
    });

    it('cannot be used as a sequential-id oracle', async () => {
      // The offering id, the receipt number, and a neighbour's token are all
      // rejected: none of them is a credential.
      for (const guess of [String(row.id), row.receipt_number, row.receipt_number.replace(/[^0-9]/g, '')]) {
        const res = await verifyJson(encodeURIComponent(guess));
        assert.equal(res.status, 404, `"${guess}" must not verify anything`);
        assert.equal(res.json.verified, false);
        assert.equal(res.json.status, 'not_found');
        assert.equal(res.json.receipt, null);
      }
    });

    it('answers a code it does not know with an honest not-found, not an error', async () => {
      const unknown = generateVerificationToken();
      const json = await verifyJson(unknown);
      assert.equal(json.status, 404);
      assert.equal(json.json.status, 'not_found');
      assert.equal(json.json.error, 'No receipt matches this verification code.');

      const page = await suite.api('GET', `/verify/receipt/${unknown}`, null);
      assert.equal(page.status, 404, 'the page is a 404 so link checkers see the truth');
      assert.ok(page.text.includes('Receipt Not Found'));

      // Junk is rejected before it ever reaches the database.
      for (const junk of ['short', 'has spaces here', '../../etc/passwd', 'x'.repeat(200)]) {
        const res = await verifyJson(encodeURIComponent(junk));
        assert.equal(res.status, 404, `"${junk}" must not be a credential`);
      }

      // A scan that lost the token lands on the explanation, not a blank 404.
      const bare = await suite.api('GET', '/verify/receipt', null);
      assert.equal(bare.status, 404);
      assert.ok(bare.text.includes('Receipt Not Found'));
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Revoked receipts
  // ---------------------------------------------------------------------------
  describe('a revoked receipt says so', () => {
    it('flips to revoked when the offering is voided, and stays findable', async () => {
      const created = await recordReceipted(30000);
      const before = await offeringRow(created.id);
      assert.equal((await verifyJson(before.verification_token)).json.verified, true);

      const voided = await suite.api('PATCH', `/api/offerings/${created.id}/void`, adminToken, { reason: 'Duplicate entry' });
      assert.equal(voided.status, 200, voided.text);

      const after = await offeringRow(created.id);
      assert.equal(after.verification_status, 'revoked');
      assert.ok(after.verification_revoked_at, 'the revocation is stamped');
      assert.equal(after.verification_revoked_by, (await suite.get("SELECT id FROM users WHERE email = ?", [ADMIN.email])).id);
      assert.equal(after.verification_token, before.verification_token, 'the token is kept, so the paper still resolves');

      const res = await verifyJson(after.verification_token);
      assert.equal(res.status, 200, 'a revoked receipt is still found: it is not a 404');
      assert.equal(res.json.verified, false);
      assert.equal(res.json.status, 'revoked');
      assert.equal(res.json.receipt.receiptNumber, before.receipt_number);
      assert.match(res.json.receipt.reason, /Duplicate entry/);

      const page = await suite.api('GET', `/verify/receipt/${after.verification_token}`, null);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('Receipt Revoked'));
      assert.ok(page.text.includes('was voided'));

      // The front desk can no longer reprint it as a live document.
      const reprint = await suite.api('GET', `/api/offerings/${created.id}/receipt`, adminToken);
      assert.equal(reprint.status, 410, reprint.text);
    });

    it('can be revoked and restored on its own, without touching the ledger', async () => {
      const created = await recordReceipted(42000);
      const token = (await offeringRow(created.id)).verification_token;

      const revoked = await suite.api('PATCH', `/api/offerings/${created.id}/verification/revoke`, adminToken, { reason: 'Issued in error' });
      assert.equal(revoked.status, 200, revoked.text);
      assert.equal(revoked.json.status, 'revoked');
      assert.equal(revoked.json.unchanged, false);

      const afterRevoke = await offeringRow(created.id);
      assert.equal(afterRevoke.verification_status, 'revoked');
      assert.equal(afterRevoke.voided_at, null, 'the gift itself is untouched');
      assert.equal(afterRevoke.amount, 42000);

      const publicView = await verifyJson(token);
      assert.equal(publicView.json.verified, false);
      assert.equal(publicView.json.status, 'revoked');
      assert.equal(publicView.json.receipt.reason, 'Issued in error');

      // Revoking twice is a no-op that reports the state, never an error.
      const again = await suite.api('PATCH', `/api/offerings/${created.id}/verification/revoke`, adminToken, {});
      assert.equal(again.status, 200, again.text);
      assert.equal(again.json.unchanged, true);
      assert.equal(again.json.reason, 'Issued in error', 'the original reason is not overwritten');

      const restored = await suite.api('PATCH', `/api/offerings/${created.id}/verification/restore`, adminToken, {});
      assert.equal(restored.status, 200, restored.text);
      assert.equal(restored.json.status, 'active');
      assert.equal(restored.json.unchanged, false);
      const afterRestore = await offeringRow(created.id);
      assert.equal(afterRestore.verification_status, 'active');
      assert.equal(afterRestore.verification_revoked_at, null);
      assert.equal((await verifyJson(token)).json.verified, true);

      // Restoring what was never revoked is another no-op.
      const noop = await suite.api('PATCH', `/api/offerings/${created.id}/verification/restore`, adminToken, {});
      assert.equal(noop.status, 200);
      assert.equal(noop.json.unchanged, true);
    });

    it('refuses to restore a receipt whose offering was voided', async () => {
      const created = await recordReceipted(9000);
      await suite.api('PATCH', `/api/offerings/${created.id}/void`, adminToken, { reason: 'Wrong category' });
      const res = await suite.api('PATCH', `/api/offerings/${created.id}/verification/restore`, adminToken, {});
      assert.equal(res.status, 409, res.text);
      assert.match(res.json.error, /voided/i);
    });

    it('refuses to manage verification on an offering that has no receipt', async () => {
      const res = await suite.api('POST', '/api/offerings', deskToken, {
        serviceTypeId: 1, category: 'general', amount: 800, currency: 'TZS',
      });
      assert.equal(res.status, 201, res.text);
      for (const [method, path] of [['PATCH', 'revoke'], ['PATCH', 'restore'], ['POST', 'regenerate']]) {
        const call = await suite.api(method, `/api/offerings/${res.json.id}/verification/${path}`, adminToken, {});
        assert.equal(call.status, 404, `${path} -> ${call.status} ${call.text}`);
      }
    });

    it('keeps verification management away from the front desk', async () => {
      const created = await recordReceipted(2500);
      const revoke = await suite.api('PATCH', `/api/offerings/${created.id}/verification/revoke`, deskToken, { reason: 'nope' });
      assert.equal(revoke.status, 403, revoke.text);
      const audit = await suite.api('GET', `/api/offerings/${created.id}/audit`, deskToken);
      assert.equal(audit.status, 403, audit.text);
      assert.equal((await offeringRow(created.id)).verification_status, 'active');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Reprinting and corrections keep one identity
  // ---------------------------------------------------------------------------
  describe('regenerated copies use the same receipt identity', () => {
    it('re-issues the existing token instead of minting a second one', async () => {
      const created = await recordReceipted(1500);
      const row = await offeringRow(created.id);

      const regen = await suite.api('POST', `/api/offerings/${created.id}/verification/regenerate`, adminToken, {});
      assert.equal(regen.status, 200, regen.text);
      assert.equal(regen.json.issued, false, 'nothing was minted: the receipt keeps its identity');
      assert.equal(regen.json.verificationToken, row.verification_token);
      assert.equal(regen.json.verificationUrl, verificationUrl(row.verification_token));
      assert.equal((await offeringRow(created.id)).verification_token, row.verification_token);
    });

    it('mints one only for a receipt that never had a code', async () => {
      // Simulates a receipt that predates QR verification (the boot backfill in
      // db/migrate.js normally prevents this).
      const created = await recordReceipted(1600);
      await suite.run('UPDATE offerings SET verification_token = NULL WHERE id = ?', [created.id]);

      const regen = await suite.api('POST', `/api/offerings/${created.id}/verification/regenerate`, adminToken, {});
      assert.equal(regen.status, 200, regen.text);
      assert.equal(regen.json.issued, true);
      assert.match(regen.json.verificationToken, /^[A-Za-z0-9_-]{32,}$/);
      assert.equal((await verifyJson(regen.json.verificationToken)).json.receipt.receiptNumber, (await offeringRow(created.id)).receipt_number);

      // Issuing a missing credential is an audited act.
      const entries = await suite.all(
        "SELECT * FROM audit_log WHERE action = 'receipt_verification_issued' AND record_id = ?",
        [created.id]
      );
      assert.equal(entries.length, 1);
    });

    it('carries the same receipt number AND the same token onto a correction', async () => {
      const created = await recordReceipted(20000);
      const original = await offeringRow(created.id);

      await suite.api('PATCH', `/api/offerings/${created.id}/void`, adminToken, { reason: 'Amount mistyped' });
      const adjusted = await suite.api('POST', `/api/offerings/${created.id}/adjust`, adminToken, { amount: 25000, reuseReceipt: true });
      assert.equal(adjusted.status, 201, adjusted.text);
      assert.equal(adjusted.json.receiptNumber, original.receipt_number);

      const correction = await offeringRow(adjusted.json.id);
      assert.equal(correction.verification_token, original.verification_token, 'the correction inherits the receipt identity');
      assert.equal((await offeringRow(created.id)).verification_token, null, 'and the voided original releases it');

      // The paper in the member's hands still verifies: now showing the amount
      // the church actually corrected it to.
      const res = await verifyJson(original.verification_token);
      assert.equal(res.status, 200);
      assert.equal(res.json.verified, true);
      assert.equal(res.json.receipt.receiptNumber, original.receipt_number);
      assert.equal(res.json.receipt.amount, 25000);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Admin functions
  // ---------------------------------------------------------------------------
  describe('admin receipt tools', () => {
    it('shows the receipt history for this transaction, who did what and when', async () => {
      const created = await recordReceipted(33000);
      await suite.api('PATCH', `/api/offerings/${created.id}/verification/revoke`, adminToken, { reason: 'Reissued' });

      const res = await suite.api('GET', `/api/offerings/${created.id}/audit`, adminToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.receiptNumber, (await offeringRow(created.id)).receipt_number);
      const actions = res.json.entries.map((e) => e.action);
      assert.ok(actions.includes('offering_recorded'), 'how the gift was recorded');
      assert.ok(actions.includes('receipt_verification_revoked'), 'and the invalidation');
      const revokeEntry = res.json.entries.find((e) => e.action === 'receipt_verification_revoked');
      assert.equal(revokeEntry.details.reason, 'Reissued');
      assert.equal(revokeEntry.recordedBy, 'Super Admin');
      assert.ok(revokeEntry.timestamp);
    });

    it('lists voided receipts for an admin, and keeps them out of the front desk\'s', async () => {
      const created = await recordReceipted(1100);
      await suite.api('PATCH', `/api/offerings/${created.id}/void`, adminToken, { reason: 'Test void' });

      const adminDefault = await suite.api('GET', '/api/offerings', adminToken);
      assert.ok(!adminDefault.json.offerings.some((o) => o.id === created.id), 'hidden by default');

      const adminAll = await suite.api('GET', '/api/offerings?includeVoided=1', adminToken);
      const found = adminAll.json.offerings.find((o) => o.id === created.id);
      assert.ok(found, 'an admin can find the receipt of a voided gift');
      assert.equal(found.verification_status, 'revoked');
      assert.equal(found.verification_url, verificationUrl(found.verification_token));

      // A receptionist cannot opt into voided rows, whatever they send.
      const desk = await suite.api('GET', '/api/offerings?includeVoided=1', deskToken);
      assert.ok(!desk.json.offerings.some((o) => o.id === created.id));
    });
  });

  // ---------------------------------------------------------------------------
  // 7. The daily audit chain: a separate mechanism
  // ---------------------------------------------------------------------------
  describe('daily audit-chain verification stays separate and admin-only', () => {
    it('verifies one day, reports the day\'s money, and is not reachable from a receipt', async () => {
      const today = (await suite.api('GET', '/api/time', null)).json.date;
      const res = await suite.api('GET', `/api/reports/audit/verify?date=${today}`, adminToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.date, today);
      assert.equal(res.json.valid, true);
      assert.equal(res.json.chainValid, true);
      assert.equal(res.json.linkedToNext, true);
      assert.equal(res.json.brokenAtId, null);
      assert.ok(res.json.entries > 0, 'a day of recording has entries');
      assert.ok(res.json.byAction.offering_recorded > 0, 'including the gifts recorded today');
      assert.equal(res.json.firstEntryId < res.json.lastEntryId, true, 'entries are walked in id order');
      const tzs = res.json.offerings.byCurrency.find((b) => b.currency === 'TZS');
      assert.ok(tzs && tzs.total > 0, 'the day\'s live offering total is reported beside the verdict');
      assert.ok(typeof res.json.offerings.voided === 'number', 'and the voided count is kept apart from it');

    });

    it('defaults to today, refuses a malformed date, and keeps the front desk out', async () => {
      const res = await suite.api('GET', '/api/reports/audit/verify', adminToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.entries > 0, true);

      const bad = await suite.api('GET', '/api/reports/audit/verify?date=yesterday', adminToken);
      assert.equal(bad.status, 400, bad.text);
      assert.match(bad.json.error, /YYYY-MM-DD/);

      const denied = await suite.api('GET', `/api/reports/audit/verify?date=${res.json.date}`, deskToken);
      assert.equal(denied.status, 403, denied.text);
    });

    it('honestly reports a day with no entries, and where a day starts unanchored', async () => {
      const res = await suite.api('GET', '/api/reports/audit/verify?date=2001-01-01', adminToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.entries, 0);
      assert.equal(res.json.valid, true, 'nothing recorded that day means nothing to have tampered with');
      assert.equal(res.json.firstEntryId, null);
      assert.equal(res.json.anchored, false);
      assert.deepEqual(res.json.offerings.byCurrency, []);
    });

    // LAST: this one breaks the chain on purpose, in this suite's throwaway
    // database only.
    it('detects a tampered entry in the day it was written', async () => {
      const today = (await suite.api('GET', '/api/time', null)).json.date;
      const target = await suite.get(
        "SELECT id FROM audit_log WHERE action = 'offering_recorded' ORDER BY id ASC LIMIT 1"
      );
      const before = await suite.get('SELECT * FROM audit_log WHERE id = ?', [target.id]);
      await suite.run('UPDATE audit_log SET details = ? WHERE id = ?', ['{"amount":1,"tampered":true}', target.id]);

      const res = await suite.api('GET', `/api/reports/audit/verify?date=${today}`, adminToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.valid, false, 'a rewritten entry must break the day it belongs to');
      assert.equal(res.json.chainValid, false);
      assert.equal(res.json.brokenAtId, target.id);

      // The whole-chain check agrees: the two verdicts are consistent, they are
      // just asked separately.
      const all = await suite.api('GET', '/api/reports/audit-integrity', adminToken);
      assert.equal(all.json.valid, false);
      assert.equal(all.json.brokenAtId, target.id);

      await suite.run('UPDATE audit_log SET details = ? WHERE id = ?', [before.details, target.id]);
    });
  });
});
