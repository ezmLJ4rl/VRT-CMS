const express = require('express');
const pool = require('../db/pg');
const { toParams } = require('../utils/sqlParams');
const { authenticate, requireRole, restrictReceptionistToToday } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { decryptField } = require('../utils/crypto');
const { readDonorField, canViewDonorData } = require('../utils/donorFields');
const { todayISO } = require('../utils/date');
const { findOrCreateSession } = require('../utils/sessions');
const { renderReceiptHtml, renderReceiptPdf } = require('../utils/receipt');
// One writer for the church's giving record, shared with the reconciliation
// workflow so an imported gift is recorded exactly like a desk entry.
const { insertOffering } = require('../utils/offeringRecord');
const { generateVerificationToken, verificationUrl } = require('../utils/verificationToken');
const { PAYMENT_REFERENCE_MAX, normalizePaymentMethod, normalizePaymentReference } = require('../utils/payments');
const { verificationStatusFor } = require('../utils/receiptVerification');
const { sendBatchDigest } = require('../utils/digest');
const { projectContributionError } = require('../utils/projectRules');

const router = express.Router();

// Receipt/print endpoints are opened in a new tab from the front desk, which
// drops the Authorization header. For those two routes only, accept ?token= by
// rewriting it into an Authorization header before the global authenticate runs.
router.use((req, res, next) => {
  const path = req.path;
  if ((path.endsWith('/receipt') || path.endsWith('/receipt.pdf')) && typeof req.query.token === 'string' && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  next();
});

router.use(authenticate);

const LEGACY_KEY_MAP = { tithe: 'zaka', service: 'general', thanksgiving: 'thanksgiving', special: 'special' };
const CATEGORY_HINTS = { zaka: 'tithe', thanksgiving: 'thanksgiving', general: 'service', special: 'special' };

// Donor fields are decrypted only for viewers who may see them, and a value
// that will not decrypt is reported as unavailable rather than as anonymous:
// see utils/donorFields.js for why the two must not be conflated.
function decorateRow(row, canSeeDonorData) {
  const out = { ...row };
  // The receipt's verification identity, for every viewer who may see the row:
  // the front desk needs it to print a receipt whose QR code works, and an admin
  // needs it to read the status and to copy the verification link. It is not a
  // secret from the church's own staff, it is printed on the paper they hand
  // out, so it travels with the row rather than behind a separate call.
  if (row.receipt_number) {
    out.verification_url = row.verification_token ? verificationUrl(row.verification_token) : null;
    // Derived, so a voided offering can never be reported as still verifying:
    // one answer here, the same one the public page gives (see
    // utils/receiptVerification.js).
    out.verification_status = verificationStatusFor(row);
  }
  if (canSeeDonorData) {
    const name = readDonorField(row.offerer_name_enc, { table: 'offerings', id: row.id, field: 'offerer_name_enc' });
    const phone = readDonorField(row.offerer_phone_enc, { table: 'offerings', id: row.id, field: 'offerer_phone_enc' });
    out.offererName = name.value;
    out.offererPhone = phone.value;
    out.offererNameUnavailable = name.unreadable;
    out.offererPhoneUnavailable = phone.unreadable;
  }
  delete out.offerer_name_enc;
  delete out.offerer_phone_enc;
  return out;
}

// GET /api/offerings/categories: reference list used by every entry form.
router.get('/categories', async (req, res) => {
  try {
    const { rows: categories } = await pool.query('SELECT * FROM offering_categories ORDER BY sort_order, id');
    res.json({ categories });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadOfferingCategories' });
  }
});

// GET /api/offerings, filtered by role. Receptionists: today + own entries only.
// Admin/pastor/superadmin: full history, with donor fields decrypted.
// Untyped sessions (service_type_id IS NULL) still surface via LEFT JOIN, and
// voided entries are excluded: the audit trail is the only record of them.
router.get('/', async (req, res) => {
  try {
    const { from, to, serviceTypeId, category, centerId, groupId, memberId, paymentMethod, includeVoided, accountId, source } = req.query;
    // Voided entries are hidden by default because they are mistakes the audit
    // trail keeps, not records to report on. Receipt management is the one place
    // that has to see them: a voided gift's receipt was invalidated, and an admin
    // checking a member's paper receipt needs to find it. Admin/pastor only:
    // the front desk's view stays the same as it always was.
    const seeVoided = includeVoided === '1' && req.user.role !== 'receptionist';
    const clauses = [seeVoided ? 'TRUE' : 'o.voided_at IS NULL'];
    const params = [];

    if (req.user.role === 'receptionist') {
      clauses.push('s.date = ?', 'o.recorded_by = ?');
      params.push(todayISO(), req.user.id);
    } else {
      if (from) { clauses.push('s.date >= ?'); params.push(from); }
      if (to) { clauses.push('s.date <= ?'); params.push(to); }
    }
    if (serviceTypeId) {
      clauses.push('st.id = ?');
      params.push(serviceTypeId);
    }
    if (category) {
      clauses.push('oc.key = ?');
      params.push(category);
    }
    if (centerId) {
      clauses.push('m.revival_center_id = ?');
      params.push(centerId);
    }
    if (groupId) {
      clauses.push('EXISTS (SELECT 1 FROM group_members gm WHERE gm.member_id = o.member_id AND gm.group_id = ?)');
      params.push(groupId);
    }
    // One member's giving history: the same ledger rows every total is built
    // from, so a member's own list and the church's report cannot disagree.
    if (memberId) {
      clauses.push('o.member_id = ?');
      params.push(memberId);
    }
    // How the gift was paid: the filter behind a report breakdown's drill-down
    // ("show me the mobile-money gifts in this period"). An unknown value matches
    // nothing rather than erroring, exactly like the category filter above.
    if (paymentMethod) {
      clauses.push('o.payment_method = ?');
      params.push(paymentMethod);
    }
    // How the gift was RECORDED: typed at the desk, or confirmed from a payment
    // that arrived in a church account. The drill-down behind the reconciliation
    // report, and the answer to "did this total come from the desk or the bank?".
    if (source) {
      clauses.push('o.source = ?');
      params.push(source);
    }
    // Which church account the money landed in. Only imported gifts have one, so
    // this filter (like the reconciliation report) legitimately excludes the
    // cash the desk counted, which never passes through an account at all.
    if (accountId) {
      clauses.push('pt.account_id = ?');
      params.push(accountId);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const sql = toParams(
      `SELECT o.*, s.name AS service_name, s.date AS service_date,
              s.is_temporary AS event_temporary, s.event_title, s.event_description,
              st.id AS service_type_id, st.name AS service_type_name, st.key AS service_type_key,
              oc.key AS category_key, oc.name AS category_name,
              m.member_no, m.name AS member_name,
              u.name AS recorded_by_name,
              pa.id AS payment_account_id, pa.name AS payment_account_name, pa.provider AS payment_provider,
              pt.provider_transaction_id, pt.provider_reference, pt.status AS provider_status,
              pt.match_status AS reconciliation_status, pt.source AS transaction_source
       FROM offerings o
       JOIN services s ON s.id = o.service_id
       LEFT JOIN service_types st ON st.id = s.service_type_id
       LEFT JOIN offering_categories oc ON oc.id = o.category_id
       LEFT JOIN members m ON m.id = o.member_id
       LEFT JOIN users u ON u.id = o.recorded_by
       LEFT JOIN payment_transactions pt ON pt.id = o.payment_transaction_id
       LEFT JOIN payment_accounts pa ON pa.id = pt.account_id
       ${where}
       ORDER BY o.timestamp DESC`
    );
    const { rows } = await pool.query(sql, params);

    // Per row, not per role: a receptionist gets the names back for the entries
    // they recorded (their query is already scoped to their own, today's rows).
    res.json({ offerings: rows.map((r) => decorateRow(r, canViewDonorData(req.user, r))) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadOfferings' });
  }
});

// POST /api/offerings: record a gift against a categorized service session.
router.post('/', restrictReceptionistToToday, async (req, res) => {
  try {
    const {
      serviceTypeId, serviceId, date,
      category, type,
      amount, currency, offererName, offererPhone, memberId,
      subSessionId, groupId, centerId, zoneId,
      reason, projectName, notes,
      receipt,
      projectId,
      paymentMethod, paymentReference,
    } = req.body;

    const categoryKey = category || LEGACY_KEY_MAP[type];
    if (!categoryKey) return res.status(400).json({ error: 'errors.offeringCategoryRequired' });
    const { rows: catRows } = await pool.query('SELECT * FROM offering_categories WHERE key = $1', [categoryKey]);
    const cat = catRows[0];
    if (!cat) return res.status(400).json({ error: 'errors.unknownOfferingCategory' });
    if (amount === undefined) return res.status(400).json({ error: 'errors.amountRequired' });
    if (typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'errors.amountPositiveNumber' });

    // How the gift was paid. Optional (a gift recorded by an older client, or an
    // offering that predates this, simply has none), but never unvalidated: a
    // method that is not one of the four is refused rather than stored, because
    // nothing could ever label or report on it afterwards.
    const payment = normalizePaymentMethod(paymentMethod);
    if (payment === undefined) return res.status(400).json({ error: 'errors.invalidPaymentMethod' });
    const reference = normalizePaymentReference(paymentReference);
    if (reference && reference.length > PAYMENT_REFERENCE_MAX) {
      return res.status(400).json({ error: 'errors.paymentReferenceTooLong' });
    }
    // A reference identifies HOW the money moved; without a method it is a number
    // nobody can place, and the reports (which group by method) would never show
    // it. Refusing it is kinder than storing a fact nothing can read.
    if (reference && !payment) {
      return res.status(400).json({ error: 'errors.paymentMethodRequiredForReference' });
    }

    if (cat.requires_receipt && cat.legacy !== 'special' && !offererName) {
      return res.status(400).json({
        error: 'errors.categoryRequiresGiverFullName',
        params: { category: cat.name },
      });
    }
    if (memberId) {
      const { rows: memberRows } = await pool.query('SELECT id FROM members WHERE id = $1 AND is_active = 1', [memberId]);
      if (!memberRows[0]) return res.status(400).json({ error: 'errors.memberNotFound' });
    }

    // A special project gift is linked to the project record, so the project's
    // progress is the same money as this line of the ledger, and the project's
    // name (not free text) is what the receipt prints.
    let project = null;
    if (projectId) {
      const { rows: projectRows } = await pool.query('SELECT id, name, status FROM projects WHERE id = $1', [projectId]);
      project = projectRows[0] || null;
      const projectError = projectContributionError(project, categoryKey);
      if (projectError) return res.status(400).json({ error: projectError });
    }

    let session;
    try {
      session = serviceTypeId
        ? await findOrCreateSession(Number(serviceTypeId), date || todayISO(), subSessionId ? Number(subSessionId) : undefined)
        : (await pool.query('SELECT * FROM services WHERE id = $1', [serviceId])).rows[0];
    } catch (err) {
      // findOrCreateSession signals expected failures with a catalog key (see
      // utils/sessions.js). Anything else is unexpected, and its internal message
      // must not reach the client.
      if (err.key) return res.status(err.status || 500).json({ error: err.key });
      console.error(err);
      return res.status(500).json({ error: 'errors.failedRecordOffering' });
    }
    if (!session) return res.status(404).json({ error: 'errors.serviceSessionNotFound' });

    // A rehearsal is not a service: it records attendance only, so an offering
    // must never be filed against one. (routes/serviceTypes.js applies the same
    // rule in reverse, refusing to reclassify a type that already has offerings.)
    const { rows: sessionType } = await pool.query(
      'SELECT name, kind FROM service_types WHERE id = $1',
      [session.service_type_id]
    );
    if (sessionType[0] && sessionType[0].kind === 'rehearsal') {
      return res.status(400).json({
        error: 'errors.rehearsalTakesNoOffering',
        params: { name: sessionType[0].name },
      });
    }

    // Backdating gate (server-side source of truth): a receptionist may only
    // record into TODAY's session, no matter how it was resolved: via
    // serviceTypeId (+ date), or via an explicit serviceId pointing at an
    // arbitrary existing session, which previously bypassed
    // restrictReceptionistToToday entirely (that middleware only sees
    // req.body.date). Admins/superadmins/pastor are exempt.
    if (req.user.role === 'receptionist' && session.date !== todayISO()) {
      return res.status(403).json({ error: 'errors.receptionistsOnlyRecordEntriesCurrentDay' });
    }

    const makeReceipt = receipt === true || cat.requires_receipt === 1;
    // Real transaction: the receipt number is allocated, the receipt's
    // verification token is minted, and the offering row is written on the same
    // connection, so a failed insert never burns a number, and a receipt can
    // never exist without the credential its printed QR code carries. The write
    // itself lives in utils/offeringRecord.js, because a gift confirmed from an
    // imported payment is recorded through exactly the same door: one ledger
    // row shape, one receipt identity, one audit trail.
    const client = await pool.connect();
    let id;
    let receiptNo = null;
    let verificationToken = null;
    try {
      await client.query('BEGIN');
      const written = await insertOffering(client, {
        serviceId: session.id,
        categoryId: cat.id,
        categoryKey,
        amount,
        currency,
        offererName,
        offererPhone,
        memberId,
        subSessionId,
        groupId,
        centerId,
        zoneId,
        reason,
        projectName: project?.name || projectName,
        projectId: project ? project.id : null,
        notes,
        recordedBy: req.user.id,
        receipt: makeReceipt,
        paymentMethod: payment,
        paymentReference: reference,
        sessionDate: session.date,
      });
      id = written.id;
      receiptNo = written.receiptNumber;
      verificationToken = written.verificationToken;
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit({ userId: req.user.id, action: 'offering_recorded', table: 'offerings', recordId: id, details: { type: categoryKey, amount, currency: currency || 'TZS', receipt: receiptNo || null, projectId: project ? project.id : null, paymentMethod: payment, paymentReference: reference }, ip: req.ip });

    // NOTE: offerings intentionally do NOT ping the pastor per record. The front
    // desk sends one batched summary (POST /api/notifications/send-summary →
    // utils/digest.js) covering every un-notified record for today. Per-gift
    // pushes caused notification fatigue and duplicate delivery alongside the
    // digest. Emergencies remain immediate (see routes/emergencies.js).

    res.status(201).json({
      id,
      receiptNumber: receiptNo || null,
      // Neither the token nor the link is needed to record a gift; the response
      // carries them so the front desk's confirmation can show the receipt it
      // just issued without a second round trip.
      verificationUrl: verificationToken ? verificationUrl(verificationToken) : null,
      message: 'messages.recordedSuccessfully',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRecordOffering' });
  }
});

// GET /api/offerings/summary?from=&to=: totals per category/service. Admin/pastor only.
// Voided entries are excluded; the category comes from category_id (source of truth).
router.get('/summary', requireRole('admin', 'pastor', 'superadmin'), async (req, res) => {
  try {
    const { from, to } = req.query;
    const clauses = ['o.voided_at IS NULL'];
    const params = [];
    if (from) { clauses.push('s.date >= ?'); params.push(from); }
    if (to) { clauses.push('s.date <= ?'); params.push(to); }
    const where = `WHERE ${clauses.join(' AND ')}`;

    // GROUP BY lists every non-aggregated selected expression (Postgres has no
    // arbitrary-row fallback the way SQLite does).
    const byCategorySql = toParams(
      `SELECT COALESCE(oc.key, o.type) AS key, COALESCE(oc.name, o.type) AS name, o.currency, SUM(o.amount) AS total, COUNT(*) AS entries
       FROM offerings o JOIN services s ON s.id = o.service_id
       LEFT JOIN offering_categories oc ON oc.id = o.category_id
       ${where}
       GROUP BY COALESCE(oc.key, o.type), COALESCE(oc.name, o.type), o.currency ORDER BY total DESC`
    );
    const { rows: byCategory } = await pool.query(byCategorySql, params);

    const byServiceSql = toParams(
      `SELECT s.name AS service_name, st.name AS service_type_name, s.date, SUM(o.amount) AS total, o.currency
       FROM offerings o JOIN services s ON s.id = o.service_id
       LEFT JOIN service_types st ON st.id = s.service_type_id
       ${where}
       GROUP BY s.id, st.id, o.currency ORDER BY s.date DESC`
    );
    const { rows: byService } = await pool.query(byServiceSql, params);

    res.json({ byCategory, byType: byCategory, byService });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadOfferingSummary' });
  }
});

// GET /api/offerings/top-contributors: private, admin-only view.
router.get('/top-contributors', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { from, to, limit } = req.query;
    const clauses = ['o.offerer_name_enc IS NOT NULL', 'o.voided_at IS NULL'];
    const params = [];
    if (from) { clauses.push('s.date >= ?'); params.push(from); }
    if (to) { clauses.push('s.date <= ?'); params.push(to); }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const sql = toParams(
      `SELECT o.member_id, o.offerer_name_enc, o.currency, SUM(o.amount) AS total, COUNT(*) AS gifts
       FROM offerings o JOIN services s ON s.id = o.service_id ${where}
       GROUP BY o.member_id, o.offerer_name_enc, o.currency`
    );
    const { rows } = await pool.query(sql, params);

    const decrypted = rows
      .map((r) => ({ memberId: r.member_id, name: decryptField(r.offerer_name_enc), total: r.total, currency: r.currency, gifts: r.gifts }))
      .sort((a, b) => b.total - a.total)
      .slice(0, Number(limit) || 10);

    await logAudit({ userId: req.user.id, action: 'top_contributors_viewed', table: 'offerings', ip: req.ip });
    res.json({ topContributors: decrypted });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadTopContributors' });
  }
});

// Loads a single offering row (joined) with donor fields decrypted only when the
// caller may see them. Enforces the receptionist today/own-records rule.
async function loadOfferingFor(req, res) {
  const { rows } = await pool.query(
    `SELECT o.*, s.name AS service_name, s.date AS service_date, s.sub_session_id,
            oc.key AS category_key, oc.name AS category_name,
            u.name AS recorded_by_name,
            -- The giver's giving code, so a receipt for a member's gift can print
            -- the code they quote when they pay (see utils/receipt.js). NULL for a
            -- gift given by a name the desk typed, which has no member behind it.
            m.member_no AS giver_member_no
     FROM offerings o
     JOIN services s ON s.id = o.service_id
     LEFT JOIN offering_categories oc ON oc.id = o.category_id
     LEFT JOIN users u ON u.id = o.recorded_by
     LEFT JOIN members m ON m.id = o.member_id
     WHERE o.id = $1`,
    [req.params.id]
  );
  const row = rows[0];
  if (!row) return { error: res.status(404).json({ error: 'errors.offeringNotFound' }) };

  if (req.user.role === 'receptionist' && (row.recorded_by !== req.user.id || row.service_date !== todayISO())) {
    return { error: res.status(403).json({ error: 'errors.onlyViewOwnEntriesToday' }) };
  }
  return { row: decorateRow(row, canViewDonorData(req.user, row)) };
}

// PATCH /api/offerings/:id/void: soft-void a mistaken entry. Admin/superadmin
// only. The row stays in the database (audit trail), disappears from every
// list/summary/digest, and its receipt number is retired: the PDF/HTML
// receipt endpoints then return 410 Gone for it.
router.patch('/:id/void', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM offerings WHERE id = $1', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'errors.offeringRecordNotFound' });
    if (row.voided_at) return res.status(409).json({ error: 'errors.offeringAlreadyVoided' });

    const reason = String(req.body?.reason || '').trim() || null;
    // Voiding the gift invalidates the paper receipt that was handed out for it,
    // so the receipt's verification verdict flips in the same statement: a
    // member scanning it must be told it is no longer valid, not that it is
    // fine. The token itself is KEPT: scanning paper that exists has to reach a
    // real answer, and "revoked" is the honest one (dropping the token would
    // make the same scan look like a receipt that never existed).
    await pool.query(
      `UPDATE offerings
          SET voided_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), voided_by = $1, void_reason = $2,
              verification_status = CASE WHEN receipt_number IS NULL THEN verification_status ELSE 'revoked' END,
              verification_revoked_at = CASE WHEN receipt_number IS NULL THEN verification_revoked_at
                                             ELSE to_char(now(), 'YYYY-MM-DD HH24:MI:SS') END,
              verification_revoked_by = CASE WHEN receipt_number IS NULL THEN verification_revoked_by ELSE $1 END,
              verification_revocation_reason = CASE WHEN receipt_number IS NULL THEN verification_revocation_reason ELSE $2 END
        WHERE id = $3`,
      [req.user.id, reason, row.id]
    );
    await logAudit({
      userId: req.user.id,
      action: 'offering_voided',
      table: 'offerings',
      recordId: row.id,
      details: { amount: row.amount, currency: row.currency, receipt: row.receipt_number, reason },
      ip: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedVoidOffering' });
  }
});

// POST /api/offerings/:id/adjust: record a correction for a voided entry.
// The mistake stays voided; the correction is a NEW offering row (optionally
// reusing the receipt number so the paper trail stays one receipt per gift),
// linked to the voided original via notes, and both events are audit-logged.
router.post('/:id/adjust', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM offerings WHERE id = $1', [req.params.id]);
    const original = rows[0];
    if (!original) return res.status(404).json({ error: 'errors.offeringRecordNotFound' });
    if (!original.voided_at) return res.status(409).json({ error: 'errors.voidOfferingBeforeRecordingCorrection' });

    const { amount, reason } = req.body || {};
    if (typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'errors.positiveCorrectedAmountRequired' });

    // A correction usually fixes the AMOUNT alone, so how the gift was paid
    // carries over from the entry being corrected: the money did not change
    // hands a second time. The method can be restated when it was typed wrong
    // (that is the kind of thing a correction is for), but not blanked: the one
    // value that is never taken from the body is "nothing was recorded", since a
    // correction is a claim about a payment that did happen.
    const correctedPayment = normalizePaymentMethod(req.body?.paymentMethod);
    if (correctedPayment === undefined) return res.status(400).json({ error: 'errors.invalidPaymentMethod' });
    const payment = correctedPayment === null ? (normalizePaymentMethod(original.payment_method) || null) : correctedPayment;
    const reference = normalizePaymentReference(
      req.body?.paymentReference !== undefined ? req.body.paymentReference : original.payment_reference
    );
    if (reference && reference.length > PAYMENT_REFERENCE_MAX) {
      return res.status(400).json({ error: 'errors.paymentReferenceTooLong' });
    }
    if (reference && !payment) {
      return res.status(400).json({ error: 'errors.paymentMethodRequiredForReference' });
    }

    const reuseReceipt = req.body?.reuseReceipt !== false && !!original.receipt_number;
    // Real transaction: moving the UNIQUE receipt number off the voided original
    // and stamping it on the correction must happen atomically.
    const client = await pool.connect();
    let id;
    let verificationToken = null;
    try {
      await client.query('BEGIN');
      let receiptNo = null;
      if (reuseReceipt) {
        // receipt_number is UNIQUE: free it from the voided original before
        // stamping it on the correction: one number per paper trail, moved
        // atomically. The void audit entry (and void_reason) still records the
        // original association.
        // The verification token moves with it, so the correction inherits the
        // SAME receipt identity: the paper already in the member's hands (and
        // the QR code on it) still resolves to their receipt, now showing the
        // corrected amount. A fresh token here would silently invalidate every
        // copy of that receipt already issued.
        await client.query('UPDATE offerings SET receipt_number = NULL, verification_token = NULL WHERE id = $1', [original.id]);
        receiptNo = original.receipt_number;
        verificationToken = original.verification_token || generateVerificationToken();
      }
      const written = await insertOffering(client, {
        serviceId: original.service_id,
        categoryId: original.category_id,
        categoryKey: original.type,
        amount,
        currency: original.currency,
        // The correction keeps the original's identity fields as they are
        // (encrypted donor name/phone included): it restates the amount, not the
        // person. Its payer fields, though, are the CORRECTED ones.
        offererNameEnc: original.offerer_name_enc,
        offererPhoneEnc: original.offerer_phone_enc,
        memberId: original.member_id,
        subSessionId: original.sub_session_id,
        groupId: original.group_id,
        centerId: original.revival_center_id,
        zoneId: original.zone_id,
        reason: original.reason,
        projectName: original.project_name,
        notes: reason ? `Correction of #${original.id}: ${reason}` : `Correction of #${original.id}`,
        recordedBy: req.user.id,
        receiptNumber: receiptNo,
        verificationToken,
        paymentMethod: payment,
        paymentReference: reference,
        // A correction of a gift that came in by transfer is still that gift, so
        // it stays an imported record rather than becoming a desk entry.
        source: original.source,
        paymentTransactionId: original.payment_transaction_id,
      });
      id = written.id;
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit({
      userId: req.user.id,
      action: 'offering_adjusted',
      table: 'offerings',
      recordId: id,
      details: { correctedFrom: original.id, amount, currency: original.currency, receipt: reuseReceipt ? original.receipt_number : null, reason: reason || null, paymentMethod: payment, paymentReference: reference },
      ip: req.ip,
    });
    res.status(201).json({ id, receiptNumber: reuseReceipt ? original.receipt_number : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRecordCorrection' });
  }
});

/*
 * Receipt verification management (admin/superadmin).
 *
 * These act on ONE receipt's verification identity. They are not the daily
 * audit-chain check, that is /api/reports/audit/verify, its own endpoint and
 * its own admin screen, because that answers a different question about a
 * different thing (whether a DAY's tamper-evident log still adds up).
 */

// What a management action may act on: a receipt that exists, carries a
// verification identity, and is not voided (a voided receipt is already
// invalid: see PATCH /:id/void, and re-verifying it would be a lie).
async function loadReceiptForManagement(req, res) {
  const { rows } = await pool.query('SELECT * FROM offerings WHERE id = $1', [req.params.id]);
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: 'errors.offeringRecordNotFound' });
    return null;
  }
  if (!row.receipt_number) {
    res.status(404).json({ error: 'errors.noReceiptGeneratedOffering' });
    return null;
  }
  if (row.voided_at) {
    res.status(409).json({ error: 'errors.offeringVoidedReceiptNoLongerValid' });
    return null;
  }
  return row;
}

// GET /api/offerings/:id/audit: the audit history of this receipt/transaction:
// what was recorded, corrected, voided or invalidated, by whom and when.
router.get('/:id/audit', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows: found } = await pool.query('SELECT id, receipt_number FROM offerings WHERE id = $1', [req.params.id]);
    const row = found[0];
    if (!row) return res.status(404).json({ error: 'errors.offeringRecordNotFound' });

    // Three ways an entry belongs to this receipt: it is about the row itself;
    // it is the correction that replaced it (the correction names the row it
    // came from); or it quotes this receipt number, which is how a correction
    // that took over the receipt number still shows up in the history of the
    // receipt the member is holding. `details` is a JSON object in a text
    // column, so the cast is guarded by the shape check rather than trusted.
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.details, a.timestamp, a.ip_address, a.record_id, a.table_affected,
              u.name AS user_name
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE (a.table_affected = 'offerings' AND a.record_id = $1)
           OR CASE WHEN a.details LIKE '{%' THEN a.details::json ->> 'correctedFrom' = $2::text ELSE false END
           OR CASE WHEN a.details LIKE '{%' THEN a.details::json ->> 'receipt' = $3::text ELSE false END
        ORDER BY a.id DESC
        LIMIT 200`,
      [row.id, String(row.id), row.receipt_number]
    );

    res.json({
      receiptNumber: row.receipt_number,
      entries: rows.map((r) => ({
        id: r.id,
        action: r.action,
        details: r.details ? JSON.parse(r.details) : null,
        timestamp: r.timestamp,
        recordedBy: r.user_name || null,
        ip: r.ip_address || null,
        recordId: r.record_id,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadReceiptAudit' });
  }
});

// POST /api/offerings/:id/verification/regenerate: re-issue the receipt's
// verification identity, for reprinting.
//
// It is deliberately NOT a "new receipt": a receipt that already has a token
// keeps it, because the copies already in members' hands must not be invalidated
// by the church reprinting its own record (the requirement that regenerated
// copies share one identity). The only case that mints a token is a receipt that
// has none: a record issued before QR verification existed and missed by the
// boot backfill (db/migrate.js).
router.post('/:id/verification/regenerate', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const row = await loadReceiptForManagement(req, res);
    if (!row) return;

    const derived = verificationStatusFor(row);
    if (row.verification_token) {
      return res.json({
        issued: false,
        verificationToken: row.verification_token,
        verificationUrl: verificationUrl(row.verification_token),
        status: derived,
      });
    }

    const token = generateVerificationToken();
    await pool.query('UPDATE offerings SET verification_token = $1 WHERE id = $2', [token, row.id]);
    await logAudit({
      userId: req.user.id,
      action: 'receipt_verification_issued',
      table: 'offerings',
      recordId: row.id,
      details: { receipt: row.receipt_number },
      ip: req.ip,
    });
    res.json({ issued: true, verificationToken: token, verificationUrl: verificationUrl(token), status: derived });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRevokeReceiptVerification' });
  }
});

// PATCH /api/offerings/:id/verification/revoke: invalidate a receipt without
// touching the ledger entry (a receipt issued in error, one that must be
// withdrawn while the gift itself stands). Setting the state it is already in is
// a no-op that reports the current state, so a double click or a retried request
// can never produce an error nobody can act on.
router.patch('/:id/verification/revoke', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const row = await loadReceiptForManagement(req, res);
    if (!row) return;

    if (row.verification_status === 'revoked') {
      return res.json({
        status: 'revoked',
        unchanged: true,
        revokedAt: row.verification_revoked_at,
        reason: row.verification_revocation_reason,
        verificationUrl: row.verification_token ? verificationUrl(row.verification_token) : null,
      });
    }

    const reason = String(req.body?.reason || '').trim() || null;
    const { rows } = await pool.query(
      `UPDATE offerings
          SET verification_status = 'revoked',
              verification_revoked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
              verification_revoked_by = $1,
              verification_revocation_reason = $2
        WHERE id = $3
        RETURNING verification_revoked_at`,
      [req.user.id, reason, row.id]
    );
    await logAudit({
      userId: req.user.id,
      action: 'receipt_verification_revoked',
      table: 'offerings',
      recordId: row.id,
      details: { receipt: row.receipt_number, reason },
      ip: req.ip,
    });
    res.json({
      status: 'revoked',
      unchanged: false,
      revokedAt: rows[0]?.verification_revoked_at || null,
      reason,
      verificationUrl: row.verification_token ? verificationUrl(row.verification_token) : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRevokeReceiptVerification' });
  }
});

// PATCH /api/offerings/:id/verification/restore: put a revoked receipt back in
// good standing. Refused for a voided receipt (loadReceiptForManagement): the
// offering itself is out of the ledger, so its receipt cannot verify again.
router.patch('/:id/verification/restore', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const row = await loadReceiptForManagement(req, res);
    if (!row) return;

    if (row.verification_status !== 'revoked') {
      return res.json({ status: 'active', unchanged: true, verificationUrl: row.verification_token ? verificationUrl(row.verification_token) : null });
    }

    await pool.query(
      `UPDATE offerings
          SET verification_status = 'active',
              verification_revoked_at = NULL,
              verification_revoked_by = NULL,
              verification_revocation_reason = NULL
        WHERE id = $1`,
      [row.id]
    );
    await logAudit({
      userId: req.user.id,
      action: 'receipt_verification_restored',
      table: 'offerings',
      recordId: row.id,
      details: { receipt: row.receipt_number },
      ip: req.ip,
    });
    res.json({ status: 'active', unchanged: false, verificationUrl: row.verification_token ? verificationUrl(row.verification_token) : null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRestoreReceiptVerification' });
  }
});

// GET /api/offerings/:id/receipt: printable HTML.
router.get('/:id/receipt', async (req, res) => {
  try {
    const { row, error } = await loadOfferingFor(req, res);
    if (error) return;
    if (!row.receipt_number) return res.status(404).json({ error: 'errors.noReceiptGeneratedOffering' });
    if (row.voided_at) return res.status(410).json({ error: 'errors.offeringVoidedReceiptNoLongerValid' });
    // The receipt is rendered by the SERVER, so it never passes through the
    // response-localization layer: the caller's language is handed to the
    // renderer directly, from the same X-Language/Accept-Language/?lang= that
    // the JSON errors already follow.
    res.type('html').send(renderReceiptHtml(row, req.locale));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.notRenderReceipt' });
  }
});

// GET /api/offerings/:id/receipt.pdf: server-generated PDF for donors/records.
router.get('/:id/receipt.pdf', async (req, res) => {
  try {
    const { row, error } = await loadOfferingFor(req, res);
    if (error) return;
    if (!row.receipt_number) return res.status(404).json({ error: 'errors.noReceiptGeneratedOffering' });
    if (row.voided_at) return res.status(410).json({ error: 'errors.offeringVoidedReceiptNoLongerValid' });
    const buffer = await renderReceiptPdf(row, req.locale);
    res.setHeader('Content-Type', 'application/pdf');
    const disposition = req.query.dl === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="receipt-${row.receipt_number}.pdf"`);
    res.send(buffer);
  } catch (err) {
    console.error('receipt pdf generation failed:', err);
    res.status(500).json({ error: 'errors.notGenerateReceiptPdf' });
  }
});

// POST /api/offerings/:id/notify: trigger the batched summary for the caller's
// un-notified records recorded today.
router.post('/:id/notify', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM offerings WHERE id = $1', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'errors.offeringRecordNotFound' });
    if (req.user.role === 'receptionist' && row.recorded_by !== req.user.id) {
      return res.status(403).json({ error: 'errors.onlySendPastorOwnRecords' });
    }
    const result = await sendBatchDigest({ userId: req.user.id, userName: req.user.name, locale: req.locale });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedSendNotification' });
  }
});

module.exports = router;
