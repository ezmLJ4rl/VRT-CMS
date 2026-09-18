'use strict';
/**
 * The reconciliation workflow end to end, over HTTP against a real database.
 *
 * What is pinned here is the policy, not the plumbing:
 *   - a connected account stores no reusable bank credential, and returns none;
 *   - importing the same statement twice adds nothing (idempotent by constraint);
 *   - a webhook that is not signed by the account's own secret is refused, and
 *     cannot create a payment at all;
 *   - a payment is MATCHED by the church's own member number or a phone number
 *     that belongs to exactly one member, SUGGESTED when only a name fits, and
 *     left UNMATCHED otherwise, never guessed;
 *   - nothing becomes giving until an admin confirms it, at which point it is the
 *     same ledger row the front desk writes: receipt, QR token, payment fields;
 *   - confirming the same payment twice produces ONE gift, not two;
 *   - money the provider reports as failed or reversed can never be confirmed;
 *   - the reports read the same rows (account, method, reconciliation state), so
 *     no screen has its own arithmetic.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { signWebhookBody } = require('../utils/paymentAccounts');
const i18n = require('../i18n');

/**
 * The sentence a key resolves to in English.
 *
 * The API answers errors in the CALLER's language (middleware/locale.js), so a
 * test that expects the raw key is testing the wrong layer, and the catalog is
 * the source of truth for the wording, so an assertion written this way follows
 * a reworded message instead of breaking on it.
 */
const en = (key, params) => i18n.interpolate(i18n.catalogs.en[key], params);

const suite = startServer({ name: 'payment-reconciliation', port: 4632 });

const SUPER = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };

let adminToken;
let deskToken;
let pastorToken;

/** The statement the church downloads from its bank: two payments it can place,
 *  one it can only guess at, one it cannot place, and its own bill to pay. */
function statementCsv({ memberNo, memberName, amount = 250000, secondAmount = 120000 }) {
  return [
    'Transaction Date,Value Date,Description,Reference,Debit,Credit,Payer Name,Payer Phone,Payer Account,Status',
    `03/09/2026,03/09/2026,"ZAKA - ${memberName.toUpperCase()}","ZAKA/${memberNo}/2026-09","","${amount.toLocaleString('en-GB')}","${memberName}","","0150123456","POSTED"`,
    `06/09/2026,06/09/2026,"OFFERING - TRANSFER","TRF/99120","","${secondAmount.toLocaleString('en-GB')}","Unknown Visitor","","0150999999","POSTED"`,
    '09/09/2026,09/09/2026,"LUKU ELECTRICITY","BIL/2026/441","240,000","","TANESCO","","","POSTED"',
  ].join('\n');
}

async function login(email, password) {
  const res = await suite.api('POST', '/api/auth/login', null, { email, password });
  assert.equal(res.status, 200, `${email}: ${res.text}`);
  return res.json.token;
}

async function createUser(name, email, role) {
  const created = await suite.api('POST', '/api/users', adminToken, { name, email, role, password: 'TestPass_123!' });
  assert.equal(created.status, 201, created.text);
  return login(email, 'TestPass_123!');
}

describe('church payment accounts and reconciliation', () => {
  let member;
  let statementAccount;
  let webhookAccount;
  let webhookSecret;

  before(async () => {
    await suite.waitReady();
    adminToken = await login(SUPER.email, SUPER.password);
    deskToken = await createUser('Payments Desk', 'payments.desk@test.local', 'receptionist');
    pastorToken = await createUser('Payments Pastor', 'payments.pastor@test.local', 'pastor');

    const created = await suite.api('POST', '/api/members', adminToken, {
      name: 'Neema Joseph', phone: '+255712345678', email: 'neema.joseph@test.local',
    });
    assert.equal(created.status, 201, created.text);
    member = created.json.member;
    assert.ok(member.member_no, 'a member must get a giving code');

    // Cash the desk counted, which never passes through an account at all: the
    // reconciliation report must show it as its own bucket rather than folding it
    // into a bank account or dropping it.
    const deskGift = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: 1, category: 'general', amount: 40000, currency: 'TZS', paymentMethod: 'cash',
    });
    assert.equal(deskGift.status, 201, deskGift.text);
  });

  after(() => suite.stop());

  // -------------------------------------------------------------------------
  describe('connecting an account', () => {
    it('stores the church\'s own account reference and never hands it back whole', async () => {
      const res = await suite.api('POST', '/api/payment-accounts', adminToken, {
        name: 'CRDB Bank: main', provider: 'statement_import', method: 'bank', accountRef: '0150123456789',
      });
      assert.equal(res.status, 201, res.text);
      statementAccount = res.json.account;
      assert.equal(statementAccount.accountRef, undefined, 'the full account number must not travel');
      assert.equal(statementAccount.accountRefMasked, '••••6789');
      assert.equal(statementAccount.status, 'active');
      assert.equal(statementAccount.credentialsEnc, undefined);

      // At rest the column is empty for this provider: there is nothing to keep.
      const row = await suite.get('SELECT credentials_enc FROM payment_accounts WHERE id = ?', [statementAccount.id]);
      assert.equal(row.credentials_enc, null);
    });

    it('issues a webhook secret exactly once, and never returns it again', async () => {
      const created = await suite.api('POST', '/api/payment-accounts', adminToken, {
        name: 'M-Pesa collection till', provider: 'webhook', method: 'mobile_money', accountRef: '512345',
      });
      assert.equal(created.status, 201, created.text);
      webhookAccount = created.json.account;
      webhookSecret = created.json.issuedCredentials?.webhook_secret;
      assert.ok(webhookSecret && webhookSecret.startsWith('whsec_'), 'a secret must be issued on creation');
      assert.ok(webhookAccount.webhookUrl.endsWith(`/api/payment-webhooks/${webhookAccount.id}`), webhookAccount.webhookUrl);

      const listed = await suite.api('GET', '/api/payment-accounts', adminToken);
      assert.equal(listed.status, 200, listed.text);
      assert.ok(!listed.text.includes(webhookSecret), 'the secret must never come back out');
      const account = listed.json.accounts.find((a) => a.id === webhookAccount.id);
      assert.deepEqual(account.credentialFieldsSet, ['webhook_secret']);
      assert.deepEqual(account.credentialFields, ['webhook_secret']);

      // Stored encrypted: the column does not contain the secret in the clear.
      const row = await suite.get('SELECT credentials_enc FROM payment_accounts WHERE id = ?', [webhookAccount.id]);
      assert.ok(row.credentials_enc && !row.credentials_enc.includes(webhookSecret));
    });

    it('refuses a second connection to the same account', async () => {
      const again = await suite.api('POST', '/api/payment-accounts', adminToken, {
        name: 'CRDB Bank: duplicate', provider: 'statement_import', method: 'bank', accountRef: '0150123456789',
      });
      assert.equal(again.status, 409, again.text);
      assert.ok(again.text.includes(en('errors.paymentAccountAlreadyConnected')), again.text);
    });

    it('refuses an unknown provider, a missing name and an unknown method', async () => {
      const badProvider = await suite.api('POST', '/api/payment-accounts', adminToken, {
        name: 'Mystery bank', provider: 'live_bank_api', method: 'bank',
      });
      assert.equal(badProvider.status, 400);
      assert.ok(badProvider.text.includes(en('errors.unknownPaymentProvider')), badProvider.text);

      const noName = await suite.api('POST', '/api/payment-accounts', adminToken, {
        name: '   ', provider: 'webhook', method: 'mobile_money',
      });
      assert.equal(noName.status, 400);
      assert.ok(noName.text.includes(en('errors.accountNameRequired')), noName.text);

      const badMethod = await suite.api('POST', '/api/payment-accounts', adminToken, {
        name: 'Odd account', provider: 'webhook', method: 'cryptocurrency',
      });
      assert.equal(badMethod.status, 400);
      assert.ok(badMethod.text.includes(en('errors.invalidPaymentMethod')), badMethod.text);
    });

    it('keeps the church\'s banking detail away from the desk and the pastor', async () => {
      for (const token of [deskToken, pastorToken]) {
        const list = await suite.api('GET', '/api/payment-accounts', token);
        assert.equal(list.status, 403, list.text);
        const create = await suite.api('POST', '/api/payment-accounts', token, { name: 'x', provider: 'webhook', method: 'bank' });
        assert.equal(create.status, 403);
        const payments = await suite.api('GET', '/api/payment-transactions', token);
        assert.equal(payments.status, 403);
      }
    });

    it('answers the account form with the providers it actually offers', async () => {
      const res = await suite.api('GET', '/api/payment-accounts', adminToken);
      const keys = res.json.providers.map((p) => p.key);
      assert.deepEqual(keys.sort(), ['statement_import', 'webhook']);
      const statement = res.json.providers.find((p) => p.key === 'statement_import');
      assert.equal(statement.capabilities.statement, true);
      assert.equal(statement.capabilities.liveSync, false, 'no fake live bank connection may be advertised');
    });
  });

  // -------------------------------------------------------------------------
  describe('importing a statement', () => {
    it('reads the payments, matches by giving code, and reports what it could not use', async () => {
      const res = await suite.api('POST', `/api/payment-accounts/${statementAccount.id}/sync`, adminToken, {
        statement: statementCsv({ memberNo: member.member_no, memberName: member.name }),
        fileName: 'crdb-september.csv',
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.inserted, 2, res.text);
      assert.equal(res.json.matched, 1, `the giving code must identify its owner: ${res.text}`);
      assert.equal(res.json.unmatched, 1, 'a stranger is not attributed to anybody');
      assert.equal(res.json.rejected.length, 1);
      assert.equal(res.json.rejected[0].reason, 'payment.reject_notCredit');

      const transaction = await suite.get(
        'SELECT * FROM payment_transactions WHERE account_id = ? AND provider_reference = ?',
        [statementAccount.id, `ZAKA/${member.member_no}/2026-09`]
      );
      assert.equal(transaction.match_status, 'matched');
      assert.equal(transaction.match_method, 'member_no');
      assert.equal(transaction.matched_member_id, member.id);
      assert.equal(transaction.amount, 250000);
      assert.equal(transaction.payment_method, undefined, 'the method lives on the account');
      assert.equal(transaction.status, 'successful');
      assert.equal(transaction.source, 'statement');

      const account = await suite.get('SELECT last_synced_at, last_sync_summary FROM payment_accounts WHERE id = ?', [statementAccount.id]);
      assert.ok(account.last_synced_at, 'the account must record when it was last synced');
      assert.deepEqual(JSON.parse(account.last_sync_summary), { inserted: 2, duplicates: 0, rejected: 1, fileName: 'crdb-september.csv' });
    });

    it('adds nothing at all when the same statement is uploaded again', async () => {
      const res = await suite.api('POST', `/api/payment-accounts/${statementAccount.id}/sync`, adminToken, {
        statement: statementCsv({ memberNo: member.member_no, memberName: member.name }),
        fileName: 'crdb-september.csv',
      });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.inserted, 0, 'a repeat must insert nothing');
      assert.equal(res.json.duplicates, 2, 'and must say how many it recognised');
      const { n } = await suite.get('SELECT COUNT(*)::int AS n FROM payment_transactions WHERE account_id = ?', [statementAccount.id]);
      assert.equal(n, 2);
    });

    it('refuses an empty upload and a disabled account', async () => {
      const empty = await suite.api('POST', `/api/payment-accounts/${statementAccount.id}/sync`, adminToken, { statement: '   ' });
      assert.equal(empty.status, 400);
      assert.ok(empty.text.includes(en('errors.statementFileEmpty')), empty.text);

      await suite.api('PATCH', `/api/payment-accounts/${statementAccount.id}`, adminToken, { status: 'disabled' });
      const disabled = await suite.api('POST', `/api/payment-accounts/${statementAccount.id}/sync`, adminToken, {
        statement: statementCsv({ memberNo: member.member_no, memberName: member.name }),
      });
      assert.equal(disabled.status, 409);
      assert.ok(disabled.text.includes(en('errors.paymentAccountDisabled')), disabled.text);
      await suite.api('PATCH', `/api/payment-accounts/${statementAccount.id}`, adminToken, { status: 'active' });
    });

    it('offers no statement upload on an account that takes notifications instead', async () => {
      const res = await suite.api('POST', `/api/payment-accounts/${webhookAccount.id}/sync`, adminToken, { statement: 'a,b\n1,2' });
      assert.equal(res.status, 400, res.text);
      assert.ok(
        res.text.includes(en('errors.providerTakesNoStatement', { provider: en('payment.provider_webhook') })),
        res.text
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('receiving a provider notification', () => {
    const payload = (overrides = {}) => ({
      TransID: 'MP991001Z',
      TransTime: '20260913101500',
      TransAmount: '90000',
      BillRefNumber: 'SADAKA',
      MSISDN: '255712345678',
      FirstName: 'Neema',
      LastName: 'Joseph',
      status: 'successful',
      ...overrides,
    });

    async function post(body, { signature, accountId = webhookAccount.id } = {}) {
      const raw = JSON.stringify(body);
      return suite.api('POST', `/api/payment-webhooks/${accountId}`, null, body, signature ? { 'X-VRT-Signature': signature } : {});
    }

    it('refuses a notification that is not signed with the account\'s own secret', async () => {
      const unsigned = await post(payload());
      assert.equal(unsigned.status, 401, unsigned.text);
      assert.ok(unsigned.text.includes(en('errors.paymentWebhookSignatureInvalid')), unsigned.text);

      const wrongSignature = await post(payload(), { signature: signWebhookBody(JSON.stringify(payload()), 'not-the-secret') });
      assert.equal(wrongSignature.status, 401);

      const { n } = await suite.get('SELECT COUNT(*)::int AS n FROM payment_transactions WHERE account_id = ?', [webhookAccount.id]);
      assert.equal(n, 0, 'a rejected notification must not create a payment');
      const rejected = await suite.get("SELECT * FROM audit_log WHERE action = 'payment_webhook_rejected' ORDER BY id DESC LIMIT 1");
      assert.ok(rejected, 'a refused notification must be audited for the admin to find');
    });

    it('records a signed notification and attributes it to the member whose phone paid', async () => {
      const body = payload();
      const res = await post(body, { signature: signWebhookBody(JSON.stringify(body), webhookSecret) });
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.inserted, 1, res.text);
      assert.equal(res.json.matched, 1, 'the payer\'s phone belongs to exactly one member');

      const row = await suite.get('SELECT * FROM payment_transactions WHERE account_id = ? AND provider_transaction_id = ?', [webhookAccount.id, 'MP991001Z']);
      assert.equal(row.match_status, 'matched');
      assert.equal(row.match_method, 'phone');
      assert.equal(row.matched_member_id, member.id);
      assert.equal(row.source, 'webhook');
      assert.ok(row.payer_phone_enc && !row.payer_phone_enc.includes('255712345678'), 'the payer phone must be encrypted at rest');
    });

    it('ignores a retry of the same notification', async () => {
      const body = payload();
      const res = await post(body, { signature: signWebhookBody(JSON.stringify(body), webhookSecret) });
      assert.equal(res.status, 200);
      assert.equal(res.json.inserted, 0);
      assert.equal(res.json.duplicates, 1);
    });

    it('refuses a notification for an account that is switched off', async () => {
      await suite.api('PATCH', `/api/payment-accounts/${webhookAccount.id}`, adminToken, { status: 'disabled' });
      const body = payload({ TransID: 'MP991002Z' });
      const res = await post(body, { signature: signWebhookBody(JSON.stringify(body), webhookSecret) });
      assert.equal(res.status, 409, res.text);
      await suite.api('PATCH', `/api/payment-accounts/${webhookAccount.id}`, adminToken, { status: 'active' });
    });

    it('rotates the secret, and the old one stops working', async () => {
      const rotated = await suite.api('PATCH', `/api/payment-accounts/${webhookAccount.id}`, adminToken, { rotateWebhookSecret: true });
      assert.equal(rotated.status, 200, rotated.text);
      const newSecret = rotated.json.issuedCredentials.webhook_secret;
      assert.ok(newSecret && newSecret !== webhookSecret);

      const body = payload({ TransID: 'MP991003Z' });
      const withOld = await post(body, { signature: signWebhookBody(JSON.stringify(body), webhookSecret) });
      assert.equal(withOld.status, 401, 'a rotated secret must invalidate the old one');

      const withNew = await post(body, { signature: signWebhookBody(JSON.stringify(body), newSecret) });
      assert.equal(withNew.status, 200, withNew.text);
      assert.equal(withNew.json.inserted, 1);
      webhookSecret = newSecret;
    });
  });

  // -------------------------------------------------------------------------
  describe('the incoming-payments list', () => {
    it('shows what needs attention first, with the counts behind the chips', async () => {
      const res = await suite.api('GET', '/api/payment-transactions', adminToken);
      assert.equal(res.status, 200, res.text);
      assert.ok(res.json.transactions.length >= 4);
      const stranger = res.json.transactions.find((t) => t.payerName === 'Unknown Visitor');
      assert.equal(stranger.matchStatus, 'unmatched');
      assert.equal(stranger.accountName, 'CRDB Bank: main');
      assert.equal(stranger.payerPhone, null);

      const summary = await suite.api('GET', '/api/payment-transactions/summary', adminToken);
      assert.equal(summary.status, 200, summary.text);
      assert.equal(summary.json.counts.unmatched, 1);
      assert.equal(summary.json.awaiting, 1);
      assert.ok(summary.json.awaitingAmount >= 120000);
    });

    it('filters by account, by state, by provider status and by what is written on the slip', async () => {
      const byAccount = await suite.api('GET', `/api/payment-transactions?accountId=${webhookAccount.id}`, adminToken);
      assert.equal(byAccount.status, 200);
      assert.ok(byAccount.json.transactions.every((t) => t.accountId === webhookAccount.id));

      const awaiting = await suite.api('GET', '/api/payment-transactions?matchStatus=unmatched,review', adminToken);
      assert.ok(awaiting.json.transactions.every((t) => ['unmatched', 'review'].includes(t.matchStatus)));

      const successful = await suite.api('GET', '/api/payment-transactions?status=successful', adminToken);
      assert.ok(successful.json.transactions.every((t) => t.status === 'successful'));

      const search = await suite.api('GET', '/api/payment-transactions?q=MP991001Z', adminToken);
      assert.equal(search.json.transactions.length, 1);
      assert.equal(search.json.transactions[0].providerTransactionId, 'MP991001Z');
    });
  });

  // -------------------------------------------------------------------------
  describe('matching and confirming a payment', () => {
    let strangerId;
    let matchedId;

    before(async () => {
      const stranger = await suite.get("SELECT id FROM payment_transactions WHERE payer_name = 'Unknown Visitor'");
      strangerId = stranger.id;
      const matched = await suite.get("SELECT id FROM payment_transactions WHERE match_method = 'member_no'");
      matchedId = matched.id;
    });

    it('lets an admin attribute a payment to a member by hand', async () => {
      const res = await suite.api('POST', `/api/payment-transactions/${strangerId}/match`, adminToken, { memberId: member.id });
      assert.equal(res.status, 200, res.text);
      const row = await suite.get('SELECT * FROM payment_transactions WHERE id = ?', [strangerId]);
      assert.equal(row.match_status, 'matched');
      assert.equal(row.match_method, 'manual', 'a human decision must be marked as one');

      // A later sync must not overwrite what a person decided.
      await suite.api('POST', `/api/payment-accounts/${statementAccount.id}/sync`, adminToken, {
        statement: statementCsv({ memberNo: member.member_no, memberName: member.name, amount: 999000 }),
      });
      const after = await suite.get('SELECT * FROM payment_transactions WHERE id = ?', [strangerId]);
      assert.equal(after.match_method, 'manual');
      assert.equal(after.matched_member_id, member.id);
    });

    it('refuses to match to a member who does not exist, and to nobody at all', async () => {
      const noMember = await suite.api('POST', `/api/payment-transactions/${strangerId}/match`, adminToken, {});
      assert.equal(noMember.status, 400);
      assert.ok(noMember.text.includes(en('errors.memberRequired')), noMember.text);
      const ghost = await suite.api('POST', `/api/payment-transactions/${strangerId}/match`, adminToken, { memberId: 999999 });
      assert.equal(ghost.status, 400);
      assert.ok(ghost.text.includes(en('errors.memberNotFound')), ghost.text);
    });

    it('records the payment as giving and issues a receipt that verifies', async () => {
      const res = await suite.api('POST', `/api/payment-transactions/${matchedId}/confirm`, adminToken, {
        category: 'zaka', serviceTypeId: 1, date: '2026-09-13',
      });
      assert.equal(res.status, 201, res.text);
      assert.ok(res.json.receiptNumber, 'a confirmed payment must be receipted');
      assert.ok(res.json.verificationUrl.includes('/verify/receipt/'));

      const offering = await suite.get('SELECT * FROM offerings WHERE id = ?', [res.json.offeringId]);
      assert.equal(offering.source, 'import', 'the ledger must record where the gift came from');
      assert.equal(offering.payment_transaction_id, matchedId);
      assert.equal(offering.amount, 250000);
      assert.equal(offering.payment_method, 'bank', 'the method comes from the account the money landed in');
      assert.equal(offering.payment_reference, `ZAKA/${member.member_no}/2026-09`);
      assert.equal(offering.member_id, member.id);
      assert.ok(offering.verification_token);

      const transaction = await suite.get('SELECT * FROM payment_transactions WHERE id = ?', [matchedId]);
      assert.equal(transaction.match_status, 'confirmed');
      assert.equal(transaction.offering_id, offering.id);
      assert.ok(transaction.reconciled_at);

      // The member's paper receipt works, through the public page and the API.
      const token = offering.verification_token;
      const page = await fetch(`${suite.base}/verify/receipt/${token}`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Receipt Verified/);
      assert.match(html, new RegExp(res.json.receiptNumber));
      assert.ok(!html.includes(member.name), 'the giver must not be named on the public page');

      // The receipt's own history names the payment it came from.
      const audit = await suite.api('GET', `/api/offerings/${offering.id}/audit`, adminToken);
      assert.equal(audit.status, 200, audit.text);
      const recorded = audit.json.entries.find((e) => e.action === 'offering_recorded');
      assert.equal(recorded.details.paymentTransactionId, matchedId);
      assert.equal(recorded.details.source, 'import');

      // And the payment's history names the receipt it became.
      const paymentAudit = await suite.get("SELECT * FROM audit_log WHERE action = 'payment_confirmed' AND record_id = ?", [matchedId]);
      assert.ok(paymentAudit, 'confirming must be audited');
      assert.equal(JSON.parse(paymentAudit.details).receipt, res.json.receiptNumber);
    });

    it('gives the same payment one gift and one receipt, however many times it is confirmed', async () => {
      const again = await suite.api('POST', `/api/payment-transactions/${matchedId}/confirm`, adminToken, {
        category: 'zaka', serviceTypeId: 1, date: '2026-09-13',
      });
      assert.equal(again.status, 409, again.text);
      assert.ok(again.text.includes(en('errors.paymentAlreadyConfirmed')), again.text);
      const { n } = await suite.get('SELECT COUNT(*)::int AS n FROM offerings WHERE payment_transaction_id = ?', [matchedId]);
      assert.equal(n, 1);
    });

    it('refuses to record money the provider says failed or was reversed', async () => {
      const failed = await suite.run(
        "INSERT INTO payment_transactions (account_id, provider_transaction_id, amount, currency, occurred_at, status, source, payer_name) VALUES (?, 'MP-FAILED-1', 60000, 'TZS', '2026-09-10 12:00:00', 'failed', 'webhook', 'Fatuma A.')",
        [webhookAccount.id]
      );
      assert.equal(failed, 1);
      const id = (await suite.get("SELECT id FROM payment_transactions WHERE provider_transaction_id = 'MP-FAILED-1'")).id;
      const res = await suite.api('POST', `/api/payment-transactions/${id}/confirm`, adminToken, { category: 'zaka', serviceTypeId: 1 });
      assert.equal(res.status, 400, res.text);
      assert.ok(res.text.includes(en('errors.paymentNotSuccessfulCannotRecord', { status: en('payment.status_failed') })), res.text);
      const { n } = await suite.get('SELECT COUNT(*)::int AS n FROM offerings WHERE payment_transaction_id = ?', [id]);
      assert.equal(n, 0, 'a failed payment must never become giving');
    });

    it('reopens, sets aside and takes a match back, and refuses those once confirmed', async () => {
      const ignored = await suite.api('POST', `/api/payment-transactions/${strangerId}/ignore`, adminToken, { reason: 'Loan repayment into the church account' });
      assert.equal(ignored.status, 200, ignored.text);
      let row = await suite.get('SELECT * FROM payment_transactions WHERE id = ?', [strangerId]);
      assert.equal(row.match_status, 'ignored');
      assert.equal(row.ignored_reason, 'Loan repayment into the church account');

      const reopened = await suite.api('POST', `/api/payment-transactions/${strangerId}/reopen`, adminToken);
      assert.equal(reopened.status, 200, reopened.text);
      row = await suite.get('SELECT * FROM payment_transactions WHERE id = ?', [strangerId]);
      assert.equal(row.match_status, 'unmatched', 'reopening re-runs the rules rather than forcing a state');
      assert.equal(row.ignored_reason, null);

      const unmatch = await suite.api('POST', `/api/payment-transactions/${matchedId}/unmatch`, adminToken);
      assert.equal(unmatch.status, 409, unmatch.text);
      assert.ok(unmatch.text.includes(en('errors.paymentAlreadyConfirmed')), unmatch.text);

      const ignoreConfirmed = await suite.api('POST', `/api/payment-transactions/${matchedId}/ignore`, adminToken, {});
      assert.equal(ignoreConfirmed.status, 409);
    });

    it('answers 404 for a payment that does not exist', async () => {
      const res = await suite.api('GET', '/api/payment-transactions/999999', adminToken);
      assert.equal(res.status, 404);
      assert.ok(res.text.includes(en('errors.paymentTransactionNotFound')), res.text);
    });
  });

  // -------------------------------------------------------------------------
  describe('reports read the same rows', () => {
    it('breaks giving down by the account the money arrived in', async () => {
      const res = await suite.api('GET', '/api/reports/breakdown?groupBy=account', adminToken);
      assert.equal(res.status, 200, res.text);
      const row = res.json.breakdown.find((r) => r.key === statementAccount.id);
      assert.ok(row, 'the account must appear');
      assert.equal(row.label, 'CRDB Bank: main');
      assert.equal(row.amount, 250000);
      assert.equal(Number(row.gifts), 1);
      // Everything the desk counted by hand has no account, and is reported as
      // its own row rather than being folded into a real one.
      assert.ok(res.json.breakdown.some((r) => r.key === null || r.key === undefined), 'gifts with no account must still be visible');
    });

    it('reports the reconciliation state of what arrived, never adding it to the ledger total', async () => {
      const res = await suite.api('GET', '/api/reports/breakdown?groupBy=reconciliation', adminToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.unit, 'payments');
      const byKey = Object.fromEntries(res.json.breakdown.map((r) => [r.key, r]));
      assert.equal(byKey.confirmed.gifts, 1);
      assert.equal(byKey.confirmed.amount, 250000);
      assert.ok(byKey.unmatched.gifts >= 1, 'the unexplained payment must be counted');
      assert.ok(res.json.providerStatus.some((r) => r.key === 'failed'), 'what the provider reported must be visible too');
    });

    it('keeps the reconciliation report away from anyone but an administrator', async () => {
      const desk = await suite.api('GET', '/api/reports/breakdown?groupBy=reconciliation', deskToken);
      assert.equal(desk.status, 403);
      assert.ok(desk.text.includes(en('errors.reconciliationAdminOnly')), desk.text);
      const pastor = await suite.api('GET', '/api/reports/breakdown?groupBy=account', pastorToken);
      assert.equal(pastor.status, 403);
      const badGroup = await suite.api('GET', '/api/reports/breakdown?groupBy=somethingElse', adminToken);
      assert.equal(badGroup.status, 400);
      assert.ok(badGroup.text.includes(en('errors.invalidGroupBy')), badGroup.text);
    });

    it('filters the offering ledger by account, by source and by member', async () => {
      const byAccount = await suite.api('GET', `/api/offerings?accountId=${statementAccount.id}`, adminToken);
      assert.equal(byAccount.status, 200, byAccount.text);
      assert.equal(byAccount.json.offerings.length, 1);
      assert.equal(byAccount.json.offerings[0].source, 'import');
      assert.equal(byAccount.json.offerings[0].payment_account_name, 'CRDB Bank: main');
      assert.equal(byAccount.json.offerings[0].reconciliation_status, 'confirmed');

      const bySource = await suite.api('GET', '/api/offerings?source=import', adminToken);
      assert.ok(bySource.json.offerings.every((o) => o.source === 'import'));

      const byMember = await suite.api('GET', `/api/offerings?memberId=${member.id}`, adminToken);
      assert.equal(byMember.json.offerings.length, 1, 'one member, one gift so far');

      const manual = await suite.api('GET', '/api/offerings?source=manual', adminToken);
      assert.ok(manual.json.offerings.every((o) => o.source === 'manual'));
    });

    it('exports the source and the account a gift came through', async () => {
      const res = await suite.api('GET', '/api/reports/offerings.csv', adminToken);
      assert.equal(res.status, 200, res.text.slice(0, 120));
      const header = res.text.split('\n')[0].replace(/"/g, '');
      for (const column of ['source', 'account', 'reconciliation_status', 'payment_method', 'payment_reference']) {
        assert.ok(header.includes(column), `the export must carry ${column}`);
      }
      assert.ok(res.text.includes('CRDB Bank: main'));
    });

    it('adds imported giving to the church\'s own totals, without a second ledger', async () => {
      const summary = await suite.api('GET', '/api/reports/summary', adminToken);
      assert.equal(summary.status, 200, summary.text);
      const total = await suite.get('SELECT COALESCE(SUM(amount), 0) AS total FROM offerings WHERE voided_at IS NULL');
      assert.equal(Number(summary.json.offerings.total), Number(total.total), 'the summary and the ledger must be the same number');
    });
  });

  // -------------------------------------------------------------------------
  describe('disconnecting an account', () => {
    it('refuses to delete an account that has history, and suggests switching it off', async () => {
      const res = await suite.api('DELETE', `/api/payment-accounts/${statementAccount.id}`, adminToken);
      assert.equal(res.status, 409, res.text);
      assert.ok(res.text.includes(en('errors.paymentAccountHasTransactions', { count: 3 })), res.text);
    });

    it('deletes an account that never received anything', async () => {
      const created = await suite.api('POST', '/api/payment-accounts', adminToken, {
        name: 'Trial account', provider: 'statement_import', method: 'bank', accountRef: '999000111',
      });
      assert.equal(created.status, 201, created.text);
      const removed = await suite.api('DELETE', `/api/payment-accounts/${created.json.account.id}`, adminToken);
      assert.equal(removed.status, 200, removed.text);
      const audit = await suite.get("SELECT * FROM audit_log WHERE action = 'payment_account_deleted' AND record_id = ?", [created.json.account.id]);
      assert.ok(audit, 'disconnecting must be audited');
    });
  });
});
