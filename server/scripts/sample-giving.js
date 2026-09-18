'use strict';
/**
 * A church's giving history, as sample data: enough of it to see every giving
 * screen doing its job.
 *
 * WHY THIS IS NOT RANDOM NUMBERS
 * ------------------------------
 * A development database with three gifts in it makes every report look broken,
 * and the failures it hides are the interesting ones: a method breakdown with one
 * method, a trend line with one point, a reconciliation queue with nothing in it.
 * So this writes a plausible few months of a real church's giving: tithes that
 * repeat weekly from the same families, loose cash in the general offering that
 * nobody signs for, a monthly bank transfer from a member who gives by standing
 * order, quarterly cheques from a member and a company, a building-fund campaign,
 * and a provider feed with payments that are matched, awaiting review, or
 * unexplained.
 *
 * THE MONEY GOES THROUGH THE REAL MACHINERY
 * -----------------------------------------
 * Nothing here writes an offering "as if" it had been imported. The bank rows are
 * generated as a STATEMENT EXPORT and read by the same parser a real upload uses;
 * the mobile-money rows are generated as PROVIDER NOTIFICATIONS and read by the
 * same webhook normalizer; both are written by the same idempotent intake that
 * deduplicates a re-sync, matched by the same rules, and the confirmed ones become
 * offerings through the same writer the front desk and the reconciliation screen
 * use (utils/offeringRecord.js): receipts, QR tokens, payment references and all.
 * So the demo data is a demonstration of the feature, not a fixture that happens
 * to look like it.
 *
 * HOW THE PURGE IS EXACT
 * ----------------------
 * Everything is found STRUCTURALLY, never by date or by a guess:
 *   - the demo payment accounts are marked `source = 'demo'`, and every payment
 *     transaction belongs to one of them;
 *   - the demo services hang off demo SERVICE TYPES (`key LIKE 'demo_%'`), and
 *     every offering belongs to one of those services: the cash gifts the desk
 *     typed included;
 *   - members the seeder had to create are marked in `notes`;
 *   - the audit entries it writes carry `details.demo = true`.
 * So `purge` removes exactly this script's footprint and cannot touch a real
 * record: nothing real is ever a candidate. It refuses to run at all when
 * NODE_ENV=production.
 *
 * USAGE
 *   npm run seed:giving                      # write the sample data
 *   npm run purge:giving                     # dry run: what would be removed
 *   npm run purge:giving -- --apply          # remove it (--force is the same)
 */
require('dotenv').config();

const pool = require('../db/pg');
const { migrate } = require('../db/migrate');
const { encryptField } = require('../utils/crypto');
const { logAudit } = require('../utils/audit');
const { rebuildChain } = require('../utils/audit');
const { insertOffering } = require('../utils/offeringRecord');
const { generateVerificationToken } = require('../utils/verificationToken');
const { ingestTransactions, matchPendingTransactions } = require('../utils/paymentIntake');
const { getProvider } = require('../utils/paymentProviders');

const MODE = process.argv[2];
const APPLY = process.argv.includes('--apply') || process.argv.includes('--force');

const DEMO_MEMBER_NOTE = 'Sample giving data (scripts/sample-giving.js)';
const ACCOUNT_MARKER = 'starter';              // part of the demo accounts' account_ref
const SERVICE_TYPE_PREFIX = 'demo_';

// How much history to write: three complete months plus the month in progress, so
// daily, weekly, monthly and month-to-date reports all have something in them.
const MONTHS_BACK = 3;

// ---------------------------------------------------------------------------
// Deterministic randomness. A seeded generator means the same church calendar
// and the same amounts every run: a bug found in a report can be reproduced
// instead of hunted, and a screenshot in a bug report still matches afterwards.
// ---------------------------------------------------------------------------
function makeRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}
const rng = makeRandom(20260916);
const pick = (list) => list[Math.floor(rng() * list.length)];
const between = (min, max) => min + rng() * (max - min);
/** A plausible TZS amount: whole thousands, never 43,217. */
const amountBetween = (min, max) => Math.max(1000, Math.round(between(min, max) / 1000) * 1000);

const DONORS = [
  { name: 'Neema Joseph', gender: 'female' },
  { name: 'Elisha Makala', gender: 'male' },
  { name: 'Grace Mwakyusa', gender: 'female' },
  { name: 'Baraka Kimaro', gender: 'male' },
  { name: 'Zawadi Msuya', gender: 'female' },
  { name: 'Amani Lyimo', gender: 'male' },
  { name: 'Upendo Mrema', gender: 'female' },
  { name: 'Tumaini Kessy', gender: 'male' },
  { name: 'Heri Mwakalinga', gender: 'male' },
  { name: 'Salome Nnko', gender: 'female' },
  { name: 'Yohana Msigwa', gender: 'male' },
  { name: 'Rehema Ntambi', gender: 'female' },
  { name: 'Daniel Chuwa', gender: 'male' },
  { name: 'Martha Kileo', gender: 'female' },
  { name: 'Samson Mwaijande', gender: 'male' },
  { name: 'Esther Mbwana', gender: 'female' },
  { name: 'Peter Shirima', gender: 'male' },
  { name: 'Naomi Mahundi', gender: 'female' },
];

/** Organisations and strangers who give without being members: a company cheque
 *  and a visitor's offering are both part of the picture, and neither has a
 *  member record to attach to. */
const NON_MEMBER_DONORS = [
  'Kilimanjaro Hardware Ltd',
  'Tanzania Youth Trust',
  'Mwanga Women Traders',
  'Mwanza Bus Services Ltd',
];

const MOBILE_WALLETS = ['MPESA', 'TIGO', 'AIRTEL', 'HALOPESA'];

/** Payers who are not members: a visitor, a relative, somebody settling a debt
 *  through the church's till. Their money is real and unexplained until an admin
 *  says what it is, which is the whole point of the review queue. */
const STRANGERS = ['Salum M.', 'Amina H.', 'Juma K.', 'Halima S.', 'Ibrahim N.'];

const money = (value) => Number(value).toLocaleString('en-GB');

/** The three rhythms a church's week actually has. */
const RHYTHMS = [
  { key: 'demo_sunday', name: 'Sample 1st Sunday Service', day: 0, time: '10:30:00' },
  { key: 'demo_wednesday', name: 'Sample Wednesday Service', day: 3, time: '17:30:00' },
  { key: 'demo_friday', name: 'Sample Friday Service', day: 5, time: '18:00:00' },
];

const pad = (n) => String(n).padStart(2, '0');
const iso = (date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const target = () => {
  const url = new URL(process.env.DATABASE_URL);
  return `${url.hostname}:${url.port || 5432}${url.pathname}`;
};

/** Every service date in the window, grouped by the weekday rhythm it belongs
 *  to. Complete months plus the month in progress, so a monthly report and a
 *  month-to-date figure are both non-empty. */
function calendar(today = new Date()) {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - MONTHS_BACK, 1));
  const dates = { sunday: [], wednesday: [], friday: [] };
  for (let d = new Date(start); d <= today; d = new Date(d.getTime() + 86400000)) {
    if (d.getUTCDay() === 0) dates.sunday.push(iso(d));
    if (d.getUTCDay() === 3) dates.wednesday.push(iso(d));
    if (d.getUTCDay() === 5) dates.friday.push(iso(d));
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Receipt numbers, allocated in a block rather than one query per gift
// ---------------------------------------------------------------------------
function receiptAllocator() {
  const counters = new Map();
  return async (client, date) => {
    const year = String(date).slice(0, 4);
    if (!counters.has(year)) {
      const prefix = `VR-${year}-`;
      const { rows } = await client.query(
        'SELECT MAX(CAST(substr(receipt_number, LENGTH($1) + 1) AS INTEGER)) AS max_no FROM offerings WHERE receipt_number LIKE $2',
        [prefix, `${prefix}%`]
      );
      counters.set(year, Number(rows[0].max_no) || 0);
    }
    const next = counters.get(year) + 1;
    counters.set(year, next);
    return `VR-${year}-${String(next).padStart(4, '0')}`;
  };
}

/** The demo footprint, found structurally (see the header). */
async function footprint(runner) {
  const { rows: types } = await runner.query(
    `SELECT id, key, name FROM service_types WHERE key LIKE $1`,
    [`${SERVICE_TYPE_PREFIX}%`]
  );
  const typeIds = types.map((t) => t.id);
  const { rows: services } = typeIds.length
    ? await runner.query('SELECT id FROM services WHERE service_type_id = ANY($1::int[])', [typeIds])
    : { rows: [] };
  const serviceIds = services.map((s) => s.id);
  const { rows: offerings } = serviceIds.length
    ? await runner.query('SELECT id FROM offerings WHERE service_id = ANY($1::int[])', [serviceIds])
    : { rows: [] };
  const { rows: accounts } = await runner.query("SELECT id FROM payment_accounts WHERE source = 'demo'");
  const accountIds = accounts.map((a) => a.id);
  const { rows: transactions } = accountIds.length
    ? await runner.query('SELECT id FROM payment_transactions WHERE account_id = ANY($1::int[])', [accountIds])
    : { rows: [] };
  const { rows: members } = await runner.query('SELECT id FROM members WHERE notes = $1', [DEMO_MEMBER_NOTE]);
  const { rows: audits } = await runner.query(
    "SELECT id FROM audit_log WHERE details IS NOT NULL AND details LIKE '{%' AND details::json ->> 'demo' = 'true'"
  );
  return {
    types,
    typeIds,
    services: serviceIds,
    offerings: offerings.map((o) => o.id),
    accounts: accountIds,
    transactions: transactions.map((t) => t.id),
    members: members.map((m) => m.id),
    audits: audits.map((a) => a.id),
  };
}

async function counts(runner) {
  const { rows } = await runner.query(
    `SELECT
       (SELECT count(*)::int FROM offerings) AS offerings,
       (SELECT count(*)::int FROM payment_transactions) AS transactions,
       (SELECT count(*)::int FROM payment_accounts) AS accounts,
       (SELECT count(*)::int FROM members) AS members,
       (SELECT count(*)::int FROM services) AS services,
       (SELECT count(*)::int FROM service_types) AS service_types`
  );
  return rows[0];
}

// ===========================================================================
// SEED
// ===========================================================================
async function seed() {
  // The schema first: an existing church database reaches this script without
  // the payment tables on it, and the seed writes sample rows into them. The
  // migration is idempotent and is exactly what a server boot does (db/migrate.js).
  await migrate();

  const existing = await footprint(pool);
  if (existing.accounts.length || existing.typeIds.length) {
    throw new Error('sample giving data is already present: run `npm run purge:giving -- --apply` first');
  }

  const before = await counts(pool);
  const recorder = (await pool.query(
    "SELECT id, name FROM users WHERE is_active = 1 AND role IN ('superadmin','admin','receptionist') ORDER BY CASE role WHEN 'superadmin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, id LIMIT 1"
  )).rows[0];
  if (!recorder) throw new Error('no active user to attribute the sample records to');

  const { rows: categories } = await pool.query('SELECT id, key, name, requires_receipt FROM offering_categories ORDER BY sort_order');
  const category = (key) => categories.find((c) => c.key === key);
  for (const needed of ['zaka', 'thanksgiving', 'general', 'special']) {
    if (!category(needed)) throw new Error(`offering category "${needed}" is missing: run the seeder (npm run seed) first`);
  }

  const { rows: centers } = await pool.query('SELECT id, name FROM revival_centers ORDER BY sort_order, id');
  const { rows: projects } = await pool.query("SELECT id, name FROM projects WHERE status = 'active' ORDER BY id LIMIT 1");

  const nextReceiptNo = receiptAllocator();
  const written = {
    services: 0, offerings: 0, receipts: 0, transactions: 0, duplicates: 0, rejected: 0,
    members: 0, accounts: 0, confirmed: 0, review: 0, unmatched: 0, audits: 0, possibleDuplicates: 0,
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- 1. Service types + the sessions themselves ------------------------
    const serviceTypes = {};
    for (const rhythm of RHYTHMS) {
      const { rows } = await client.query(
        `INSERT INTO service_types (name, key, kind, attendance_mode, sort_order, is_active)
         VALUES ($1, $2, 'service', 'headcount', 900, 0) RETURNING id`,
        [rhythm.name, rhythm.key]
      );
      serviceTypes[rhythm.key] = rows[0].id;
    }

    const dates = calendar();
    const sessionId = {};
    // One session per service date, keyed by the date as well as by the rhythm: a
    // gift confirmed from a payment that arrived on a Sunday belongs to that
    // Sunday's service, whichever rhythm recorded it.
    const sessionByDate = {};
    for (const rhythm of RHYTHMS) {
      const list = rhythm.day === 0 ? dates.sunday : rhythm.day === 3 ? dates.wednesday : dates.friday;
      for (const date of list) {
        const { rows } = await client.query(
          'INSERT INTO services (name, date, time, service_type_id) VALUES ($1, $2, $3, $4) RETURNING id',
          [rhythm.name, date, rhythm.time, serviceTypes[rhythm.key]]
        );
        sessionId[`${rhythm.key}:${date}`] = rows[0].id;
        // The RHYTHMS order (Sunday first) is what makes a Sunday the default
        // session for a date that also has a midweek service.
        if (!sessionByDate[date]) sessionByDate[date] = rows[0].id;
        written.services += 1;
      }
    }

    // ---- 2. Donors: real members where they exist, otherwise sample ones ----
    const donors = [];
    const { rows: existingMembers } = await client.query(
      'SELECT id, name, phone_enc, revival_center_id FROM members WHERE is_active = 1 ORDER BY id LIMIT 12'
    );
    for (const member of existingMembers) {
      donors.push({ id: member.id, name: member.name, centerId: member.revival_center_id, created: false, phoneEnc: member.phone_enc });
    }
    const { rows: maxNo } = await client.query(
      "SELECT MAX(CAST(substr(member_no, 5) AS INTEGER)) AS n FROM members WHERE member_no ~ '^VRT-[0-9]+$'"
    );
    let memberCounter = Number(maxNo[0].n) || 0;
    while (donors.length < 14) {
      const donor = DONORS[donors.length % DONORS.length];
      memberCounter += 1;
      const memberNo = `VRT-${String(memberCounter).padStart(4, '0')}`;
      const phone = `2557${String(10000000 + memberCounter * 137).slice(0, 8)}`;
      const center = centers.length ? centers[memberCounter % centers.length] : null;
      const { rows } = await client.query(
        `INSERT INTO members (member_no, name, phone_enc, gender, revival_center_id, notes, date_joined)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [memberNo, donor.name, encryptField(phone), donor.gender, center ? center.id : null, DEMO_MEMBER_NOTE, `${iso(new Date())}`]
      );
      donors.push({ id: rows[0].id, name: donor.name, memberNo, phone, centerId: center ? center.id : null, created: true });
      written.members += 1;
    }
    // Members that already existed have no member number of their own to quote in
    // a payment reference; the ones created here do (VRT-####), which is what the
    // matching demo needs.

    // ---- 3. Desk giving: cash and the odd hand-written reference ------------
    // One INSERT per session with every line of that day's collection in it: a
    // few hundred single-row inserts would make this script slow enough that
    // nobody would run it.
    const deskLine = async (sessionKey, { categoryKey, amount, donor, paymentMethod, paymentReference, at, notes }) => {
      const cat = category(categoryKey);
      const id = sessionId[sessionKey];
      if (!id) return;
      // Whether the category issues a receipt is the church's own setting (see
      // offering_categories.requires_receipt), exactly as the front desk follows
      // it: the demo does not invent its own rule.
      const wantsReceipt = cat.requires_receipt === 1;
      const receiptNumber = wantsReceipt ? await nextReceiptNo(client, sessionKey.split(':')[1]) : null;
      const token = wantsReceipt ? generateVerificationToken() : null;
      await client.query(
        `INSERT INTO offerings
           (service_id, category_id, type, amount, currency, offerer_name_enc, member_id, revival_center_id,
            receipt_number, recorded_by, verification_token, payment_method, payment_reference, notes, source, timestamp)
         VALUES ($1,$2,$3,$4,'TZS',$5,$6,$7,$8,$9,$10,$11,$12,$13,'manual',$14)`,
        [
          id, cat.id, categoryKey, amount,
          donor && !donor.name.startsWith('Anonymous') ? encryptField(donor.name) : null,
          donor && donor.id ? donor.id : null,
          donor && donor.centerId ? donor.centerId : null,
          receiptNumber, recorder.id, token, paymentMethod || 'cash', paymentReference || null, notes || null,
          `${sessionKey.split(':')[1]} ${at}`,
        ]
      );
      written.offerings += 1;
      if (receiptNumber) written.receipts += 1;
      // Receipts printed for cash gifts must verify, so the Regen/verify demo has
      // real paper behind it: the token is already written above.
      return receiptNumber;
    };

    const today = iso(new Date());
    const sundays = dates.sunday;
    for (const [weekIndex, date] of sundays.entries()) {
      const key = `demo_sunday:${date}`;
      // Loose cash in the general offering: nobody signs for it, and it is the
      // biggest single line on many Sundays.
      const cashLines = 4 + Math.floor(rng() * 4);
      for (let i = 0; i < cashLines; i += 1) {
        await deskLine(key, { categoryKey: 'general', amount: amountBetween(2000, 45000), donor: null, paymentMethod: 'cash', at: '11:15:00' });
      }
      // Weekly tithes from the families who give every week, with amounts that
      // drift a little rather than being identical every Sunday.
      for (const donor of donors.slice(0, 8)) {
        const base = 15000 + (donor.id % 5) * 20000;
        const amount = Math.round((base * between(0.75, 1.6)) / 1000) * 1000;
        const method = rng() < 0.55 ? 'cash' : 'mobile_money';
        await deskLine(key, {
          categoryKey: 'zaka',
          amount,
          donor,
          paymentMethod: method,
          paymentReference: method === 'mobile_money' ? `${pick(MOBILE_WALLETS)}-${String(Math.floor(between(100000, 999999)))}` : null,
          at: '11:20:00',
        });
      }
      // Thanksgiving, and one campaign gift on the first Sunday of the month.
      for (const donor of donors.slice(8, 11)) {
        await deskLine(key, { categoryKey: 'thanksgiving', amount: amountBetween(10000, 120000), donor, paymentMethod: 'cash', at: '11:30:00' });
      }
      const isFirstSundayOfMonth = date.slice(8, 10) <= '07';
      if (isFirstSundayOfMonth) {
        const donor = donors[(weekIndex + 3) % donors.length];
        await deskLine(key, {
          categoryKey: 'special',
          amount: amountBetween(100000, 900000),
          donor,
          paymentMethod: rng() < 0.5 ? 'cheque' : 'mobile_money',
          paymentReference: `CHQ-${String(1000 + written.offerings).slice(0, 4)}`,
          notes: projects[0] ? `Building fund, ${projects[0].name}` : 'Building fund',
          at: '11:40:00',
        });
      }
      // One visible anonymous gift most Sundays: cash in the basket with no name.
      if (rng() < 0.7) {
        await deskLine(key, { categoryKey: 'general', amount: amountBetween(50000, 400000), donor: { name: 'Anonymous donor' }, paymentMethod: 'cash', at: '11:45:00' });
      }
    }

    for (const date of dates.wednesday) {
      const key = `demo_wednesday:${date}`;
      for (let i = 0; i < 2 + Math.floor(rng() * 2); i += 1) {
        await deskLine(key, { categoryKey: 'general', amount: amountBetween(2000, 30000), donor: null, paymentMethod: 'cash', at: '18:00:00' });
      }
      const donor = donors[Math.floor(rng() * donors.length)];
      await deskLine(key, {
        categoryKey: 'thanksgiving', amount: amountBetween(5000, 60000), donor,
        paymentMethod: rng() < 0.5 ? 'mobile_money' : 'cash',
        paymentReference: `TIGO-${String(Math.floor(between(100000, 999999)))}`,
        at: '18:10:00',
      });
    }

    for (const date of dates.friday) {
      const key = `demo_friday:${date}`;
      for (let i = 0; i < 1 + Math.floor(rng() * 2); i += 1) {
        await deskLine(key, { categoryKey: 'general', amount: amountBetween(2000, 25000), donor: null, paymentMethod: 'cash', at: '18:15:00' });
      }
    }

    // ---- 4. The church's two accounts --------------------------------------
    const { rows: bankAccount } = await client.query(
      `INSERT INTO payment_accounts (name, provider, method, account_ref, currency, status, source, created_by)
       VALUES ($1, 'statement_import', 'bank', $2, 'TZS', 'active', 'demo', $3) RETURNING *`,
      [`Sample: CRDB Bank (${ACCOUNT_MARKER})`, `0150${Math.floor(between(100000, 999999))}`, recorder.id]
    );
    const { rows: walletAccount } = await client.query(
      `INSERT INTO payment_accounts (name, provider, method, account_ref, currency, status, credentials_enc, source, created_by)
       VALUES ($1, 'webhook', 'mobile_money', $2, 'TZS', 'active', $3, 'demo', $4) RETURNING *`,
      [`Sample: M-Pesa collection till (${ACCOUNT_MARKER})`, `51${Math.floor(between(100000, 999999))}`, encryptField(JSON.stringify({ webhook_secret: 'whsec_sample_demo_secret' })), recorder.id]
    );
    written.accounts += 2;

    // ---- 5. The bank statement, as an export the church would download ------
    // Written as CSV text and parsed by the real statement reader, so the column
    // aliases, the amount formats and the debit handling are all exercised.
    const bankRows = [];
    const bankDay = (i) => sundays[Math.min(i, sundays.length - 1)];
    // Standing orders come from members the church has a giving code for, and
    // they quote it in the reference, which is how the matcher identifies them
    // without guessing (see utils/paymentIntake.js, rule 1).
    const coded = donors.filter((d) => d.memberNo);
    for (const [i, donor] of coded.entries()) {
      for (const [m, date] of sundays.entries()) {
        if (m % 2 !== i % 2) continue;
        const amount = Math.round(amountBetween(300000, 1800000) / 50000) * 50000;
        bankRows.push({
          date: `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`,
          description: `ZAKA - ${donor.name.toUpperCase()}`,
          reference: `ZAKA/${donor.memberNo}/${date.slice(0, 7)}`,
          credit: amount,
          payer: donor.name,
          phone: donor.phone || '',
          account: `0150${String(100000 + i * 731).slice(0, 6)}`,
          status: 'POSTED',
        });
      }
    }
    // A member who gives by transfer but never quotes a code: the church knows
    // it is them from the date and the amount it is expecting, and the name is a
    // suggestion for a human to confirm, never an automatic attribution.
    const withoutCode = donors.find((d) => !d.memberNo);
    // The company cheque and a member's anniversary gift: no member number, an
    // exact name for one and a name that only LOOKS like a member for the other.
    bankRows.push({
      date: `${bankDay(6).slice(8, 10)}/${bankDay(6).slice(5, 7)}/${bankDay(6).slice(0, 4)}`,
      description: 'BUILDING FUND DONATION - CHEQUE',
      reference: 'CHQ-000248',
      credit: amountBetween(1500000, 4000000),
      payer: NON_MEMBER_DONORS[0],
      phone: '',
      account: `0150${String(778899).slice(0, 6)}`,
      status: 'POSTED',
    });
    bankRows.push({
      date: `${bankDay(2).slice(8, 10)}/${bankDay(2).slice(5, 7)}/${bankDay(2).slice(0, 4)}`,
      description: 'OFFERING - TRANSFER',
      reference: 'TRF/99812',
      credit: 150000,
      payer: withoutCode ? withoutCode.name : 'J. Mwakasege',
      phone: '',
      account: `0150${String(221144).slice(0, 6)}`,
      status: 'POSTED',
    });
    bankRows.push({
      date: `${bankDay(2).slice(8, 10)}/${bankDay(2).slice(5, 7)}/${bankDay(2).slice(0, 4)}`,
      description: 'OFFERING - TRANSFER',
      reference: 'TRF/99855',
      credit: 200000,
      payer: 'J. Mwakasege',           // an initialled name: cannot be attributed to anybody
      phone: '',
      account: `0150${String(221155).slice(0, 6)}`,
      status: 'POSTED',
    });
    bankRows.push({
      date: `${bankDay(3).slice(8, 10)}/${bankDay(3).slice(5, 7)}/${bankDay(3).slice(0, 4)}`,
      description: 'DEPOSIT - NO PAYER DETAILS',
      reference: 'DEP-00231',
      credit: 80000,
      payer: '',
      phone: '',
      account: '',
      status: 'POSTED',
    });
    // Money OUT: the church's own payment. Must be skipped, never counted as a
    // gift, and reported as a debit rather than an error.
    bankRows.push({
      date: `${bankDay(1).slice(8, 10)}/${bankDay(1).slice(5, 7)}/${bankDay(1).slice(0, 4)}`,
      description: 'LUKU ELECTRICITY - CHURCH HALL',
      reference: 'BIL/2026/441',
      credit: '',
      debit: 240000,
      payer: 'TANESCO',
      phone: '',
      account: '',
      status: 'POSTED',
    });
    // A payment the provider took back: not giving, and not confirmable.
    bankRows.push({
      date: `${bankDay(3).slice(8, 10)}/${bankDay(3).slice(5, 7)}/${bankDay(3).slice(0, 4)}`,
      description: 'TRANSFER REVERSED BY SENDER',
      reference: coded[1] ? `ZAKA/${coded[1].memberNo}/${bankDay(3).slice(0, 7)}` : 'TRF/99840',
      credit: 120000,
      payer: coded[1] ? coded[1].name : 'Unknown sender',
      phone: '',
      account: '',
      status: 'REVERSED',
    });

    // A code that DISAGREES with the name on the statement: the reference quotes
    // one donor's giving code and the payer is another donor. A mistyped code
    // looks exactly like this, so the church's own rule refuses to book it and
    // asks a person (match_note = 'code_vs_payer_name'). Deliberate, so the
    // review screen's conflict badge can be seen in the demo, and the amount is
    // fixed rather than drawn from the generator, so adding this row does not
    // shift every later random value in the file.
    const codeOwner = coded[0];
    const otherDonor = coded.find((d) => d !== codeOwner);
    if (codeOwner && otherDonor) {
      bankRows.push({
        date: `${bankDay(5).slice(8, 10)}/${bankDay(5).slice(5, 7)}/${bankDay(5).slice(0, 4)}`,
        description: `ZAKA - ${otherDonor.name.toUpperCase()}`,
        reference: `ZAKA/${codeOwner.memberNo}/${bankDay(5).slice(0, 7)}`,
        credit: 350000,
        payer: otherDonor.name,
        phone: '',
        account: `0150${String(331177).slice(0, 6)}`,
        status: 'POSTED',
      });
    }

    // Numbers are QUOTED, exactly as a real export writes them: '1,250,000' has
    // separators in it, and an unquoted separator is a column break, which is
    // the mistake this export format is famous for, and the reason the parser
    // honours RFC4180 quoting at all.
    const quote = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const statementText = [
      'Transaction Date,Value Date,Description,Reference,Debit,Credit,Payer Name,Payer Phone,Payer Account,Status',
      ...bankRows.map((r) => [
        quote(r.date), quote(r.date), quote(r.description), quote(r.reference),
        quote(r.debit ? money(r.debit) : ''), quote(r.credit ? money(r.credit) : ''),
        quote(r.payer || ''), quote(r.phone || ''), quote(r.account || ''), quote(r.status),
      ].join(',')),
    ].join('\n');

    const bankProvider = getProvider('statement_import');
    const parsedBank = bankProvider.parseStatement(statementText, { account: bankAccount[0] });

    // ---- 6. The mobile-money feed, as provider notifications -----------------
    // Shaped like the common Tanzanian C2B payload, so the alias mapping in
    // utils/paymentProviders.js is what actually reads it.
    const walletPayloads = [];
    let transCounter = 810000;
    // Who the payers are, and how they can be identified, is the whole point of
    // the reconciliation demo: most quote their giving code (as members do), some
    // are known only by the phone the money came from, some give a name the
    // church can suggest but must confirm, and a few are strangers.
    const identified = donors.filter((d) => d.memberNo && d.phone);
    for (const date of [...sundays.slice(-6), ...dates.wednesday.slice(-4)]) {
      const lines = 1 + Math.floor(rng() * 3);
      for (let i = 0; i < lines; i += 1) {
        transCounter += 13;
        const amount = amountBetween(5000, 220000);
        const roll = rng();
        const donor = identified[Math.floor(rng() * identified.length)];
        const byCode = roll < 0.55;
        const byPhone = !byCode && roll < 0.8;
        const byName = !byCode && !byPhone && roll < 0.92;
        // A payer nobody can place: not a member's name, not a member's phone.
        const stranger = STRANGERS[Math.floor(rng() * STRANGERS.length)];
        walletPayloads.push({
          TransID: `MP${transCounter}Z`,
          TransTime: `${date.replace(/-/g, '')}${'093015'}`,
          TransAmount: String(amount),
          BillRefNumber: byCode ? `ZAKA ${donor.memberNo}` : 'OFFERING',
          MSISDN: byCode || byPhone ? donor.phone : (byName ? '' : `2557${String(20000000 + transCounter).slice(0, 8)}`),
          // A name is sent whenever the provider has one, which is exactly how an
          // unattributable payer ends up looking: familiar enough to be worth a
          // human's glance, never enough to be assumed.
          FirstName: byName || byCode || byPhone ? donor.name.split(' ')[0] : stranger.split(' ')[0],
          LastName: byName ? donor.name.split(' ').slice(1).join(' ') : (byCode || byPhone ? '' : stranger.split(' ').slice(1).join(' ')),
          TransactionType: 'Pay Bill',
          status: date === today ? 'pending' : 'successful',
        });
      }
    }
    // Two payments from people the church cannot place at all: one with a
    // a name that matches no member, one with nothing but a phone number.
    walletPayloads.push({
      TransID: `MP${++transCounter}Z`, TransTime: `${sundays[sundays.length - 1].replace(/-/g, '')}101500`,
      TransAmount: '75000', BillRefNumber: 'SADAKA', MSISDN: '255765432109', FirstName: 'Salum', LastName: 'M.', TransactionType: 'Pay Bill', status: 'successful',
    });
    walletPayloads.push({
      TransID: `MP${++transCounter}Z`, TransTime: `${sundays[sundays.length - 1].replace(/-/g, '')}110000`,
      TransAmount: '30000', BillRefNumber: '', MSISDN: '', FirstName: '', LastName: '', TransactionType: 'Pay Bill', status: 'successful',
    });
    // A payment the provider later failed (insufficient funds at settlement).
    walletPayloads.push({
      TransID: `MP${++transCounter}Z`, TransTime: `${sundays[sundays.length - 2].replace(/-/g, '')}113000`,
      TransAmount: '60000', BillRefNumber: 'ZAKA', MSISDN: '255713000111', FirstName: 'Fatuma', LastName: 'A.', TransactionType: 'Pay Bill', status: 'failed',
    });

    const walletProvider = getProvider('webhook');
    const parsedWallet = walletProvider.parseWebhook({ transactions: walletPayloads }, { account: walletAccount[0] });

    // ---- 7. Ingest, dedupe and match through the real pipeline --------------
    const ingestBank = await ingestTransactions(client, {
      account: bankAccount[0], transactions: parsedBank.transactions, source: 'statement',
      userId: recorder.id, importNote: 'sample-statement-export.csv',
    });
    const ingestWallet = await ingestTransactions(client, {
      account: walletAccount[0], transactions: parsedWallet.transactions, source: 'webhook',
      userId: null, importNote: 'webhook',
    });
    // The provider retried one notification (as providers do): the second copy
    // must add nothing at all, which is what makes a re-sync harmless.
    const retried = await ingestTransactions(client, {
      account: walletAccount[0], transactions: [parsedWallet.transactions[0]].filter(Boolean), source: 'webhook',
      userId: null, importNote: 'webhook (retry)',
    });
    written.duplicates += retried.duplicates.length;
    // …and one bank payment arrives a second time under a DIFFERENT provider id
    // (some banks renumber a statement run): recorded, and flagged as a possible
    // duplicate rather than silently counted twice or silently dropped.
    const firstBank = parsedBank.transactions[0];
    if (firstBank) {
      const twin = { ...firstBank, provider_transaction_id: `${firstBank.provider_transaction_id}-R` };
      const twinResult = await ingestTransactions(client, {
        account: bankAccount[0], transactions: [twin], source: 'statement',
        userId: recorder.id, importNote: 'sample-statement-export.csv (re-issued)',
      });
      written.possibleDuplicates = twinResult.inserted.length;
    }

    written.transactions = ingestBank.inserted.length + ingestWallet.inserted.length;
    written.rejected = parsedBank.rejected.length + parsedWallet.rejected.length;

    const bankMatched = await matchPendingTransactions(client, ingestBank.inserted.map((t) => t.id), { userId: recorder.id });
    const walletMatched = await matchPendingTransactions(client, ingestWallet.inserted.map((t) => t.id), { userId: recorder.id });
    const verdicts = [...bankMatched, ...walletMatched];

    // ---- 8. Confirm most matched payments into the ledger -------------------
    // The confirmed ones become giving records with receipts and QR codes; the
    // rest are left for the admin screen, which is the point of the demo (and of
    // the feature: nothing becomes giving without a person deciding).
    const { rows: matchedRows } = await client.query(
      `SELECT * FROM payment_transactions
        WHERE account_id = ANY($1::int[]) AND match_status = 'matched'
        ORDER BY occurred_at DESC, id`,
      [[bankAccount[0].id, walletAccount[0].id]]
    );
    let confirmIndex = 0;
    for (const transaction of matchedRows) {
      confirmIndex += 1;
      // Every fourth one is left unconfirmed so the reconciliation screen has
      // work to show, and so the confirm button can be demonstrated.
      if (confirmIndex % 4 === 0) continue;

      const donor = donors.find((d) => d.id === transaction.matched_member_id) || null;
      const date = transaction.occurred_at.slice(0, 10);
      const session = sessionByDate[date] || null;
      if (!session) continue;

      const categoryKey = transaction.provider_reference && /CHQ/i.test(transaction.provider_reference) ? 'special'
        : transaction.amount >= 300000 ? 'zaka' : 'thanksgiving';
      const cat = category(categoryKey);

      const writtenRow = await insertOffering(client, {
        serviceId: session,
        categoryId: cat.id,
        categoryKey,
        amount: Number(transaction.amount),
        currency: transaction.currency,
        offererName: donor ? donor.name : transaction.payer_name,
        memberId: donor ? donor.id : null,
        centerId: donor ? donor.centerId : null,
        projectId: categoryKey === 'special' && projects[0] ? projects[0].id : null,
        projectName: categoryKey === 'special' && projects[0] ? projects[0].name : null,
        notes: `Imported payment #${transaction.id}`,
        recordedBy: recorder.id,
        receipt: true,
        paymentMethod: transaction.account_id === bankAccount[0].id ? 'bank' : 'mobile_money',
        paymentReference: transaction.provider_reference || transaction.provider_transaction_id,
        source: 'import',
        paymentTransactionId: transaction.id,
        sessionDate: date,
      });
      // The offering is written with the recording time the column defaults to,
      // which for a REAL import genuinely is today (the day the statement was read
      // and the gift confirmed). This demo is three months of history, so the row
      // is dated to the day the money moved: otherwise every imported receipt
      // would say it was recorded today and the whole statement-fed history would
      // pile up in the current month, which is the opposite of what sample data is
      // for. The SERVICE it is filed against is already that day's session, so
      // this only fixes the timestamp the receipt prints.
      await client.query('UPDATE offerings SET timestamp = $1 WHERE id = $2', [
        transaction.occurred_at,
        writtenRow.id,
      ]);
      await client.query(
        `UPDATE payment_transactions
            SET match_status = 'confirmed', offering_id = $1, reconciled_by = $2,
                reconciled_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
          WHERE id = $3`,
        [writtenRow.id, recorder.id, transaction.id]
      );
      await logAudit({
        userId: recorder.id,
        action: 'offering_recorded',
        table: 'offerings',
        recordId: writtenRow.id,
        details: { demo: true, amount: transaction.amount, receipt: writtenRow.receiptNumber, source: 'import', paymentTransactionId: transaction.id },
        ip: '127.0.0.1',
      });
      written.confirmed += 1;
      written.offerings += 1;
      written.receipts += 1;
    }

    written.review = verdicts.filter((v) => v.status === 'review').length;
    written.unmatched = verdicts.filter((v) => v.status === 'unmatched').length;
    written.audits += written.confirmed;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // ---- 9. What to look at -------------------------------------------------
  const after = await footprint(pool);
  const { rows: byMethod } = await pool.query(
    `SELECT o.payment_method AS method, COUNT(*)::int AS gifts, COALESCE(SUM(o.amount), 0) AS total
       FROM offerings o JOIN services s ON s.id = o.service_id
      WHERE s.service_type_id = ANY($1::int[])
      GROUP BY o.payment_method ORDER BY total DESC`,
    [after.typeIds]
  );
  const { rows: byStatus } = await pool.query(
    `SELECT match_status, COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total
       FROM payment_transactions WHERE account_id = ANY($1::int[])
      GROUP BY match_status ORDER BY n DESC`,
    [after.accounts]
  );
  const labels = {
    unmatched: 'Unmatched (nobody to attribute yet)',
    review: 'Requires review (a suggestion, not a decision)',
    matched: 'Matched, awaiting confirmation',
    confirmed: 'Confirmed giving',
    ignored: 'Set aside',
  };

  console.log(`\nTarget      : ${target()}`);
  console.log(`Window      : ${calendar().sunday[0]} .. ${iso(new Date())} (3 complete months + month to date)`);
  console.log(`Recorded by : ${recorder.name} (id ${recorder.id})`);
  console.log(`Tables before: ${JSON.stringify(before)}`);
  console.log(`Written     : ${written.services} services · ${written.offerings} offerings (${written.receipts} with receipts) · ${written.members} sample member(s)`);
  console.log(`Payments    : ${written.transactions} imported across ${written.accounts} accounts · ${written.confirmed} confirmed · ${written.review} awaiting review · ${written.unmatched} unmatched`);
  console.log(`Skipped     : ${written.duplicates} duplicate provider delivery(s) · ${written.rejected} statement row(s) that were not credits`);
  if (written.possibleDuplicates) console.log(`Flagged     : ${written.possibleDuplicates} payment(s) re-issued under a new provider id (possible duplicate)`);
  console.log('\nGiving by method (as the Reports breakdown shows it):');
  for (const row of byMethod) {
    console.log(`  ${String(row.method || 'not recorded').padEnd(14)} ${String(row.gifts).padStart(4)} gifts   ${money(row.total).padStart(14)} TZS`);
  }
  console.log('\nIncoming payments (as the reconciliation screen shows them):');
  for (const row of byStatus) {
    console.log(`  ${(labels[row.match_status] || row.match_status).padEnd(46)} ${String(row.n).padStart(3)}   ${money(row.total).padStart(14)} TZS`);
  }
  console.log('\nTry: Reports → Breakdown by payment method, account and reconciliation · Receipts → open a sample receipt');
  console.log('     Member giving history · Pastor app → Records → "How giving came in" (day and month)');
  console.log(`\nRemove with: npm run purge:giving -- --apply\n`);
}

// ===========================================================================
// PURGE
// ===========================================================================
async function purge() {
  // A database that predates these tables cannot hold sample giving data, so
  // there is nothing to look for, and running the migration here would be a
  // purge with a side effect, which is the wrong way round.
  const { rows: present } = await pool.query("SELECT to_regclass('public.payment_accounts') AS accounts, to_regclass('public.payment_transactions') AS transactions");
  if (!present[0].accounts || !present[0].transactions) {
    console.log('\nNothing to purge: this database predates the payment-account tables.\n');
    return;
  }

  const found = await footprint(pool);

  console.log(`\nTarget : ${target()}`);
  const lines = [
    ['payment_transactions', found.transactions.length, 'payments imported by the sample seeder'],
    ['offerings', found.offerings.length, 'gifts recorded by the sample seeder (receipts included)'],
    ['payment_accounts', found.accounts.length, 'sample church accounts'],
    ['service_types', found.typeIds.length, `sample service types (${found.types.map((t) => t.key).join(', ') || 'none'})`],
    ['services', found.services.length, 'sample service sessions'],
    ['members', found.members.length, 'sample members created by the seeder'],
    ['audit_log', found.audits.length, 'sample audit entries (the chain is re-linked afterwards)'],
  ];
  const total = lines.reduce((sum, [, n]) => sum + n, 0);

  if (!total) {
    console.log('Nothing to purge: no sample giving data found. Real records are never candidates.\n');
    return;
  }

  console.log('\nWould remove:');
  for (const [table, n, note] of lines) console.log(`  ${table.padEnd(22)} ${String(n).padStart(5)}  ${note}`);

  if (!APPLY) {
    console.log('\nDRY RUN: nothing changed. Re-run with `--apply` (or `--force`) to remove it.\n');
    return;
  }

  const client = await pool.connect();
  let removed = {};
  try {
    await client.query('BEGIN');
    // Children before parents, and the two self/foreign references on
    // payment_transactions are cleared first: an offering points at its payment,
    // and a payment points at the entry it became and at the twin it may
    // duplicate: all three would otherwise block the deletes.
    await client.query('UPDATE payment_transactions SET possible_duplicate_of = NULL WHERE account_id = ANY($1::int[])', [found.accounts]);
    await client.query('UPDATE payment_transactions SET offering_id = NULL WHERE account_id = ANY($1::int[])', [found.accounts]);

    const del = async (table, ids) => {
      if (!ids.length) return 0;
      const { rowCount } = await client.query(`DELETE FROM ${table} WHERE id = ANY($1::int[])`, [ids]);
      removed[table] = rowCount;
      return rowCount;
    };

    await del('offerings', found.offerings);
    await del('payment_transactions', found.transactions);
    await del('payment_accounts', found.accounts);
    await del('services', found.services);
    await del('service_types', found.typeIds);
    // A sample member is only removed while nothing else refers to them: if a
    // real gift was ever recorded against one (which the seeder never does), the
    // member stays and is reported, rather than failing the whole purge.
    const { rows: referenced } = await client.query(
      `SELECT DISTINCT member_id AS id FROM offerings WHERE member_id = ANY($1::int[])
       UNION SELECT DISTINCT member_id FROM group_members WHERE member_id = ANY($1::int[])
       UNION SELECT DISTINCT member_id FROM attendance_attendees WHERE member_id = ANY($1::int[])
       UNION SELECT DISTINCT member_id FROM project_pledges WHERE member_id = ANY($1::int[])
       UNION SELECT DISTINCT member_id FROM center_zone_leaders WHERE member_id = ANY($1::int[])
       UNION SELECT DISTINCT matched_member_id FROM payment_transactions WHERE matched_member_id = ANY($1::int[])
       UNION SELECT DISTINCT suggested_member_id FROM payment_transactions WHERE suggested_member_id = ANY($1::int[])`,
      [found.members]
    );
    const inUse = new Set(referenced.map((r) => r.id));
    const removable = found.members.filter((id) => !inUse.has(id));
    removed['members'] = await del('members', removable);
    if (inUse.size) console.log(`  kept ${inUse.size} sample member(s) that real records now refer to`);

    if (found.audits.length) {
      const { rowCount } = await client.query('DELETE FROM audit_log WHERE id = ANY($1::int[])', [found.audits]);
      removed['audit_log'] = rowCount;
    }

    // Removing entries mid-chain would leave the survivors pointing at hashes
    // that no longer exist, which makes the tamper-evident log report itself as
    // broken. Re-link what is left, in the same transaction.
    const chain = await rebuildChain(client);
    await client.query('COMMIT');
    console.log(`\nAudit chain : ${chain.rows} entr(ies) kept, ${chain.changed} re-hashed`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Proof rather than confidence: ask the structural markers again.
  const left = await footprint(pool);
  const remaining = left.types.length + left.services.length + left.offerings.length + left.accounts.length + left.transactions.length + left.members.length + left.audits.length;
  const after = await counts(pool);

  console.log('\nRemoved:');
  for (const [table, n] of Object.entries(removed)) console.log(`  ${table.padEnd(22)} ${String(n).padStart(5)}`);
  console.log(`\nRemaining sample rows: ${remaining}`);
  console.log(`Tables now: ${JSON.stringify(after)}`);
  console.log(remaining ? 'WARNING: sample rows still match the markers, look before trusting this database.\n'
    : 'Clean: no sample row matches the markers any more.\n');
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to run: NODE_ENV=production (this writes sample data and deletes records)');
  }
  if (MODE === 'seed') return seed();
  if (MODE === 'purge') return purge();
  console.log('Usage: node scripts/sample-giving.js seed | purge [--apply|--force]');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Failed:', err.message);
    return pool.end().finally(() => process.exit(1));
  });
