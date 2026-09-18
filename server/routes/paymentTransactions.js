'use strict';
/**
 * The reconciliation workflow: a payment arrived in a church account, and an
 * administrator decides what it is.
 *
 *   account -> incoming payments -> automatic matching -> matched / unmatched
 *           -> admin review -> confirmed giving record -> receipt + reports
 *
 * THREE RULES THE WHOLE FILE IS BUILT ON
 * --------------------------------------
 * 1. NOTHING BECOMES GIVING WITHOUT A PERSON. Importing and matching only ever
 *    fill in suggestions; `POST /:id/confirm` is the single act that writes an
 *    offering. So an unattended overnight sync can never invent a gift, and every
 *    figure in the reports has been seen by an admin who read the payer's name.
 *
 * 2. MONEY THAT DID NOT ARRIVE IS NOT GIVING. A payment the provider reports as
 *    failed or reversed is refused outright at confirmation, and a pending one is
 *    allowed (a church may well be holding money the provider has not settled
 *    yet) but the audit entry records that it was still pending when confirmed.
 *
 * 3. CONFIRMING IS IDEMPOTENT. The offering insert carries
 *    `payment_transaction_id`, which is UNIQUE (see db/schema.sql), so a
 *    double-click or two admins racing produce ONE gift: the second attempt is
 *    answered with the receipt that already exists rather than a second one.
 *
 * Access is admin/superadmin throughout: payer names, phone numbers and the
 * church's account references are financial detail, and the pastor's view of
 * giving (aggregate, by category and center) is deliberately not this view.
 */

const express = require('express');
const pool = require('../db/pg');
const { toParams } = require('../utils/sqlParams');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { decryptField } = require('../utils/crypto');
const { normalizePaymentMethod, normalizePaymentReference, PAYMENT_REFERENCE_MAX } = require('../utils/payments');
const { findOrCreateSession } = require('../utils/sessions');
const { insertOffering } = require('../utils/offeringRecord');
const { verificationUrl } = require('../utils/verificationToken');
const { MATCH_STATUSES, matchTransaction } = require('../utils/paymentIntake');
// The provider's status is an enum stored in the database, so it is labelled for
// the reader rather than printed raw into a sentence.
const { translator, enumLabel } = require('../i18n');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('admin', 'superadmin'));

/** The row shape the screen reads. Payer phone is decrypted for admins only:
 *  it is the field that decides most "is this our member?" questions, and an
 *  admin reconciling the church's money is exactly who may see it. It never
 *  reaches a receipt, a verification page, or any other role. */
function decorate(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    provider: row.account_provider,
    method: row.account_method,
    providerTransactionId: row.provider_transaction_id,
    providerReference: row.provider_reference,
    amount: row.amount,
    currency: row.currency,
    occurredAt: row.occurred_at,
    payerName: row.payer_name,
    payerPhone: decryptField(row.payer_phone_enc) || null,
    payerAccountRef: row.payer_account_ref,
    description: row.description,
    status: row.status,
    source: row.source,
    matchStatus: row.match_status,
    matchMethod: row.match_method,
    // Why the matcher hesitated, as a key the screen names in the reader's
    // language: null where the state itself is the whole story.
    matchNote: row.match_note,
    matchedMemberId: row.matched_member_id,
    matchedMemberName: row.matched_member_name,
    matchedMemberNo: row.matched_member_no,
    suggestedMemberId: row.suggested_member_id,
    suggestedMemberName: row.suggested_member_name,
    suggestedMemberNo: row.suggested_member_no,
    offeringId: row.offering_id,
    receiptNumber: row.receipt_number,
    verificationUrl: row.receipt_number && row.verification_token ? verificationUrl(row.verification_token) : null,
    reconciledAt: row.reconciled_at,
    ignoredReason: row.ignored_reason,
    importNote: row.import_note,
    possibleDuplicateOf: row.possible_duplicate_of,
    importedAt: row.imported_at,
    importedByName: row.imported_by_name,
  };
}

const SELECT_TRANSACTIONS = `
  SELECT pt.*, pa.name AS account_name, pa.provider AS account_provider, pa.method AS account_method,
         mm.name AS matched_member_name, mm.member_no AS matched_member_no,
         sm.name AS suggested_member_name, sm.member_no AS suggested_member_no,
         o.receipt_number, o.verification_token,
         iu.name AS imported_by_name
    FROM payment_transactions pt
    JOIN payment_accounts pa ON pa.id = pt.account_id
    LEFT JOIN members mm ON mm.id = pt.matched_member_id
    LEFT JOIN members sm ON sm.id = pt.suggested_member_id
    LEFT JOIN offerings o ON o.id = pt.offering_id
    LEFT JOIN users iu ON iu.id = pt.imported_by
`;

function buildFilters(query) {
  const clauses = ['TRUE'];
  const params = [];
  if (query.accountId) { clauses.push('pt.account_id = ?'); params.push(query.accountId); }
  const statuses = String(query.matchStatus || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => MATCH_STATUSES.includes(s));
  if (statuses.length) { clauses.push(`pt.match_status IN (${statuses.map(() => '?').join(',')})`); params.push(...statuses); }
  if (query.status) { clauses.push('pt.status = ?'); params.push(query.status); }
  if (query.from) { clauses.push('pt.occurred_at >= ?'); params.push(`${query.from} 00:00:00`); }
  if (query.to) { clauses.push('pt.occurred_at <= ?'); params.push(`${query.to} 23:59:59`); }
  // Free-text search is for the reference somebody is holding in their hand, a
  // mobile-money code, a slip number, a payer name, so it searches those three
  // and never the amount (a search by number would match half the ledger).
  if (query.q && String(query.q).trim()) {
    const term = `%${String(query.q).trim()}%`;
    clauses.push('(pt.provider_reference ILIKE ? OR pt.provider_transaction_id ILIKE ? OR pt.payer_name ILIKE ? OR pt.description ILIKE ?)');
    params.push(term, term, term, term);
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, params };
}

// GET /api/payment-transactions/summary: what is waiting, and how much of it.
// Registered before '/:id' so 'summary' is never read as an id.
router.get('/summary', async (req, res) => {
  try {
    const { where, params } = buildFilters({ ...req.query, matchStatus: '' });
    const { rows } = await pool.query(
      toParams(
        `SELECT pt.match_status AS match_status, COUNT(*)::int AS payments, COALESCE(SUM(pt.amount), 0) AS amount
           FROM payment_transactions pt ${where}
          GROUP BY pt.match_status`
      ),
      params
    );
    const counts = { unmatched: 0, review: 0, matched: 0, confirmed: 0, ignored: 0 };
    const amounts = { unmatched: 0, review: 0, matched: 0, confirmed: 0, ignored: 0 };
    for (const row of rows) {
      counts[row.match_status] = Number(row.payments);
      amounts[row.match_status] = Number(row.amount);
    }
    res.json({
      counts,
      amounts,
      awaiting: counts.unmatched + counts.review,
      awaitingAmount: amounts.unmatched + amounts.review,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadPaymentSummary' });
  }
});

// GET /api/payment-transactions: the incoming payments themselves.
router.get('/', async (req, res) => {
  try {
    const { where, params } = buildFilters(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
    const { rows } = await pool.query(
      toParams(`${SELECT_TRANSACTIONS} ${where} ORDER BY pt.occurred_at DESC, pt.id DESC LIMIT ${limit}`),
      params
    );
    res.json({ transactions: rows.map(decorate) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadPaymentTransactions' });
  }
});

// GET /api/payment-transactions/:id: one payment, with everything known about it.
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT_TRANSACTIONS} WHERE pt.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'errors.paymentTransactionNotFound' });
    res.json({ transaction: decorate(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadPaymentTransaction' });
  }
});

async function loadFor(req, res) {
  const { rows } = await pool.query('SELECT * FROM payment_transactions WHERE id = $1', [req.params.id]);
  if (!rows[0]) {
    res.status(404).json({ error: 'errors.paymentTransactionNotFound' });
    return null;
  }
  return rows[0];
}

/** 409 with the existing receipt, because the honest answer to "confirm this
 *  again?" is "it is already recorded: here is its receipt". */
function alreadyConfirmed(res, transaction) {
  return res.status(409).json({
    error: 'errors.paymentAlreadyConfirmed',
    params: { offeringId: transaction.offering_id },
  });
}

/**
 * POST /api/payment-transactions/:id/match: a person says this is that member.
 *
 * A manual match is FINAL in a way the automatic ones are not: the matcher is
 * told to leave `match_method = 'manual'` rows alone on every later sync
 * (utils/paymentIntake.js), so a human decision is never quietly overturned by a
 * heuristic.
 */
router.post('/:id/match', async (req, res) => {
  try {
    const transaction = await loadFor(req, res);
    if (!transaction) return;
    if (transaction.match_status === 'confirmed') return alreadyConfirmed(res, transaction);

    const memberId = Number(req.body?.memberId);
    if (!memberId) return res.status(400).json({ error: 'errors.memberRequired' });
    const { rows: members } = await pool.query('SELECT id, name FROM members WHERE id = $1 AND is_active = 1', [memberId]);
    if (!members[0]) return res.status(400).json({ error: 'errors.memberNotFound' });

    await pool.query(
      // No note: a person decided, and the note exists to explain the matcher's
      // hesitation, not to annotate a decision.
      `UPDATE payment_transactions
          SET match_status = 'matched', matched_member_id = $1, suggested_member_id = NULL, match_method = 'manual',
              match_note = NULL,
              matched_by = $2, matched_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE id = $3`,
      [memberId, req.user.id, transaction.id]
    );
    await logAudit({
      userId: req.user.id,
      action: 'payment_matched',
      table: 'payment_transactions',
      recordId: transaction.id,
      details: { amount: transaction.amount, currency: transaction.currency, memberId, memberName: members[0].name, previous: transaction.match_status, method: 'manual' },
      ip: req.ip,
    });
    res.json({ success: true, message: 'messages.paymentMatched' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedMatchPayment' });
  }
});

// POST /api/payment-transactions/:id/unmatch: take a match back. Refused once
// the payment is confirmed: there is a giving record (and a receipt) by then, and
// the way to undo THAT is the ledger's own void/correct flow, not this screen
// silently detaching a payment from an entry that still exists.
router.post('/:id/unmatch', async (req, res) => {
  try {
    const transaction = await loadFor(req, res);
    if (!transaction) return;
    if (transaction.match_status === 'confirmed') return alreadyConfirmed(res, transaction);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-run the rules rather than forcing 'unmatched': the payment may still
      // be matchable (its payer's number is a member's), and the admin's intent
      // here is "not that person", not "treat this as unknown".
      // reprocess: the matcher normally leaves a hand-made match alone, and this
      // request is a person undoing a person: the one case where re-deriving is
      // what was asked for.
      const verdict = await matchTransaction(client, transaction.id, { userId: req.user.id, reprocess: true });
      await client.query('COMMIT');
      await logAudit({
        userId: req.user.id,
        action: 'payment_unmatched',
        table: 'payment_transactions',
        recordId: transaction.id,
        details: { amount: transaction.amount, currency: transaction.currency, previousMemberId: transaction.matched_member_id, now: verdict?.status || 'unmatched' },
        ip: req.ip,
      });
      res.json({ success: true, matchStatus: verdict?.status || 'unmatched', message: 'messages.paymentUnmatched' });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUnmatchPayment' });
  }
});

// POST /api/payment-transactions/:id/ignore: "this is not giving" (a loan
// repayment into the church's account, a transfer between its own accounts).
// Kept, not deleted: the statement line existed, and a reconciliation that hides
// what it decided about is not a reconciliation.
router.post('/:id/ignore', async (req, res) => {
  try {
    const transaction = await loadFor(req, res);
    if (!transaction) return;
    if (transaction.match_status === 'confirmed') return alreadyConfirmed(res, transaction);
    const reason = String(req.body?.reason || '').trim().slice(0, 300) || null;
    await pool.query(
      `UPDATE payment_transactions
          SET match_status = 'ignored', ignored_reason = $1, matched_member_id = NULL, match_note = NULL
        WHERE id = $2`,
      [reason, transaction.id]
    );
    await logAudit({
      userId: req.user.id,
      action: 'payment_ignored',
      table: 'payment_transactions',
      recordId: transaction.id,
      details: { amount: transaction.amount, currency: transaction.currency, reason, previous: transaction.match_status },
      ip: req.ip,
    });
    res.json({ success: true, message: 'messages.paymentIgnored' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedIgnorePayment' });
  }
});

// POST /api/payment-transactions/:id/reopen: bring an ignored payment back for
// review (the decision was wrong, or the sender turned out to be a member).
router.post('/:id/reopen', async (req, res) => {
  try {
    const transaction = await loadFor(req, res);
    if (!transaction) return;
    if (transaction.match_status === 'confirmed') return alreadyConfirmed(res, transaction);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE payment_transactions SET match_status = \'unmatched\', ignored_reason = NULL, match_note = NULL WHERE id = $1', [transaction.id]);
      const verdict = await matchTransaction(client, transaction.id, { userId: req.user.id });
      await client.query('COMMIT');
      await logAudit({
        userId: req.user.id,
        action: 'payment_reopened',
        table: 'payment_transactions',
        recordId: transaction.id,
        details: { amount: transaction.amount, currency: transaction.currency, now: verdict?.status || 'unmatched' },
        ip: req.ip,
      });
      res.json({ success: true, matchStatus: verdict?.status || 'unmatched', message: 'messages.paymentReopened' });
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedReopenPayment' });
  }
});

/**
 * POST /api/payment-transactions/:id/confirm: the act that turns a payment into
 * giving, and issues its receipt.
 *
 * WHAT IS REQUIRED: an offering category and a service type. The DATE defaults to
 * the day the money actually moved (not the day the admin got to the screen), and
 * the amount defaults to what arrived: a confirmation is normally "yes, this is
 * a tithe, that Sunday", not a re-entry of the figures. Any of them may be
 * overridden, which is how a mistyped provider amount or a payment that arrived
 * late is recorded honestly.
 */
router.post('/:id/confirm', async (req, res) => {
  try {
    const transaction = await loadFor(req, res);
    if (!transaction) return;
    if (transaction.match_status === 'confirmed') return alreadyConfirmed(res, transaction);

    // Money the provider says never arrived (or took back) is not a gift.
    if (transaction.status === 'failed' || transaction.status === 'reversed') {
      const t = translator(req.locale);
      return res.status(400).json({
        error: 'errors.paymentNotSuccessfulCannotRecord',
        params: { status: enumLabel(t, 'payment.status_', transaction.status) },
      });
    }

    const body = req.body || {};
    const categoryKey = body.category;
    if (!categoryKey) return res.status(400).json({ error: 'errors.offeringCategoryRequired' });
    const { rows: catRows } = await pool.query('SELECT * FROM offering_categories WHERE key = $1', [categoryKey]);
    const cat = catRows[0];
    if (!cat) return res.status(400).json({ error: 'errors.unknownOfferingCategory' });

    const amount = body.amount === undefined || body.amount === null ? Number(transaction.amount) : Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'errors.amountPositiveNumber' });

    const memberId = Number(body.memberId || transaction.matched_member_id) || null;
    let member = null;
    if (memberId) {
      const { rows } = await pool.query('SELECT id, name, revival_center_id FROM members WHERE id = $1 AND is_active = 1', [memberId]);
      member = rows[0] || null;
      if (!member) return res.status(400).json({ error: 'errors.memberNotFound' });
    }

    // The reference a member would quote, and that the receipt prints: the
    // provider's own reference when it sent one, otherwise its transaction id,
    // which is the only number on the statement that identifies this payment.
    const reference = normalizePaymentReference(body.paymentReference ?? transaction.provider_reference ?? transaction.provider_transaction_id);
    if (reference && reference.length > PAYMENT_REFERENCE_MAX) {
      return res.status(400).json({ error: 'errors.paymentReferenceTooLong' });
    }

    const serviceTypeId = Number(body.serviceTypeId);
    const date = body.date || transaction.occurred_at.slice(0, 10);
    let session;
    try {
      session = serviceTypeId
        ? await findOrCreateSession(serviceTypeId, date)
        : (await pool.query('SELECT * FROM services WHERE id = $1', [body.serviceId])).rows[0];
    } catch (err) {
      if (err.key) return res.status(err.status || 500).json({ error: err.key });
      throw err;
    }
    if (!session) return res.status(404).json({ error: 'errors.serviceSessionNotFound' });
    const { rows: sessionType } = await pool.query('SELECT name, kind FROM service_types WHERE id = $1', [session.service_type_id]);
    if (sessionType[0] && sessionType[0].kind === 'rehearsal') {
      return res.status(400).json({ error: 'errors.rehearsalTakesNoOffering', params: { name: sessionType[0].name } });
    }

    let project = null;
    if (body.projectId) {
      const { rows } = await pool.query('SELECT id, name FROM projects WHERE id = $1', [body.projectId]);
      project = rows[0] || null;
      if (!project) return res.status(400).json({ error: 'errors.projectNotFound' });
    }

    // How the money was paid comes from the ACCOUNT (a bank account is 'bank', a
    // mobile-money till is 'mobile_money'), because that is a fact about where the
    // payment arrived rather than a choice to be re-made per gift. An explicit
    // override is allowed for the odd case, and an invalid one is refused: the
    // desk's four-value vocabulary is the only vocabulary there is.
    const override = normalizePaymentMethod(body.paymentMethod);
    if (override === undefined) return res.status(400).json({ error: 'errors.invalidPaymentMethod' });
    const accountMethod = override ?? normalizePaymentMethod(
      (await pool.query('SELECT method FROM payment_accounts WHERE id = $1', [transaction.account_id])).rows[0]?.method
    ) ?? null;
    const paymentMethod = accountMethod;

    const client = await pool.connect();
    let written;
    try {
      await client.query('BEGIN');
      written = await insertOffering(client, {
        serviceId: session.id,
        categoryId: cat.id,
        categoryKey,
        amount,
        currency: transaction.currency,
        // The receipt names a person: the member it was matched to, or the payer
        // the provider named. Never invented: an unmatched payment confirmed as
        // anonymous giving stays anonymous.
        offererName: member ? member.name : (transaction.payer_name || null),
        memberId,
        centerId: member ? member.revival_center_id : null,
        reason: body.reason || null,
        projectName: project ? project.name : null,
        projectId: project ? project.id : null,
        // The link back to the payment is a COLUMN (payment_transaction_id), not
        // prose in a note: the note only carries what the admin typed, and an
        // admin who leaves it blank gets a blank note rather than a machine
        // sentence nobody asked for.
        notes: body.notes || null,
        recordedBy: req.user.id,
        // A receipt is always issued: the payment is identified, and the church
        // hands the member something that verifies (see routes/verification.js).
        receipt: true,
        paymentMethod,
        paymentReference: reference,
        source: 'import',
        paymentTransactionId: transaction.id,
        sessionDate: session.date,
      });

      await client.query(
        // match_note is cleared here too: whatever the matcher was unsure about,
        // an admin has now looked at the payer's name and written the gift.
        `UPDATE payment_transactions
            SET match_status = 'confirmed', offering_id = $1, reconciled_by = $2,
                reconciled_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
                match_note = NULL,
                matched_member_id = COALESCE($3::int, matched_member_id),
                match_method = CASE WHEN $3::int IS NULL THEN match_method ELSE COALESCE(NULLIF(match_method,''),'manual') END
          WHERE id = $4`,
        [written.id, req.user.id, memberId, transaction.id]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      // The unique index on offerings.payment_transaction_id: two admins
      // confirmed the same payment at once, and the loser is told the receipt
      // that already exists instead of being given a second one.
      if (txErr.code === '23505') return alreadyConfirmed(res, transaction);
      throw txErr;
    } finally {
      client.release();
    }

    // Two entries, because two records changed and each has its own history: the
    // giving record's (shown on the receipt's audit panel, and keyed to the
    // offering so a receipt query finds it) and the payment's (shown on the
    // reconciliation screen).
    await logAudit({
      userId: req.user.id,
      action: 'offering_recorded',
      table: 'offerings',
      recordId: written.id,
      details: {
        type: categoryKey,
        amount,
        currency: transaction.currency,
        receipt: written.receiptNumber || null,
        source: 'import',
        paymentMethod,
        paymentReference: reference,
        paymentTransactionId: transaction.id,
        providerStatus: transaction.status,
      },
      ip: req.ip,
    });
    await logAudit({
      userId: req.user.id,
      action: 'payment_confirmed',
      table: 'payment_transactions',
      recordId: transaction.id,
      details: { offeringId: written.id, receipt: written.receiptNumber || null, memberId, amount, category: categoryKey },
      ip: req.ip,
    });

    res.status(201).json({
      offeringId: written.id,
      receiptNumber: written.receiptNumber || null,
      verificationUrl: written.verificationToken ? verificationUrl(written.verificationToken) : null,
      message: 'messages.paymentConfirmed',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedConfirmPayment' });
  }
});

module.exports = router;
