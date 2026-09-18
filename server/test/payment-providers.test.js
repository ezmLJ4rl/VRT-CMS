'use strict';
/**
 * The reading half of payment intake, tested without a database.
 *
 * Everything here decides something about a real church's money: whether a
 * statement amount is 1,250,000 or 1250, how a dd/mm/yyyy date is read, whether a
 * payer is a member, and whether two provider notifications describe one payment
 * or two. Those decisions are pure functions, so they are pinned directly rather
 * than only through an HTTP round trip: a wrong answer here would be a wrong
 * figure in a report, not a failed request.
 */
// The credential tests below exercise the real encryption, so the suite needs the
// same FIELD_ENCRYPTION_KEY the app uses (server/.env). No database is touched by
// this file at all.
require('dotenv').config();

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAmount,
  parseStatementDate,
  parseStatus,
  parseStatement,
  parseWebhook,
  getProvider,
  listProviders,
  PROVIDER_KEYS,
  TRANSACTION_STATUSES,
} = require('../utils/paymentProviders');
const { deriveProviderTransactionId, normalizeTransaction, classifyMatch } = require('../utils/paymentIntake');
const { readStatement, detectDelimiter } = require('../utils/statementCsv');
const { signWebhookBody, verifyWebhookSignature, maskAccountRef, writeCredentials, readCredentialValues } = require('../utils/paymentAccounts');
const { findMemberNumber, samePhone, sameName } = require('../utils/identityMatch');

describe('statement amounts', () => {
  it('reads the shapes a real export contains', () => {
    assert.equal(parseAmount('1,250,000'), 1250000);
    assert.equal(parseAmount('1,250,000.00'), 1250000);
    assert.equal(parseAmount('TZS 50,000'), 50000);
    assert.equal(parseAmount('50000/='), 50000);
    assert.equal(parseAmount('350000'), 350000);
    assert.equal(parseAmount(' 12,345.67 '), 12345.67);
  });

  it('reads the two ways money OUT is written, and keeps the sign', () => {
    assert.equal(parseAmount('(20,000)'), -20000);
    assert.equal(parseAmount('-20,000'), -20000);
  });

  it('reads a comma as a decimal separator when that is what it must be', () => {
    // '50,00' cannot be a thousands separator (two digits follow it), so it is
    // read as a decimal, and '1.234.567,89' the way a European export writes it.
    assert.equal(parseAmount('50,00'), 50);
    assert.equal(parseAmount('1.234.567,89'), 1234567.89);
  });

  it('refuses text that is not a number instead of guessing zero', () => {
    // Zero would be a gift of nothing; null is "this row is not usable".
    for (const value of ['', '   ', '-', 'n/a', null, undefined, 'TZS']) {
      assert.equal(parseAmount(value), null, `${JSON.stringify(value)} must not become a number`);
    }
  });
});

describe('statement dates', () => {
  it('reads day-first, which is how dates are written here', () => {
    assert.equal(parseStatementDate('03/04/2026', ''), '2026-04-03 00:00:00');
    assert.equal(parseStatementDate('16/09/2026', '09:30'), '2026-09-16 09:30:00');
  });

  it('reads an ISO date and its time', () => {
    assert.equal(parseStatementDate('2026-09-16', ''), '2026-09-16 00:00:00');
    assert.equal(parseStatementDate('2026-09-16 14:05:59', ''), '2026-09-16 14:05:59');
  });

  it('reads a provider compact stamp: YYYYMMDDHHMMSS and YYYYMMDD', () => {
    // This is the format mobile-money gateways actually send; rejecting it would
    // have dropped every payment from the busiest account the church has.
    assert.equal(parseStatementDate('20260916093015', ''), '2026-09-16 09:30:15');
    assert.equal(parseStatementDate('20260916', ''), '2026-09-16 00:00:00');
    assert.equal(parseStatementDate('20260916', '17:45'), '2026-09-16 17:45:00');
  });

  it('refuses an impossible date rather than rolling it into the next month', () => {
    assert.equal(parseStatementDate('45/13/2026', ''), null);
    assert.equal(parseStatementDate('', ''), null);
  });
});

describe('provider statuses', () => {
  it('maps what providers write onto the four states the schema stores', () => {
    assert.equal(parseStatus('POSTED'), 'successful');
    assert.equal(parseStatus('Completed'), 'successful');
    assert.equal(parseStatus('REVERSED'), 'reversed');
    assert.equal(parseStatus('refunded'), 'reversed');
    assert.equal(parseStatus('insufficient funds'), 'failed');
    assert.equal(parseStatus('Processing'), 'pending');
  });

  it('treats an unknown status as pending, never as successful', () => {
    // 'successful' is the one answer that would let money nobody can vouch for be
    // confirmed into the ledger, so it is only ever reached deliberately.
    assert.equal(parseStatus('WEIRD-NEW-CODE'), 'pending');
    assert.ok(TRANSACTION_STATUSES.includes(parseStatus('anything at all')));
  });
});

describe('the statement reader', () => {
  it('honours quoting, embedded commas and the delimiter the header uses', () => {
    const csv = 'Date;Description;Amount\n16/09/2026;"ZAKA, SUNDAY";1,250,000\n';
    assert.equal(detectDelimiter(csv), ';');
    const { rows } = readStatement(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Description, 'ZAKA, SUNDAY');
    assert.equal(rows[0].Amount, '1,250,000');
  });

  it('reads a statement through column ALIASES rather than by position', () => {
    // A bank that renames or reorders its columns must not shift every amount
    // one column to the left: the failure this whole design exists to prevent.
    const csv = [
      'Value Date,Txn Details,Bank Reference,Credit Amount,Sender Name,Mobile Number,Status',
      '16/09/2026,"ZAKA - NEEMA JOSEPH",ZAKA/VRT-0003/2026-09,"350,000",Neema Joseph,255712345678,POSTED',
    ].join('\n');
    const { transactions, rejected } = parseStatement(csv, { account: { currency: 'TZS' } });
    assert.equal(rejected.length, 0);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].amount, 350000);
    assert.equal(transactions[0].occurred_at, '2026-09-16 00:00:00');
    assert.equal(transactions[0].payer_name, 'Neema Joseph');
    assert.equal(transactions[0].payer_phone, '255712345678');
    assert.equal(transactions[0].status, 'successful');
    // A column named "Bank Reference" is the BANK's identifier for the payment,
    // so it becomes the dedup key, which is also the value the receipt quotes
    // when no payer reference exists (routes/paymentTransactions.js).
    assert.equal(transactions[0].provider_transaction_id, 'ZAKA/VRT-0003/2026-09');
  });

  it('distinguishes the payer reference from the provider reference when both are exported', () => {
    const csv = [
      'Date,Description,Bank Reference,Payer Reference,Credit',
      '16/09/2026,ZAKA/SUNDAY,BR-99812,ZAKA/VRT-0003/2026-09,"350,000"',
    ].join('\n');
    const { transactions } = parseStatement(csv, { account: { currency: 'TZS' } });
    assert.equal(transactions[0].provider_transaction_id, 'BR-99812');
    assert.equal(transactions[0].provider_reference, 'ZAKA/VRT-0003/2026-09');
  });

  it('reports a row it cannot use instead of dropping it silently', () => {
    const csv = [
      'Date,Description,Debit,Credit,Reference',
      '16/09/2026,LUKU ELECTRICITY,"240,000",,BIL/2026/441',
      'x/x/2026,BROKEN ROW,,50000,REF-1',
      '17/09/2026,ZAKA,,"50,000",REF-2',
    ].join('\n');
    const { transactions, rejected } = parseStatement(csv, { account: { currency: 'TZS' } });
    // The debit is the church paying a bill: not a gift, not an error. The broken
    // row is a real error, and it is REPORTED with its line number rather than
    // dropped: a statement that silently loses a payment is worse than one that
    // says which line it could not read.
    assert.deepEqual(rejected.map((r) => r.reason), ['payment.reject_notCredit', 'payment.reject_noDate']);
    assert.deepEqual(rejected.map((r) => r.line), [2, 3]);
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].amount, 50000);
  });

  it('says so when the file has no columns it recognises', () => {
    const { transactions, rejected } = parseStatement('Foo,Bar\n1,2', { account: {} });
    assert.deepEqual(transactions, []);
    assert.equal(rejected[0].reason, 'payment.reject_noColumns');
  });
});

describe('the webhook normalizer', () => {
  it('reads a mobile-money notification, joining the payer name', () => {
    const { transactions, rejected } = parseWebhook({
      transactions: [{
        TransID: 'MP810013Z', TransTime: '20260916093015', TransAmount: '175000',
        BillRefNumber: 'ZAKA VRT-0003', MSISDN: '255712345678', FirstName: 'Neema', LastName: 'Joseph',
      }],
    }, { account: { currency: 'TZS' } });
    assert.equal(rejected.length, 0);
    assert.deepEqual(transactions[0], {
      provider_transaction_id: 'MP810013Z',
      provider_reference: 'ZAKA VRT-0003',
      amount: 175000,
      currency: 'TZS',
      occurred_at: '2026-09-16 09:30:15',
      payer_name: 'Neema Joseph',
      payer_phone: '255712345678',
      payer_account_ref: null,
      description: null,
      status: 'successful',
    });
  });

  it('accepts a single transaction, an array and a nested envelope', () => {
    const one = { amount: 1000, date: '2026-09-16', reference: 'R1' };
    for (const body of [one, [one], { transactions: [one] }, { data: one }]) {
      const { transactions } = parseWebhook(body, { account: { currency: 'TZS' } });
      assert.equal(transactions.length, 1, JSON.stringify(body));
      assert.equal(transactions[0].amount, 1000);
    }
  });

  it('reports a notification with no amount or no date', () => {
    const { rejected } = parseWebhook({ transactions: [{ id: 'X' }, { id: 'Y', amount: 100 }] }, { account: {} });
    assert.deepEqual(rejected.map((r) => r.reason), ['payment.reject_noAmount', 'payment.reject_noDate']);
  });
});

describe('the provider registry', () => {
  it('names every provider in the list the i18n guard reads', () => {
    assert.deepEqual(PROVIDER_KEYS, listProviders().map((p) => p.key));
    for (const key of PROVIDER_KEYS) assert.ok(getProvider(key), `${key} must resolve`);
  });

  it('claims only capabilities it actually implements', () => {
    for (const provider of listProviders()) {
      const def = getProvider(provider.key);
      if (provider.capabilities.statement) assert.equal(typeof def.parseStatement, 'function', provider.key);
      if (provider.capabilities.webhook) assert.equal(typeof def.parseWebhook, 'function', provider.key);
      // Nothing claims a live bank API: there is no such integration yet, and a
      // provider that claimed one would be lying to the church that connected it.
      assert.equal(provider.capabilities.liveSync, false, provider.key);
      // An account is connected for ONE channel, so no provider advertises both.
      const channels = Number(provider.capabilities.statement) + Number(provider.capabilities.webhook);
      assert.equal(channels, 1, `${provider.key} must advertise exactly one intake channel`);
    }
  });
});

describe('the dedup key a provider without an id leaves us', () => {
  it('is stable for the same payment, which is what makes a re-sync idempotent', () => {
    const payment = { occurredAt: '2026-09-16 09:30:00', amount: 175000, currency: 'TZS', reference: 'MP810013Z' };
    assert.equal(deriveProviderTransactionId(payment), deriveProviderTransactionId({ ...payment }));
  });

  it('differs between two genuinely different payments', () => {
    const base = { occurredAt: '2026-09-16 09:30:00', amount: 175000, currency: 'TZS', reference: 'MP810013Z' };
    assert.notEqual(deriveProviderTransactionId(base), deriveProviderTransactionId({ ...base, amount: 176000 }));
    assert.notEqual(deriveProviderTransactionId(base), deriveProviderTransactionId({ ...base, reference: 'MP810014Z' }));
  });

  it('falls back to naming the payer when there is no reference at all', () => {
    const a = deriveProviderTransactionId({ occurredAt: '2026-09-16 09:30:00', amount: 5000, currency: 'TZS', payerName: 'Neema Joseph', payerPhone: '' });
    const b = deriveProviderTransactionId({ occurredAt: '2026-09-16 09:30:00', amount: 5000, currency: 'TZS', payerName: 'Elisha Makala', payerPhone: '' });
    assert.notEqual(a, b);
  });
});

describe('normalizing a provider row', () => {
  it('encrypts the payer phone and never stores it in the clear', () => {
    const { transaction } = normalizeTransaction(
      { amount: 1000, occurred_at: '2026-09-16', payer_phone: '255712345678' },
      { account: { id: 1, currency: 'TZS' } }
    );
    assert.equal(transaction.payer_phone, '255712345678');
    assert.ok(transaction.payer_phone_enc && transaction.payer_phone_enc !== '255712345678');
    assert.match(transaction.payer_phone_enc, /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  });

  it('refuses a row with no amount or no date, and defaults the currency', () => {
    assert.equal(normalizeTransaction({ amount: 0, occurred_at: '2026-09-16' }, { account: {} }).reason, 'payment.reject_noAmount');
    assert.equal(normalizeTransaction({ amount: 100 }, { account: {} }).reason, 'payment.reject_noDate');
    const { transaction } = normalizeTransaction({ amount: 100, occurred_at: '2026-09-16' }, { account: { currency: 'TZS' } });
    assert.equal(transaction.currency, 'TZS');
    // A row with no status at all is PENDING, not successful: "we do not know"
    // must never open the door to recording money the church has not seen.
    assert.equal(transaction.status, 'pending');
  });
});

describe('the matching rules', () => {
  const members = [
    { id: 1, name: 'Neema Joseph', member_no: 'VRT-0001', phone: '255712345678', is_active: 1 },
    { id: 2, name: 'Elisha Makala', member_no: 'VRT-0002', phone: '255787654321', is_active: 1 },
    { id: 3, name: 'Grace Mwakyusa', member_no: 'VRT-0003', phone: '255712345678', is_active: 1 },
    { id: 4, name: 'Peter Shirima', member_no: 'VRT-0004', phone: '', is_active: 0 },
  ];

  it('matches on the church\'s own member number, quoted in the reference', () => {
    const verdict = classifyMatch({ provider_reference: 'ZAKA VRT-0002', description: null }, members);
    assert.deepEqual(verdict, { status: 'matched', memberId: 2, method: 'member_no' });
  });

  it('matches on a phone number that belongs to exactly one member', () => {
    const verdict = classifyMatch({ payer_phone: '0787654321', payer_name: null }, members);
    assert.deepEqual(verdict, { status: 'matched', memberId: 2, method: 'phone' });
  });

  it('will NOT pick a member when a phone number belongs to two of them', () => {
    // A shared family phone is ambiguity. Guessing would attribute one family's
    // money to another, which is a mistake the church would have to explain.
    const verdict = classifyMatch({ payer_phone: '0712345678' }, members);
    assert.equal(verdict.status, 'review');
    assert.equal(verdict.memberId, null);
  });

  it('suggests but does not match on a name, however exact it is', () => {
    const verdict = classifyMatch({ payer_name: 'Grace  Mwakyusa.' }, members);
    assert.deepEqual(verdict, { status: 'review', memberId: 3, method: 'name' });
  });

  it('does not confuse one name with another that shares a word', () => {
    assert.equal(sameName('Neema Joseph', 'Neema'), false);
    assert.equal(sameName('Neema Joseph', 'Joseph Neema'), true);
    const verdict = classifyMatch({ payer_name: 'J. Mwakasege' }, members);
    assert.deepEqual(verdict, { status: 'unmatched', memberId: null, method: null });
  });

  it('leaves a payment with no payer information alone', () => {
    assert.deepEqual(classifyMatch({}, members), { status: 'unmatched', memberId: null, method: null });
  });

  it('never attributes a payment to a member who is no longer active', () => {
    const verdict = classifyMatch({ provider_reference: 'VRT-0004' }, members);
    assert.equal(verdict.status, 'unmatched');
  });

  it('does not let a name the church knows overrule the code', () => {
    // Two member facts disagree: the reference quotes VRT-0001 (Neema Joseph) and
    // the statement names Elisha Makala (VRT-0002). Either the code was mistyped
    // or somebody is paying on somebody else's behalf, and a four-digit code
    // cannot tell those apart, so the code's owner is PROPOSED and a person
    // decides. (server/test/giving-codes.test.js pins the rule end to end.)
    const verdict = classifyMatch({ provider_reference: 'VRT-0001', payer_name: 'Elisha Makala' }, members);
    assert.deepEqual(verdict, { status: 'review', memberId: 1, method: 'member_no', note: 'code_vs_payer_name' });
  });

  it('still matches when the payer is a stranger or the code’s own member', () => {
    // The ordinary "paid on a member's behalf" case: whoever sent the money is not
    // on the roll, and the code still says whose gift it is. Only a name that
    // belongs to a DIFFERENT member contradicts anything.
    assert.deepEqual(
      classifyMatch({ provider_reference: 'VRT-0001', payer_name: 'Juma Mgeni' }, members),
      { status: 'matched', memberId: 1, method: 'member_no' }
    );
    assert.deepEqual(
      classifyMatch({ provider_reference: 'VRT-0001', payer_name: 'Neema Joseph' }, members),
      { status: 'matched', memberId: 1, method: 'member_no' }
    );
  });

  it('recognises a member number however a payer writes it', () => {
    for (const text of ['VRT-0002', 'vrt 2', 'VRT0002', 'zaka vrt/2/2026']) {
      assert.equal(findMemberNumber(text), 'VRT-0002', text);
    }
    assert.equal(findMemberNumber('VRT-'), null);
  });
});

describe('account credentials', () => {
  it('stores a secret encrypted and returns only the field NAMES', () => {
    const { credentialsEnc, fields } = writeCredentials('webhook', { webhook_secret: 'whsec_abc123' }, null);
    assert.deepEqual(fields, ['webhook_secret']);
    assert.ok(credentialsEnc && !credentialsEnc.includes('whsec_abc123'), 'the secret must not be readable in the column');
    assert.deepEqual(readCredentialValues(credentialsEnc), { webhook_secret: 'whsec_abc123' });
  });

  it('drops any field the provider did not declare, so a password cannot be smuggled in', () => {
    const { credentialsEnc } = writeCredentials('webhook', { webhook_secret: 'whsec_abc123', password: 'hunter2' }, null);
    const stored = readCredentialValues(credentialsEnc);
    assert.deepEqual(Object.keys(stored), ['webhook_secret']);
  });

  it('keeps the stored secret when a client echoes back a mask', () => {
    const first = writeCredentials('webhook', { webhook_secret: 'whsec_abc123' }, null);
    const second = writeCredentials('webhook', { webhook_secret: 'whsec_••••' }, first.credentialsEnc);
    assert.deepEqual(readCredentialValues(second.credentialsEnc), { webhook_secret: 'whsec_abc123' });
  });

  it('masks an account reference down to its last four characters', () => {
    assert.equal(maskAccountRef('0150123456789'), '••••6789');
    assert.equal(maskAccountRef(''), null);
  });

  it('verifies an HMAC signature and refuses a tampered body', () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({ amount: 1000 });
    const signature = signWebhookBody(body, secret);
    assert.equal(verifyWebhookSignature({ rawBody: body, header: signature, secret }), true);
    assert.equal(verifyWebhookSignature({ rawBody: body, header: signature.slice(7), secret }), true, 'a bare hex digest is accepted too');
    assert.equal(verifyWebhookSignature({ rawBody: `${body} `, header: signature, secret }), false);
    assert.equal(verifyWebhookSignature({ rawBody: body, header: signWebhookBody(body, 'other'), secret }), false);
    // No secret configured means no way to authenticate the caller: an account
    // must never accept unauthenticated payments.
    assert.equal(verifyWebhookSignature({ rawBody: body, header: signature, secret: null }), false);
    assert.equal(verifyWebhookSignature({ rawBody: body, header: '', secret }), false);
  });
});

describe('phone comparison', () => {
  it('treats the ways one number is written as one number', () => {
    assert.equal(samePhone('+255712345678', '0712345678'), true);
    assert.equal(samePhone('0712 345 678', '0712345678'), true);
    assert.equal(samePhone('0712345678', '0712345679'), false);
    assert.equal(samePhone('', '0712345678'), false);
  });
});
