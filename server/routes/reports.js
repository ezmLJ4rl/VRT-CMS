const express = require('express');
const { Parser } = require('json2csv');
const pool = require('../db/pg');
const { toParams } = require('../utils/sqlParams');
const { authenticate, requireRole } = require('../middleware/auth');
const { readDonorField } = require('../utils/donorFields');
const { verifyChain, hashEntry } = require('../utils/audit');
const { todayISO, TIMEZONE } = require('../utils/date');

const router = express.Router();
router.use(authenticate);

// CSV cell for a giver: the decrypted name, or an explicit marker when the
// stored ciphertext will not decrypt. Anonymous gifts stay blank: they are a
// different thing from a name the export could not read.
function giverName(row) {
  const { value, unreadable } = readDonorField(row.offerer_name_enc, { table: 'offerings', id: row.id, field: 'offerer_name_enc' });
  return value || (unreadable ? 'UNAVAILABLE' : '');
}

// Effective headcount of an attendance row (mirrors the POST-time finalCount rule).
const HEADCOUNT = `
  CASE
    WHEN a.mode = 'both' THEN
      CASE WHEN COALESCE(a.count, 0) > 0 THEN a.count
           ELSE COALESCE((SELECT COUNT(*) FROM attendance_attendees aa WHERE aa.attendance_id = a.id), 0) END
    WHEN a.mode = 'named' THEN
      COALESCE((SELECT COUNT(*) FROM attendance_attendees aa WHERE aa.attendance_id = a.id), 0)
    ELSE COALESCE(a.count, 0)
  END
`;

// Attendance belongs to one side of the service/rehearsal split. Every ATTENDANCE
// aggregate is scoped to real services so a rehearsal can never inflate the
// church's service figures; rehearsals are reported on their own (see
// groupBy=rehearsal and the `rehearsals` block below).
//
// Offering aggregates are deliberately NOT scoped this way: money that was
// recorded must keep appearing in the reports, wherever it was filed.
const SERVICE_KIND = `s.service_type_id IN (SELECT id FROM service_types WHERE kind = 'service')`;
const REHEARSAL_KIND = `s.service_type_id IN (SELECT id FROM service_types WHERE kind = 'rehearsal')`;

/**
 * Per-service-type attendance for one side of the split. Rehearsal rows carry no
 * offering columns at all: there is never money against a rehearsal, so summing
 * an offering column for them would be reporting a figure that cannot exist.
 */
async function attendanceByServiceType(user, q, kind) {
  const scope = (alias) => {
    let snip = 's.service_type_id = st.id';
    const vals = [];
    snip += ` AND ${alias}.voided_at IS NULL`;
    if (user.role === 'receptionist') {
      snip += ' AND s.date = ?';
      vals.push(todayISO());
      snip += ` AND ${alias}.recorded_by = ?`;
      vals.push(user.id);
    } else {
      if (q.from) { snip += ' AND s.date >= ?'; vals.push(q.from); }
      if (q.to) { snip += ' AND s.date <= ?'; vals.push(q.to); }
    }
    return { snip, vals };
  };

  const att = scope('a');
  const withMoney = kind === 'service';
  const off = withMoney ? scope('o') : null;
  const moneyColumns = withMoney
    ? `,
                (SELECT COUNT(*) FROM offerings o JOIN services s ON s.id = o.service_id
                 WHERE ${off.snip}) AS gifts,
                (SELECT COALESCE(SUM(o.amount), 0) FROM offerings o JOIN services s ON s.id = o.service_id
                 WHERE ${off.snip}) AS offering`
    : '';

  const sql = toParams(
    `SELECT st.id AS key, st.name AS label, st.attendance_mode AS mode, st.kind AS kind,
            (SELECT COALESCE(SUM(${HEADCOUNT}), 0) FROM attendance a JOIN services s ON s.id = a.service_id
             WHERE ${att.snip}) AS attendance,
            (SELECT COUNT(*) FROM attendance a JOIN services s ON s.id = a.service_id
             WHERE ${att.snip}) AS sessions${moneyColumns}
     FROM service_types st
     WHERE st.kind = ?
     ORDER BY st.sort_order, st.name`
  );
  const values = withMoney
    ? [...att.vals, ...att.vals, ...off.vals, ...off.vals, kind]
    : [...att.vals, ...att.vals, kind];

  const { rows } = await pool.query(sql, values);
  return rows;
}

/**
 * Receptionists may only view reports for today's date and their own records.
 * Everyone else gets the requested from/to range.
 */
function period(user, q, recordAlias) {
  const clauses = [`${recordAlias}.voided_at IS NULL`];
  const params = [];
  if (user.role === 'receptionist') {
    clauses.push('s.date = ?');
    params.push(todayISO());
    clauses.push(`${recordAlias}.recorded_by = ?`);
    params.push(user.id);
  } else {
    if (q.from) { clauses.push('s.date >= ?'); params.push(q.from); }
    if (q.to) { clauses.push('s.date <= ?'); params.push(q.to); }
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

// GET /api/reports/offerings.csv?from=&to=
router.get('/offerings.csv', async (req, res) => {
  try {
    const scope = period(req.user, req.query, 'o');      const sql = toParams(
      `SELECT o.id, s.name AS service, s.date, COALESCE(oc.key, o.type) AS type, o.amount, o.currency,
              o.payment_method, o.payment_reference, o.source,
              pa.name AS account, pt.provider_reference, pt.match_status AS reconciliation_status,
              o.offerer_name_enc, o.reason, o.project_name, u.name AS recorded_by, o.timestamp
       FROM offerings o
       JOIN services s ON s.id = o.service_id
       JOIN users u ON u.id = o.recorded_by
       LEFT JOIN offering_categories oc ON oc.id = o.category_id
       LEFT JOIN payment_transactions pt ON pt.id = o.payment_transaction_id
       LEFT JOIN payment_accounts pa ON pa.id = pt.account_id
       ${scope.where} ORDER BY s.date DESC`
    );
    const { rows } = await pool.query(sql, scope.params);

    const data = rows.map((r) => ({
      id: r.id,
      service: r.service,
      date: r.date,
      type: r.type,
      amount: r.amount,
      currency: r.currency,
      // The stored key, not a label: a spreadsheet has no interface language,
      // and a treasurer pivoting on "mobile_money" must get the same value
      // whichever language the app was open in (attendance.csv exports `mode`
      // the same way). Blank = not recorded, which is a real and common state.
      payment_method: r.payment_method || '',
      payment_reference: r.payment_reference || '',
      // How the gift was recorded (desk / imported) and which church account the
      // money landed in. Same rule as the method above: stored keys, not labels,
      // because a spreadsheet has no interface language.
      source: r.source || 'manual',
      account: r.account || '',
      provider_reference: r.provider_reference || '',
      reconciliation_status: r.reconciliation_status || '',
      // A name that will not decrypt is marked, not blanked: a spreadsheet that
      // silently loses donor names is worse than one that flags them.
      giver_name: giverName(r),
      reason: r.reason || '',
      project: r.project_name || '',
      recorded_by: r.recorded_by,
      timestamp: r.timestamp,
    }));

    const parser = new Parser({ fields: ['id', 'service', 'date', 'type', 'amount', 'currency', 'payment_method', 'payment_reference', 'source', 'account', 'provider_reference', 'reconciliation_status', 'giver_name', 'reason', 'project', 'recorded_by', 'timestamp'] });
    const csv = parser.parse(data);
    res.header('Content-Type', 'text/csv');
    res.attachment(`offerings_${req.query.from || 'all'}_${req.query.to || 'all'}.csv`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedExportOfferings' });
  }
});

// GET /api/reports/attendance.csv?from=&to=
router.get('/attendance.csv', async (req, res) => {
  try {
    // Attendance exports one side of the split at a time, so a service export can
    // never quietly include rehearsal attendance. Rehearsals are attendance only,
    // so their export carries a headcount and the names.
    const kind = req.query.kind === 'rehearsal' ? 'rehearsal' : 'service';
    const scope = period(req.user, req.query, 'a');
    const sql = toParams(
      `SELECT a.id, a.count, a.mode, s.name AS service, s.date, u.name AS recorded_by, a.timestamp
       FROM attendance a JOIN services s ON s.id = a.service_id JOIN users u ON u.id = a.recorded_by
       ${scope.where} AND s.service_type_id IN (SELECT id FROM service_types WHERE kind = ?)
       ORDER BY s.date DESC`
    );
    const { rows } = await pool.query(sql, [...scope.params, kind]);

    const ids = rows.map((r) => r.id);
    if (ids.length) {
      // Dynamic IN (...): numbered placeholders built directly for pg.
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows: attendees } = await pool.query(
        `SELECT attendance_id, name FROM attendance_attendees WHERE attendance_id IN (${ph}) ORDER BY id`,
        ids
      );
      const byRow = {};
      for (const x of attendees) (byRow[x.attendance_id] = byRow[x.attendance_id] || []).push(x.name);
      for (const r of rows) r.names = (byRow[r.id] || []).join('; ');
    }

    const parser = new Parser({ fields: ['id', 'service', 'date', 'count', 'mode', 'names', 'recorded_by', 'timestamp'] });
    const csv = parser.parse(rows);
    res.header('Content-Type', 'text/csv');
    res.attachment(`attendance_${kind}_${req.query.from || 'all'}_${req.query.to || 'all'}.csv`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedExportAttendance' });
  }
});

// GET /api/reports/audit-integrity: superadmin/admin can verify the tamper-evident chain
router.get('/audit-integrity', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    res.json(await verifyChain());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedVerifyAuditChain' });
  }
});

/**
 * GET /api/reports/audit/verify?date=YYYY-MM-DD: verify ONE day's slice of the
 * audit chain.
 *
 * This is the daily, administrative counterpart of the receipt QR code, and the
 * two are deliberately kept apart: a member's receipt QR verifies that receipt
 * (`/verify/receipt/:token`), while this verifies that a day's records still add
 * up, admin-only, under the admin app's own screen. Pointing a printed QR code
 * at a day's chain would let anybody with one receipt read whether the church's
 * books had been altered, and would answer the wrong question for a member, who
 * needs to know about their own gift.
 *
 * Verifying a slice has three parts, and all three are necessary:
 *   1. every entry in the day hashes to what it claims (recomputed here from the
 *      fields, exactly as logAudit wrote them);
 *   2. the day's first entry chains onto the entry before it, so deleting the
 *      first entries of a day is caught;
 *   3. the next entry AFTER the day chains onto the day's last entry, so
 *      deleting the last entries is caught too, which a day-limited walk on its
 *      own would not notice.
 *
 * The day's live offering ledger is returned alongside, because the point of the
 * check is the money: an admin verifying a day wants the figures the entries are
 * about on the same screen as the verdict about them.
 */
router.get('/audit/verify', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const date = String(req.query.date || todayISO()).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'errors.dateYyyyMmDdFormat' });
    }

    // The audit log stamps entries with a UTC instant, so the day is resolved in
    // the church's own timezone: the same one every date in the app uses, and
    // the reason a 22:00 service belongs to the day the church was open, not to
    // the next UTC day.
    const { rows } = await pool.query(
      `SELECT id, user_id, action, table_affected, record_id, details, ip_address, timestamp, prev_hash, hash
         FROM audit_log
        WHERE (timestamp::timestamptz AT TIME ZONE $1)::date = $2::date
        ORDER BY id ASC`,
      [TIMEZONE, date]
    );

    // 2. What the day's first entry must chain onto.
    let anchorHash = 'GENESIS';
    let anchored = false;
    if (rows.length) {
      const { rows: prior } = await pool.query(
        'SELECT hash FROM audit_log WHERE id < $1 ORDER BY id DESC LIMIT 1',
        [rows[0].id]
      );
      if (prior[0]) {
        anchorHash = prior[0].hash;
        anchored = true;
      }
    }

    // 1. The walk itself.
    let expectedPrev = anchorHash;
    let valid = true;
    let brokenAtId = null;
    for (const row of rows) {
      const recomputed = hashEntry({
        userId: row.user_id,
        action: row.action,
        table: row.table_affected,
        recordId: row.record_id,
        details: row.details ? JSON.parse(row.details) : null,
        ip: row.ip_address,
        timestamp: row.timestamp,
        prevHash: expectedPrev,
      });
      if (row.prev_hash !== expectedPrev || row.hash !== recomputed) {
        valid = false;
        brokenAtId = row.id;
        break;
      }
      expectedPrev = row.hash;
    }

    // 3. The hand-off to the next entry after the day (nothing follows = nothing
    //    to check, which is honest for the newest day of all).
    let linkedToNext = true;
    if (valid && rows.length) {
      const { rows: next } = await pool.query(
        'SELECT id, prev_hash FROM audit_log WHERE id > $1 ORDER BY id ASC LIMIT 1',
        [rows[rows.length - 1].id]
      );
      if (next[0]) linkedToNext = next[0].prev_hash === expectedPrev;
    }

    const byAction = {};
    for (const row of rows) byAction[row.action] = (byAction[row.action] || 0) + 1;

    // Money is attributed to the day by SERVICE date (what the receipt and every
    // report show), and voided entries are counted apart so "total" is the live
    // ledger figure rather than one inflated by mistakes. `services.date` is a
    // text column, so it is compared as text: a `::date` cast would make this
    // `text = date`, which Postgres has no operator for.
    const { rows: byCurrency } = await pool.query(
      `SELECT o.currency, COUNT(*)::int AS count, COALESCE(SUM(o.amount), 0) AS total
         FROM offerings o JOIN services s ON s.id = o.service_id
        WHERE s.date = $1 AND o.voided_at IS NULL
        GROUP BY o.currency ORDER BY o.currency`,
      [date]
    );
    const { rows: voidedRows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM offerings o JOIN services s ON s.id = o.service_id
        WHERE s.date = $1 AND o.voided_at IS NOT NULL`,
      [date]
    );

    res.json({
      date,
      timezone: TIMEZONE,
      valid: valid && linkedToNext,
      chainValid: valid,
      brokenAtId,
      linkedToNext,
      anchored,
      entries: rows.length,
      firstEntryId: rows.length ? rows[0].id : null,
      lastEntryId: rows.length ? rows[rows.length - 1].id : null,
      byAction,
      offerings: { byCurrency, voided: voidedRows[0]?.count || 0 },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedVerifyDailyAuditChain' });
  }
});

// GET /api/reports/summary?from=&to=: headline totals for the period.
router.get('/summary', async (req, res) => {
  try {
    const attScope = period(req.user, req.query, 'a');
    const offScope = period(req.user, req.query, 'o');
    const { rows: attendanceRows } = await pool.query(
      toParams(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(${HEADCOUNT}), 0) AS people, COUNT(DISTINCT s.service_type_id) AS service_types FROM attendance a JOIN services s ON s.id = a.service_id ${attScope.where} AND ${SERVICE_KIND}`
      ),
      attScope.params
    );
    // Rehearsals are reported next to the service totals, never inside them.
    const { rows: rehearsalRows } = await pool.query(
      toParams(
        `SELECT COUNT(*) AS sessions, COALESCE(SUM(${HEADCOUNT}), 0) AS people FROM attendance a JOIN services s ON s.id = a.service_id ${attScope.where} AND ${REHEARSAL_KIND}`
      ),
      attScope.params
    );
    const { rows: offeringRows } = await pool.query(
      toParams(`SELECT COUNT(*) AS gifts, COALESCE(SUM(o.amount), 0) AS total FROM offerings o JOIN services s ON s.id = o.service_id ${offScope.where}`),
      offScope.params
    );
    res.json({ attendance: attendanceRows[0], rehearsals: rehearsalRows[0], offerings: offeringRows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadReportSummary' });
  }
});

// GET /api/reports/breakdown?from=&to=&groupBy=service|center|group|category|day
router.get('/breakdown', async (req, res) => {
  try {
    const { groupBy } = req.query;

    if (groupBy === 'service') {
      // Services carry the money columns; rehearsals come back alongside them in
      // their own list so a client can show them as a separate table.
      const [breakdown, rehearsals] = await Promise.all([
        attendanceByServiceType(req.user, req.query, 'service'),
        attendanceByServiceType(req.user, req.query, 'rehearsal'),
      ]);
      return res.json({ breakdown, rehearsals });
    }

    // The rehearsal view: attendance only, for the types the church practises in.
    if (groupBy === 'rehearsal') {
      return res.json({ breakdown: await attendanceByServiceType(req.user, req.query, 'rehearsal') });
    }

    if (groupBy === 'center') {
      const attendScope = period(req.user, req.query, 'a');
      const { rows: attendRows } = await pool.query(
        toParams(
          `SELECT rc.id AS key, rc.name AS label, COUNT(*) AS sessions, COALESCE(SUM(${HEADCOUNT}), 0) AS attendance
           FROM attendance a JOIN services s ON s.id = a.service_id
           LEFT JOIN revival_centers rc ON rc.id = a.revival_center_id ${attendScope.where} AND ${SERVICE_KIND}
           GROUP BY rc.id, rc.name ORDER BY attendance DESC`
        ),
        attendScope.params
      );
      const offScope = period(req.user, req.query, 'o');
      const { rows: offerRows } = await pool.query(
        toParams(
          `SELECT rc.id AS key, rc.name AS label, COUNT(*) AS gifts, COALESCE(SUM(o.amount), 0) AS offering
           FROM offerings o JOIN services s ON s.id = o.service_id
           LEFT JOIN members m ON m.id = o.member_id
           LEFT JOIN revival_centers rc ON rc.id = m.revival_center_id ${offScope.where}
           GROUP BY rc.id, rc.name ORDER BY offering DESC`
        ),
        offScope.params
      );
      const keyed = {};
      for (const r of [...attendRows, ...offerRows]) {
        keyed[r.key] = { key: r.key, label: r.label, sessions: (keyed[r.key]?.sessions || 0) + (r.sessions || 0), attendance: (keyed[r.key]?.attendance || 0) + (r.attendance || 0), gifts: (keyed[r.key]?.gifts || 0) + (r.gifts || 0), offering: (keyed[r.key]?.offering || 0) + (r.offering || 0) };
      }
      return res.json({ breakdown: Object.values(keyed).sort((a, b) => b.attendance - a.attendance) });
    }

    if (groupBy === 'group') {
      const attendScope = period(req.user, req.query, 'a');
      const { rows: attendRows } = await pool.query(
        toParams(
          `SELECT g.id AS key, g.name AS label, COUNT(*) AS sessions, COALESCE(SUM(${HEADCOUNT}), 0) AS attendance
           FROM attendance a JOIN services s ON s.id = a.service_id
           LEFT JOIN "groups" g ON g.id = a.group_id ${attendScope.where} AND ${SERVICE_KIND}
           GROUP BY g.id, g.name ORDER BY attendance DESC`
        ),
        attendScope.params
      );
      const offScope = period(req.user, req.query, 'o');
      const { rows: offerRows } = await pool.query(
        toParams(
          `SELECT g.id AS key, g.name AS label, COUNT(*) AS gifts, COALESCE(SUM(o.amount), 0) AS offering
           FROM offerings o JOIN services s ON s.id = o.service_id
           LEFT JOIN group_members gm ON gm.member_id = o.member_id
           LEFT JOIN "groups" g ON g.id = gm.group_id ${offScope.where}
           GROUP BY g.id, g.name ORDER BY offering DESC`
        ),
        offScope.params
      );
      const keyed = {};
      for (const r of [...attendRows, ...offerRows]) {
        keyed[r.key] = { key: r.key, label: r.label, sessions: (keyed[r.key]?.sessions || 0) + (r.sessions || 0), attendance: (keyed[r.key]?.attendance || 0) + (r.attendance || 0), gifts: (keyed[r.key]?.gifts || 0) + (r.gifts || 0), offering: (keyed[r.key]?.offering || 0) + (r.offering || 0) };
      }
      return res.json({ breakdown: Object.values(keyed).sort((a, b) => b.attendance - a.attendance) });
    }

    if (groupBy === 'category') {
      const offScope = period(req.user, req.query, 'o');
      const { rows: breakdown } = await pool.query(
        toParams(
          `SELECT COALESCE(oc.key, o.type) AS key, COALESCE(oc.name, o.type) AS label, COUNT(*) AS gifts, COALESCE(SUM(o.amount), 0) AS amount
           FROM offerings o JOIN services s ON s.id = o.service_id
           LEFT JOIN offering_categories oc ON oc.id = o.category_id ${offScope.where}
           GROUP BY COALESCE(oc.key, o.type), COALESCE(oc.name, o.type) ORDER BY amount DESC`
        ),
        offScope.params
      );
      return res.json({ breakdown });
    }

    // How the money came in: the one breakdown a treasurer cannot get from the
    // others, because the method is the same across every category and service.
    // NULL is a bucket of its own, named honestly by the client: an offering
    // recorded before this existed, or one where the desk left it blank.
    if (groupBy === 'payment') {
      const offScope = period(req.user, req.query, 'o');
      const { rows: breakdown } = await pool.query(
        toParams(
          `SELECT o.payment_method AS key, COUNT(*) AS gifts, COALESCE(SUM(o.amount), 0) AS amount
           FROM offerings o JOIN services s ON s.id = o.service_id ${offScope.where}
           GROUP BY o.payment_method ORDER BY amount DESC`
        ),
        offScope.params
      );
      return res.json({ breakdown });
    }

    // Which church ACCOUNT the money arrived in. Only confirmed imported gifts
    // have one, so the NULL bucket is not an oversight: it is everything the
    // desk counted by hand (cash) or recorded before an account was connected,
    // named honestly by the client rather than folded into a real account. This
    // is the breakdown the financial administrators asked for, "how much came
    // through the CRDB account, how much through the M-Pesa till", and it is
    // admin-only for the same reason the accounts screen is: it is the church's
    // banking detail, not general reporting.
    if (groupBy === 'account') {
      if (!['admin', 'superadmin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'errors.reconciliationAdminOnly' });
      }
      const offScope = period(req.user, req.query, 'o');
      const { rows: breakdown } = await pool.query(
        toParams(
          `SELECT pa.id AS key, pa.name AS label, pa.provider, pa.currency AS account_currency,
                  COUNT(*) AS gifts, COALESCE(SUM(o.amount), 0) AS amount
           FROM offerings o JOIN services s ON s.id = o.service_id
           LEFT JOIN payment_transactions pt ON pt.id = o.payment_transaction_id
           LEFT JOIN payment_accounts pa ON pa.id = pt.account_id
           ${offScope.where}
           GROUP BY pa.id, pa.name, pa.provider, pa.currency ORDER BY amount DESC`
        ),
        offScope.params
      );
      return res.json({ breakdown });
    }

    // The RECONCILIATION view: not the ledger but the payment feed behind it.
    // The rows come from payment_transactions and are the church's own verdicts
    // on money that arrived (matched, awaiting review, unmatched, ignored) plus
    // whatever the provider said about it (pending, reversed, failed).
    //
    // It deliberately does not come from offerings: a question like "how much
    // arrived but is still unexplained?" has no answer in the ledger at all,
    // because unexplained money was never written to the ledger. Dates here are
    // the PROVIDER's dates (when the money actually moved), not service dates,
    // and the total is only ever compared against itself, never added to the
    // offering total, which would double-count every confirmed gift.
    if (groupBy === 'reconciliation') {
      if (!['admin', 'superadmin'].includes(req.user.role)) {
        return res.status(403).json({ error: 'errors.reconciliationAdminOnly' });
      }
      const clauses = ['TRUE'];
      const params = [];
      if (req.query.from) { clauses.push('pt.occurred_at >= ?'); params.push(`${req.query.from} 00:00:00`); }
      if (req.query.to) { clauses.push('pt.occurred_at <= ?'); params.push(`${req.query.to} 23:59:59`); }
      if (req.query.accountId) { clauses.push('pt.account_id = ?'); params.push(req.query.accountId); }
      if (req.query.status) { clauses.push('pt.status = ?'); params.push(req.query.status); }
      const { rows: byMatch } = await pool.query(
        toParams(
          `SELECT pt.match_status AS key, COUNT(*) AS payments, COALESCE(SUM(pt.amount), 0) AS amount
             FROM payment_transactions pt
            WHERE ${clauses.join(' AND ')}
            GROUP BY pt.match_status ORDER BY amount DESC`
        ),
        params
      );
      const { rows: byProviderStatus } = await pool.query(
        toParams(
          `SELECT pt.status AS key, COUNT(*) AS payments, COALESCE(SUM(pt.amount), 0) AS amount
             FROM payment_transactions pt
            WHERE ${clauses.join(' AND ')}
            GROUP BY pt.status ORDER BY amount DESC`
        ),
        params
      );
      // `gifts` is the same number under the key the other breakdowns use, so a
      // client can render this with the table it already has.
      const shape = (rows) => rows.map((r) => ({ key: r.key, label: r.key, gifts: Number(r.payments), amount: r.amount }));
      return res.json({ breakdown: shape(byMatch), providerStatus: shape(byProviderStatus), unit: 'payments' });
    }

    if (groupBy === 'day') {
      const attendScope = period(req.user, req.query, 'a');
      const { rows: attendRows } = await pool.query(
        toParams(
          `SELECT s.date AS key, s.date AS label, COUNT(*) AS sessions, COALESCE(SUM(${HEADCOUNT}), 0) AS attendance
           FROM attendance a JOIN services s ON s.id = a.service_id ${attendScope.where} AND ${SERVICE_KIND}
           GROUP BY s.date ORDER BY s.date`
        ),
        attendScope.params
      );
      const offScope = period(req.user, req.query, 'o');
      const { rows: offerRows } = await pool.query(
        toParams(
          `SELECT s.date AS key, s.date AS label, COUNT(*) AS gifts, COALESCE(SUM(o.amount), 0) AS offering
           FROM offerings o JOIN services s ON s.id = o.service_id ${offScope.where}
           GROUP BY s.date ORDER BY s.date`
        ),
        offScope.params
      );
      const keyed = {};
      for (const r of [...attendRows, ...offerRows]) keyed[r.key] = { key: r.key, label: r.label, sessions: (keyed[r.key]?.sessions || 0) + (r.sessions || 0), attendance: (keyed[r.key]?.attendance || 0) + (r.attendance || 0), gifts: (keyed[r.key]?.gifts || 0) + (r.gifts || 0), offering: (keyed[r.key]?.offering || 0) + (r.offering || 0) };
      return res.json({ breakdown: Object.values(keyed).sort((a, b) => a.key.localeCompare(b.key)) });
    }

    return res.status(400).json({ error: 'errors.invalidGroupBy' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadBreakdown' });
  }
});

/**
 * The last `count` COMPLETE months, oldest first, as 'YYYY-MM' keys.
 *
 * The month in progress is deliberately left out. On the 3rd of a month a center
 * has not declined: it simply has not had three weeks yet, and comparing a part
 * month against whole ones reports a fall that is only an artefact of today's
 * date. Trends are also why the window is anchored here in UTC arithmetic rather
 * than in SQL: every request for the same month must see the same buckets.
 */
function completeMonths(count, today = todayISO()) {
  const [year, month] = today.split('-').map(Number);
  const keys = [];
  for (let back = 1; back <= count; back += 1) {
    const d = new Date(Date.UTC(year, month - 1 - back, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys.reverse();
}

/** First day of the month after `key` ('2026-08' -> '2026-09-01'). */
function monthAfter(key) {
  const [year, month] = key.split('-').map(Number);
  const d = new Date(Date.UTC(year, month, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// GET /api/reports/center-trends?months=6, how each center is moving: monthly
// attendance and giving across the last complete months.
//
// Every center comes back in one response so a list of centers costs one request
// rather than one per row, and each series is zero-filled, for months with no
// records, and for a whole center with no records at all. A center that stopped
// meeting must read as a fall to zero, not as a gap the chart draws a line
// straight across. Months are keyed by the same service-date buckets the
// attendance trends use, and attendance is scoped to services (rehearsals are
// reported separately), so these figures agree with the Reports page's "By
// revival center" table.
//
// Admin-only: a receptionist's reporting scope is today's own records, which
// would render every month of this window as an empty series that looks like a
// dead center rather than an unreadable one.
router.get('/center-trends', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const months = Math.min(Math.max(Number(req.query.months) || 6, 2), 24);
    const keys = completeMonths(months);
    const from = `${keys[0]}-01`;
    const until = monthAfter(keys[keys.length - 1]);
    const window = 's.date >= ? AND s.date < ?';

    const { rows: attendRows } = await pool.query(
      toParams(
        `SELECT rc.id AS key, to_char(s.date::date, 'YYYY-MM') AS period, COALESCE(SUM(${HEADCOUNT}), 0) AS attendance
         FROM attendance a
         JOIN services s ON s.id = a.service_id
         LEFT JOIN revival_centers rc ON rc.id = a.revival_center_id
         WHERE a.voided_at IS NULL AND ${SERVICE_KIND} AND ${window}
         GROUP BY rc.id, period`
      ),
      [from, until]
    );

    // Money is attributed to a center through the member who gave it, exactly as
    // the center breakdown does: a gift keeps counting wherever its service was
    // filed. Gifts with no member (anonymous) or no center land in a null bucket
    // that no row on the centers page can show, so they are left out here.
    const { rows: offerRows } = await pool.query(
      toParams(
        `SELECT rc.id AS key, to_char(s.date::date, 'YYYY-MM') AS period, COALESCE(SUM(o.amount), 0) AS offering
         FROM offerings o
         JOIN services s ON s.id = o.service_id
         LEFT JOIN members m ON m.id = o.member_id
         LEFT JOIN revival_centers rc ON rc.id = m.revival_center_id
         WHERE o.voided_at IS NULL AND ${window}
         GROUP BY rc.id, period`
      ),
      [from, until]
    );

    // Seeded from the centers themselves, so a center with nothing recorded is
    // still named in the response with an honest all-zero series.
    const { rows: centerRows } = await pool.query('SELECT id FROM revival_centers ORDER BY sort_order, id');
    const index = new Map(keys.map((k, i) => [k, i]));
    const byCenter = new Map(
      centerRows.map((c) => [c.id, { key: c.id, attendance: keys.map(() => 0), offering: keys.map(() => 0) }])
    );
    function seriesFor(key) {
      if (key == null) return null;
      if (!byCenter.has(key)) {
        byCenter.set(key, { key, attendance: keys.map(() => 0), offering: keys.map(() => 0) });
      }
      return byCenter.get(key);
    }

    for (const row of attendRows) {
      const series = seriesFor(row.key);
      const i = index.get(row.period);
      if (series && i !== undefined) series.attendance[i] = row.attendance;
    }
    for (const row of offerRows) {
      const series = seriesFor(row.key);
      const i = index.get(row.period);
      if (series && i !== undefined) series.offering[i] = row.offering;
    }

    res.json({ months: keys, centers: [...byCenter.values()] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadCenterTrends' });
  }
});

// GET /api/reports/service-trends?from=&to=: daily attendance and giving trends
// for every service type, kept together so the client can render one simple
// time-based graph per service rather than two crowded aggregate bar charts.
router.get('/service-trends', async (req, res) => {
  try {
    const scope = (alias) => {
      const clauses = [`${alias}.voided_at IS NULL`, "st.kind = 'service'"];
      const params = [];
      if (req.user.role === 'receptionist') {
        clauses.push('s.date = ?', `${alias}.recorded_by = ?`);
        params.push(todayISO(), req.user.id);
      } else {
        if (req.query.from) { clauses.push('s.date >= ?'); params.push(req.query.from); }
        if (req.query.to) { clauses.push('s.date <= ?'); params.push(req.query.to); }
      }
      return { where: clauses.join(' AND '), params };
    };

    const attScope = scope('a');
    const { rows: attendance } = await pool.query(
      toParams(
        `SELECT st.id AS key, st.name AS label, s.date AS period,
                COALESCE(SUM(${HEADCOUNT}), 0) AS attendance
           FROM attendance a
           JOIN services s ON s.id = a.service_id
           JOIN service_types st ON st.id = s.service_type_id
          WHERE ${attScope.where}
          GROUP BY st.id, st.name, s.date
          ORDER BY st.sort_order, st.name, s.date`
      ),
      attScope.params
    );

    const offScope = scope('o');
    const { rows: offering } = await pool.query(
      toParams(
        `SELECT st.id AS key, st.name AS label, s.date AS period,
                COALESCE(SUM(o.amount), 0) AS offering
           FROM offerings o
           JOIN services s ON s.id = o.service_id
           JOIN service_types st ON st.id = s.service_type_id
          WHERE ${offScope.where}
          GROUP BY st.id, st.name, s.date
          ORDER BY st.sort_order, st.name, s.date`
      ),
      offScope.params
    );

    const { rows: types } = await pool.query(
      "SELECT id AS key, name AS label FROM service_types WHERE kind = 'service' ORDER BY sort_order, name"
    );
    const periods = [...new Set([...attendance, ...offering].map((row) => row.period))].sort();
    const byKey = new Map(types.map((type) => [type.key, {
      key: type.key,
      label: type.label,
      points: periods.map((period) => ({ period, attendance: 0, offering: 0 })),
    }]));
    const periodIndex = new Map(periods.map((period, index) => [period, index]));

    for (const row of attendance) {
      const service = byKey.get(row.key);
      const index = periodIndex.get(row.period);
      if (service && index !== undefined) service.points[index].attendance = Number(row.attendance) || 0;
    }
    for (const row of offering) {
      const service = byKey.get(row.key);
      const index = periodIndex.get(row.period);
      if (service && index !== undefined) service.points[index].offering = Number(row.offering) || 0;
    }

    res.json({ periods, services: [...byKey.values()] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadServiceTrends' });
  }
});

module.exports = router;
