'use strict';
/**
 * The sample giving data, and the promise that removing it removes nothing else.
 *
 * The seeder is a development tool, but it writes into a database that may hold a
 * real church's records, so its PURGE is the part that has to be right: it must
 * find exactly its own footprint (never a date window, never a guess), be safe to
 * run twice, and leave every real record untouched: including the audit chain,
 * which re-links entries rather than reporting itself as tampered.
 *
 * The seeder is run as a CHILD PROCESS against this suite's throwaway database,
 * with the same command a developer would type, so a broken script fails here
 * instead of in somebody's development database.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'demo-giving', port: 4633 });
const SERVER_DIR = path.join(__dirname, '..');

const SUPER = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const DEMO_MEMBER_NOTE = 'Sample giving data (scripts/sample-giving.js)';

let adminToken;

/** Runs the seeder/purge exactly as the npm script does, against the suite's DB. */
function run(args, extraEnv = {}) {
  return spawnSync('node', ['scripts/sample-giving.js', ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: suite.url, NODE_ENV: 'test', ...extraEnv },
    encoding: 'utf8',
  });
}

async function demoFootprint() {
  const types = await suite.all("SELECT id FROM service_types WHERE key LIKE 'demo_%'");
  const ids = types.map((t) => t.id);
  const services = ids.length ? await suite.all('SELECT id FROM services WHERE service_type_id = ANY(?)', [ids]) : [];
  const serviceIds = services.map((s) => s.id);
  return {
    types: types.length,
    services: services.length,
    offerings: serviceIds.length ? (await suite.get('SELECT COUNT(*)::int AS n FROM offerings WHERE service_id = ANY(?)', [serviceIds])).n : 0,
    accounts: (await suite.get('SELECT COUNT(*)::int AS n FROM payment_accounts')).n,
    transactions: (await suite.get('SELECT COUNT(*)::int AS n FROM payment_transactions')).n,
    members: (await suite.get('SELECT COUNT(*)::int AS n FROM members WHERE notes = ?', [DEMO_MEMBER_NOTE])).n,
  };
}

describe('sample giving data', () => {
  let realMember;
  let realOffering;

  before(async () => {
    await suite.waitReady();
    const login = await suite.api('POST', '/api/auth/login', null, SUPER);
    assert.equal(login.status, 200, login.text);
    adminToken = login.json.token;

    // A REAL record, written before the seeder runs: the purge must not touch it,
    // and its receipt must still verify afterwards.
    const member = await suite.api('POST', '/api/members', adminToken, { name: 'Real Giver', email: 'real.giver@test.local' });
    assert.equal(member.status, 201, member.text);
    realMember = member.json.member;
    const offering = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: 1, category: 'zaka', amount: 75000, currency: 'TZS', offererName: 'Real Giver', memberId: realMember.id, receipt: true,
    });
    assert.equal(offering.status, 201, offering.text);
    realOffering = offering.json;
  });

  after(() => suite.stop());

  describe('seeding', () => {
    let run1;

    it('writes a few months of church giving through the real import pipeline', async () => {
      run1 = run(['seed']);
      assert.equal(run1.status, 0, `${run1.stdout}\n${run1.stderr}`);
      assert.match(run1.stdout, /Giving by method/);
      assert.match(run1.stdout, /3 complete months \+ month to date/);

      const footprint = await demoFootprint();
      assert.equal(footprint.accounts, 2, 'a bank account and a mobile-money till');
      assert.ok(footprint.offerings > 200, `expected a few hundred gifts, saw ${footprint.offerings}`);
      assert.ok(footprint.transactions > 50, `expected imported payments, saw ${footprint.transactions}`);
      assert.ok(footprint.members >= 1, 'the seeder must create the donors it needs');
      assert.ok(footprint.services > 20, 'services are the sessions giving is recorded against');
    });

    it('covers every payment method, so no breakdown has a single row', async () => {
      const res = await suite.api('GET', '/api/reports/breakdown?groupBy=payment', adminToken);
      assert.equal(res.status, 200, res.text);
      const methods = res.json.breakdown.map((r) => r.key);
      for (const method of ['cash', 'mobile_money', 'bank', 'cheque']) {
        assert.ok(methods.includes(method), `${method} is missing from the sample data: ${methods}`);
      }
    });

    // Sample data is a HISTORY, not a pile of rows written this afternoon. The
    // timestamp an offering carries is the recording time the receipt prints, so
    // a demo that left it at "now" would show three months of giving all recorded
    // today, and a September that dwarfs every other month on the charts.
    it('dates its gifts to the days they happened, across more than one month', async () => {
      const months = await suite.all(
        "SELECT substr(s.date, 1, 7) AS month, COUNT(*)::int AS gifts FROM offerings o JOIN services s ON s.id = o.service_id JOIN service_types st ON st.id = s.service_type_id WHERE st.key LIKE 'demo_%' GROUP BY 1 ORDER BY 1"
      );
      assert.ok(months.length >= 3, `expected months of history, saw ${months.length}`);
      for (const month of months) {
        assert.ok(Number(month.gifts) > 5, `${month.month} holds only ${month.gifts} gifts`);
      }

      // Every imported gift is dated the day its payment moved, not the day the
      // statement was read: that is what makes the trend line a trend.
      const imported = await suite.get(
        "SELECT COUNT(*)::int AS n FROM offerings o JOIN payment_transactions pt ON pt.id = o.payment_transaction_id WHERE o.source = 'import' AND substr(o.timestamp, 1, 10) <> substr(pt.occurred_at, 1, 10)"
      );
      assert.equal(imported.n, 0, 'an imported gift must be dated the day the money moved');

      // …and the biggest month is not a multiple of the smallest one, which is the
      // shape a chart of one enormous month would have.
      const totals = months.map((m) => Number(m.gifts));
      assert.ok(Math.max(...totals) < Math.min(...totals) * 3, `gifts per month are lopsided: ${totals}`);
    });

    it('fills the reconciliation queue instead of confirming everything', async () => {
      const summary = await suite.api('GET', '/api/payment-transactions/summary', adminToken);
      assert.equal(summary.status, 200, summary.text);
      assert.ok(summary.json.counts.confirmed > 10, 'most matched payments become giving');
      assert.ok(summary.json.counts.unmatched > 0, 'somebody must be left to explain');
      assert.ok(summary.json.counts.review > 0, 'and somebody must be left to confirm');
      assert.ok(summary.json.awaitingAmount > 0);
    });

    it('leaves receipts that verify, and a payment that cannot be confirmed', async () => {
      const withReceipt = await suite.get(
        "SELECT o.* FROM offerings o JOIN services s ON s.id = o.service_id JOIN service_types st ON st.id = s.service_type_id WHERE st.key LIKE 'demo_%' AND o.receipt_number IS NOT NULL AND o.source = 'import' LIMIT 1"
      );
      assert.ok(withReceipt, 'a sample imported gift must carry a receipt');
      const page = await fetch(`${suite.base}/verify/receipt/${withReceipt.verification_token}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Receipt Verified/);

      // The one state that has no other way to be seen: a statement line whose
      // giving code names one member and whose payer is another. The rules refuse
      // to book it (utils/paymentIntake.js), so the demo must contain one or the
      // review screen's conflict badge is unreachable.
      const conflicted = await suite.get(
        "SELECT COUNT(*)::int AS n FROM payment_transactions WHERE match_note = 'code_vs_payer_name'"
      );
      assert.equal(conflicted.n, 1, 'the demo must show a code that disagrees with the payer');

      const reversed = await suite.get("SELECT * FROM payment_transactions WHERE status IN ('reversed','failed') AND match_status <> 'confirmed' LIMIT 1");
      assert.ok(reversed, 'the sample data must include money the provider took back');
      const refused = await suite.api('POST', `/api/payment-transactions/${reversed.id}/confirm`, adminToken, { category: 'zaka', serviceTypeId: 1 });
      assert.equal(refused.status, 400, refused.text);
    });

    it('demonstrates deduplication rather than hiding it', async () => {
      // The seeder delivers one notification twice, and re-issues one bank
      // payment under a new provider id: the first must add nothing, the second
      // must be recorded and flagged as a possible duplicate.
      const flagged = await suite.get('SELECT COUNT(*)::int AS n FROM payment_transactions WHERE possible_duplicate_of IS NOT NULL');
      assert.equal(flagged.n, 1, 'the re-issued payment must be flagged, not silently dropped');

      const duplicateIds = await suite.all(
        "SELECT provider_transaction_id, COUNT(*)::int AS n FROM payment_transactions GROUP BY account_id, provider_transaction_id HAVING COUNT(*) > 1"
      );
      assert.deepEqual(duplicateIds, [], 'no provider transaction may be stored twice');
    });

    it('refuses to run twice, so nobody ends up with two copies of the demo', async () => {
      const again = run(['seed']);
      assert.notEqual(again.status, 0);
      assert.match(`${again.stdout}${again.stderr}`, /already present/);
    });

    it('refuses to run at all in production', () => {
      const prod = run(['seed'], { NODE_ENV: 'production' });
      assert.notEqual(prod.status, 0);
      assert.match(`${prod.stdout}${prod.stderr}`, /refusing to run/);
    });
  });

  describe('purging', () => {
    it('changes nothing on a dry run', async () => {
      const before = await demoFootprint();
      const dry = run(['purge']);
      assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
      assert.match(dry.stdout, /DRY RUN/);
      assert.match(dry.stdout, /Would remove:/);
      assert.deepEqual(await demoFootprint(), before);
    });

    it('removes exactly its own footprint and nothing else', async () => {
      const applied = run(['purge', '--apply']);
      assert.equal(applied.status, 0, `${applied.stdout}\n${applied.stderr}`);
      assert.match(applied.stdout, /Remaining sample rows: 0/);
      assert.match(applied.stdout, /Clean:/);

      assert.deepEqual(await demoFootprint(), { types: 0, services: 0, offerings: 0, accounts: 0, transactions: 0, members: 0 });

      // The real records are untouched, and the real receipt still verifies.
      const member = await suite.get('SELECT * FROM members WHERE id = ?', [realMember.id]);
      assert.ok(member, 'a real member must survive the purge');
      const offering = await suite.get('SELECT * FROM offerings WHERE id = ?', [realOffering.id]);
      assert.ok(offering && offering.receipt_number, 'a real receipt must survive the purge');
      const page = await fetch(`${suite.base}/verify/receipt/${offering.verification_token}`);
      assert.equal(page.status, 200, 'the real receipt must still verify after a purge');
      assert.match(await page.text(), /Receipt Verified/);
    });

    it('leaves the tamper-evident audit chain valid', async () => {
      const res = await suite.api('GET', '/api/reports/audit-integrity', adminToken);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.valid, true, 'removing sample rows must not break the audit chain');
    });

    it('reports that there is nothing left to purge', async () => {
      const again = run(['purge']);
      assert.equal(again.status, 0, again.stdout);
      assert.match(again.stdout, /Nothing to purge/);
    });
  });
});
