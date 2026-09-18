'use strict';
/**
 * The giving code: `VRT-0042`.
 *
 * Every member has a number, and that number is not internal bookkeeping: it is
 * the code a member quotes when they pay by bank or mobile money, and it is the
 * one identity a payment can carry that is unique (a name can be shared by two
 * people; a phone can be a family's; an amount is not an identity at all). The
 * rules worth protecting:
 *
 *   1. a member always HAS one: the form allocates it, and the boot migration
 *      fills it in for anybody who predates it or was inserted by hand;
 *   2. it is recognised however the payer writes it ('vrt 9', 'VRT0042',
 *      'ZAKA/VRT-0009/2026-06'), and a bare number is never mistaken for a code;
 *   3. a payment quoting it is matched to that member outright: the one signal
 *      strong enough to auto-attribute money (see utils/paymentIntake.js);
 *   4. the member is TOLD it: the receipt prints the code and what it is for, on
 *      the paper they keep;
 *   5. it is not published. The public verification page a stranger can scan
 *      shows the receipt, not whose member number it is.
 *
 * The code is deliberately not a second field beside `members.member_no`: adding
 * a parallel "giving code" would be two answers to "which person is this?" and the
 * matcher would have to prefer one.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { canonicalMemberNo, findMemberNumber } = require('../utils/identityMatch');

const suite = startServer({ name: 'giving-codes', port: 4641 });

// Required AFTER startServer: db/migrate.js pulls in db/pg.js, which refuses to
// load under NODE_ENV=test until DATABASE_URL points at a throwaway database,
// which is what startServer repoints synchronously.
const { migrate } = require('../db/migrate');

const ADMIN = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const DESK = { email: 'codes.desk@test.local', password: 'DeskPass_123!' };
const SW = { 'X-Language': 'sw' };

let adminToken;
let deskToken;

after(() => suite.stop());

/** A member registered the way the front desk registers one. */
async function registerMember(name, phone) {
  const res = await suite.api('POST', '/api/members', adminToken, { name, phone });
  assert.equal(res.status, 201, res.text);
  return res.json.member;
}

/** A receipted gift from the desk, optionally attached to a member. */
async function recordGift(extra = {}) {
  const res = await suite.api('POST', '/api/offerings', deskToken, {
    serviceTypeId: 1, category: 'zaka', amount: 50000, currency: 'TZS',
    offererName: 'Elisha Makala', receipt: true, ...extra,
  });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

/** One bank statement, read by the real statement reader. */
async function importStatement(reference, payerName = '') {
  const account = await suite.api('POST', '/api/payment-accounts', adminToken, {
    name: `Codes test bank ${Date.now()}`, provider: 'statement_import', method: 'bank',
  });
  assert.equal(account.status, 201, account.text);
  const accountId = account.json.account.id;

  const statement = [
    'Transaction Date,Description,Reference,Credit,Payer Name',
    `13/09/2026,OFFERING DEPOSIT,"${reference}","50,000","${payerName}"`,
  ].join('\n');
  const sync = await suite.api('POST', `/api/payment-accounts/${accountId}/sync`, adminToken, { statement });
  assert.equal(sync.status, 200, sync.text);

  const transaction = await suite.get(
    'SELECT * FROM payment_transactions WHERE account_id = ? ORDER BY id LIMIT 1',
    [accountId]
  );
  return { sync: sync.json, transaction };
}

describe('the giving code', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, ADMIN);
    assert.equal(admin.status, 200, admin.text);
    adminToken = admin.json.token;

    const created = await suite.api('POST', '/api/users', adminToken, {
      name: 'Codes Desk', email: DESK.email, role: 'receptionist', password: DESK.password,
    });
    assert.equal(created.status, 201, created.text);
    const login = await suite.api('POST', '/api/auth/login', null, DESK);
    assert.equal(login.status, 200, login.text);
    deskToken = login.json.token;
  });

  // ---------------------------------------------------------------------------
  // 1. Reading a code out of what a payer wrote
  // ---------------------------------------------------------------------------
  describe('reading the code', () => {
    it('recognises it however a payer writes it', () => {
      // The forms people actually type on a phone keypad and a bank slip.
      assert.equal(findMemberNumber('VRT-0009'), 'VRT-0009');
      assert.equal(findMemberNumber('vrt 9'), 'VRT-0009');
      assert.equal(findMemberNumber('VRT0042'), 'VRT-0042');
      assert.equal(findMemberNumber('ZAKA/VRT-0009/2026-06'), 'VRT-0009');
      assert.equal(findMemberNumber('SADAKA vrt-42'), 'VRT-0042');
      assert.equal(findMemberNumber('dep VRT 8'), 'VRT-0008');
    });

    it('never turns a bare number into a code', () => {
      // A statement is full of numbers: amounts, dates, slip numbers. Reading
      // any of them as a member number would attribute a stranger's gift.
      assert.equal(findMemberNumber('OFFERING'), null);
      assert.equal(findMemberNumber('REF 0009'), null);
      assert.equal(findMemberNumber('DEP/20260913/0042'), null);
      assert.equal(findMemberNumber(''), null);
      assert.equal(findMemberNumber('VRT-1234567'), null, 'not a member number');
      assert.equal(canonicalMemberNo('0009'), null);
    });

    it('canonicalises a stored code too, so a legacy spelling still matches', () => {
      // The column has always allowed any text, so a row may hold 'vrt-9'.
      assert.equal(canonicalMemberNo('vrt-9'), 'VRT-0009');
      assert.equal(canonicalMemberNo(' VRT 0009 '), 'VRT-0009');
      assert.equal(canonicalMemberNo('VRT-0009'), 'VRT-0009');
      assert.equal(canonicalMemberNo(null), null);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Every member has one
  // ---------------------------------------------------------------------------
  describe('every member has one', () => {
    it('allocates the next code when a member is registered', async () => {
      const before = await suite.get(
        "SELECT MAX(CAST(substr(member_no, 5) AS INTEGER)) AS max_no FROM members WHERE member_no ~ '^VRT-[0-9]+$'"
      );
      const member = await registerMember('Neema Joseph', '+255712345678');

      assert.match(member.member_no, /^VRT-\d{4}$/, `unexpected code ${member.member_no}`);
      assert.equal(member.member_no, `VRT-${String(Number(before.max_no) + 1).padStart(4, '0')}`);
    });

    it('gives a code to a member who has none, on the next boot', async () => {
      // A row inserted by hand, or a member who predates the number. The column
      // allows NULL, so this is a real state and not a hypothetical one.
      const member = await registerMember('Ruth Mwita', '+255713000111');
      await suite.run('UPDATE members SET member_no = NULL WHERE id = ?', [member.id]);

      const applied = await migrate();
      assert.ok(
        applied.some((entry) => /member numbers issued for 1 member/.test(entry)),
        `the boot migration did not report the backfill: ${JSON.stringify(applied)}`
      );

      const coded = await suite.get('SELECT member_no FROM members WHERE id = ?', [member.id]);
      assert.match(coded.member_no, /^VRT-\d{4}$/);
    });

    it('leaves an existing code alone, however many times it runs', async () => {
      // A number already written on a giving envelope must never be reissued.
      const member = await registerMember('Anna Kimaro', '+255714000222');
      await migrate();
      await migrate();

      const after = await suite.get('SELECT member_no FROM members WHERE id = ?', [member.id]);
      assert.equal(after.member_no, member.member_no);
      // …and no member is left without one.
      const coded = await suite.get("SELECT COUNT(*)::int AS n FROM members WHERE member_no IS NULL OR member_no = ''");
      assert.equal(coded.n, 0);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. A payment that quotes it
  // ---------------------------------------------------------------------------
  describe('a payment that quotes the code', () => {
    it('is matched to that member outright, in whatever spelling arrived', async () => {
      const member = await registerMember('Halima Saidi', '+255715000333');
      // The payer quotes the code the way they write it, not the way it is stored.
      const written = member.member_no.toLowerCase().replace('-', ' ');

      const { sync, transaction } = await importStatement(`ZAKA/${written}/2026-09`, 'H. Saidi');

      assert.equal(sync.matched, 1, `expected the code to match: ${JSON.stringify(sync)}`);
      assert.equal(transaction.matched_member_id, member.id);
      assert.equal(transaction.match_method, 'member_no', 'the strongest signal, not a name guess');
      assert.equal(transaction.match_status, 'matched');
    });

    it('does not attribute a payment on a name alone', async () => {
      // The same member, the same amount, the same payer name, and no code. The
      // name is a SUGGESTION a human confirms; money is never booked to a person
      // because their name appears on a statement.
      const member = await registerMember('Tumaini Kessy', '+255716000444');
      const { transaction } = await importStatement('OFFERING', member.name);

      assert.equal(transaction.match_status, 'review');
      assert.equal(transaction.matched_member_id, null);
      assert.equal(transaction.suggested_member_id, member.id, 'the name is offered, not applied');
    });

    it('leaves a bare number alone rather than guessing at it', async () => {
      const member = await registerMember('Fatuma Ally', '+255717000555');
      const digits = member.member_no.replace(/\D/g, '');

      const { transaction } = await importStatement(`DEP/${digits}`, '');
      assert.notEqual(transaction.matched_member_id, member.id);
      assert.equal(transaction.match_status, 'unmatched');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. The member is told what it is for
  // ---------------------------------------------------------------------------
  describe('the receipt carries it', () => {
    let member;

    before(async () => {
      member = await registerMember('Elisha Makala', '+255718000666');
    });

    it("prints the giver's code, and says what to do with it", async () => {
      const gift = await recordGift({ memberId: member.id, offererName: member.name });
      const res = await suite.api('GET', `/api/offerings/${gift.id}/receipt`, deskToken);

      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.match(res.text, new RegExp(`Giving code</span><span class="value">${member.member_no}`));
      // The line that makes it useful: the receipt is the paper the member keeps.
      assert.ok(
        res.text.includes('Quote this code when you pay by bank or mobile money'),
        'the receipt does not say what the code is for'
      );
    });

    it('prints it in the reader’s language', async () => {
      const gift = await recordGift({ memberId: member.id, offererName: member.name });
      const res = await suite.api('GET', `/api/offerings/${gift.id}/receipt`, deskToken, null, SW);

      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.match(res.text, new RegExp(`Msimbo wa kutoa</span><span class="value">${member.member_no}`));
      assert.ok(!res.text.includes('Giving code'), 'the Kiswahili receipt still shows the English label');
    });

    it('prints no code for a gift with no member behind it', async () => {
      // A cash gift signed for by hand: there is nobody to give a code to, and
      // printing one would be inventing an identity.
      const gift = await recordGift({ offererName: 'A Visitor' });
      const res = await suite.api('GET', `/api/offerings/${gift.id}/receipt`, deskToken);

      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.ok(!res.text.includes('Giving code'), 'a code was printed for a non-member gift');
      assert.ok(!res.text.includes('Quote this code'), 'the hint was printed with no code');
    });

    it('carries it into the PDF as well', async () => {
      // pdfkit compresses its streams, so the content itself is pinned on the
      // HTML above; what is checked here is that the two documents are genuinely
      // different: a member's receipt and a hand-signed one.
      const withCode = await recordGift({ memberId: member.id, offererName: member.name });
      const bare = await recordGift({ offererName: 'A Visitor' });
      const coded = await suite.api('GET', `/api/offerings/${withCode.id}/receipt.pdf`, deskToken);
      const plain = await suite.api('GET', `/api/offerings/${bare.id}/receipt.pdf`, deskToken);

      assert.equal(coded.status, 200, coded.text.slice(0, 120));
      assert.equal(plain.status, 200, plain.text.slice(0, 120));
      assert.ok(coded.text.startsWith('%PDF') && plain.text.startsWith('%PDF'));
      assert.notEqual(coded.text.slice(0, 2000), plain.text.slice(0, 2000));
    });

    it('is not published on the page a stranger scans', async () => {
      const gift = await recordGift({ memberId: member.id, offererName: member.name });
      const row = await suite.get('SELECT verification_token FROM offerings WHERE id = ?', [gift.id]);

      const page = await suite.api('GET', `/verify/receipt/${row.verification_token}`, null);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('Receipt Verified'));
      // The scanner is holding the paper, so it may show the receipt, not the
      // numbered identity of the person who gave it.
      assert.ok(!page.text.includes(member.member_no), 'the public page leaked a member number');
      assert.ok(!page.text.includes('Giving code'));
    });
  });

  // ---------------------------------------------------------------------------
  // 5. When the code and the payer's name disagree
  // ---------------------------------------------------------------------------
  describe('a code that contradicts the name on the statement', () => {
    // A code is four digits. Somebody meaning to write their own VRT-0010 and
    // writing VRT-0020 has quoted a code that belongs to a real member, and no
    // amount of canonicalising can tell the two apart, so the name is read as
    // evidence AGAINST the code, and a human decides.
    let owner;
    let named;

    before(async () => {
      owner = await registerMember('Zawadi Mkumbo', '+255719000777');
      named = await registerMember('Baraka Nyerere', '+255719000888');
    });

    it('still matches when the payer is the code’s own member', async () => {
      const { transaction } = await importStatement(`ZAKA/${owner.member_no}/2026-09`, owner.name);

      assert.equal(transaction.match_status, 'matched');
      assert.equal(transaction.matched_member_id, owner.id);
      assert.equal(transaction.match_note, null, 'agreement needs no note');
    });

    it('still matches when the payer is nobody on the roll', async () => {
      // The ordinary case, and the reason the rule is not "the name must agree":
      // a relative, a friend or an employer pays on a member's behalf, and the
      // code they quoted says whose gift it is. A stranger contradicts nothing.
      const { transaction } = await importStatement(`ZAKA/${owner.member_no}/2026-10`, 'Juma Mgeni');

      assert.equal(transaction.match_status, 'matched', 'an unknown payer is not a contradiction too');
      assert.equal(transaction.matched_member_id, owner.id);
      assert.equal(transaction.match_note, null);
    });

    it('asks a person when the statement names a different member', async () => {
      const { transaction } = await importStatement(`ZAKA/${owner.member_no}/2026-11`, named.name);

      assert.equal(transaction.match_status, 'review');
      assert.equal(transaction.matched_member_id, null, 'money is never booked on a disputed code');
      assert.equal(transaction.suggested_member_id, owner.id, 'the code is still the best evidence there is');
      assert.equal(transaction.match_method, 'member_no');
      assert.equal(transaction.match_note, 'code_vs_payer_name');

      // …and the screen can say WHY it is waiting, in the reader's language.
      const list = await suite.api('GET', '/api/payment-transactions?matchStatus=review', adminToken);
      assert.equal(list.status, 200, list.text);
      const row = list.json.transactions.find((t) => t.id === transaction.id);
      assert.ok(row, 'the disputed payment is not in the review queue');
      assert.equal(row.matchNote, 'code_vs_payer_name');
      assert.equal(row.matchedMemberName, null);
      assert.equal(row.suggestedMemberName, owner.name);
      assert.equal(row.payerName, named.name, 'the admin can see the name that disagreed');
    });

    it('stops asking once a person decides, and can be undone again', async () => {
      // The admin reads the payer's name on the statement and says it is that
      // member's gift. The decision is final against later syncs, and the one
      // thing that may reverse it is another person asking to take it back.
      const { transaction } = await importStatement(`ZAKA/${owner.member_no}/2026-12`, named.name);
      assert.equal(transaction.match_status, 'review');

      const matched = await suite.api('POST', `/api/payment-transactions/${transaction.id}/match`, adminToken, { memberId: named.id });
      assert.equal(matched.status, 200, matched.text);
      const decided = await suite.get('SELECT match_status, match_method, match_note, matched_member_id FROM payment_transactions WHERE id = ?', [transaction.id]);
      assert.equal(decided.match_status, 'matched');
      assert.equal(decided.match_method, 'manual');
      assert.equal(decided.matched_member_id, named.id);
      assert.equal(decided.match_note, null, 'a decision does not need the matcher’s note');

      // Taking it back hands the question to the rules again, rather than parking
      // the row at a status nobody chose, which is what a strict reading of "the
      // matcher never touches a manual match" would have done here.
      const back = await suite.api('POST', `/api/payment-transactions/${transaction.id}/unmatch`, adminToken);
      assert.equal(back.status, 200, back.text);
      const reopened = await suite.get('SELECT match_status, match_note, suggested_member_id FROM payment_transactions WHERE id = ?', [transaction.id]);
      assert.equal(reopened.match_status, 'review', 'the dispute is back where it started');
      assert.equal(reopened.match_note, 'code_vs_payer_name');
      assert.equal(reopened.suggested_member_id, owner.id);
    });
  });
});
