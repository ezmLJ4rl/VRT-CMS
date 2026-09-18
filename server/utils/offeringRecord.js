'use strict';
/**
 * Writing one offering: the church's single giving record.
 *
 * There is one way a gift enters this system, and it must stay one way. The front
 * desk types it in; a member's mobile-money payment arrives on a statement and an
 * admin confirms it. Both are the SAME ledger row: same receipt numbering, same
 * QR credential, same audit trail, and therefore the same reports. That is why
 * this function exists rather than a second insert in the reconciliation route:
 * a second insert would be a second answer to "what does a recorded gift look
 * like", and the two would drift on the first change to either.
 *
 * THE RECEIPT IS PART OF THE WRITE, NOT A SECOND STEP. The receipt number and the
 * verification token are allocated inside the caller's transaction, so a failed
 * insert never burns a number and a receipt can never exist without the
 * credential its printed QR code carries (see utils/receipt.js,
 * utils/verificationToken.js).
 */

const { encryptField } = require('./crypto');
const { nextReceiptNo, } = require('./receipt');
const { generateVerificationToken } = require('./verificationToken');

/** The offering sources. 'manual' = typed at the desk, 'import' = confirmed from
 *  an imported payment, 'demo' = written by scripts/sample-giving.js. */
const OFFERING_SOURCES = ['manual', 'import', 'demo'];

/**
 * Inserts the offering and returns `{ id, receiptNumber, verificationToken }`.
 *
 * `client` must be inside a transaction the caller owns: the receipt number, the
 * token and the row commit together or not at all.
 *
 * `receipt`    : issues a receipt (a receipt number + QR token) for this gift.
 * `receiptNumber` / `verificationToken`: reuse an existing receipt identity
 *                (a correction that takes over a voided entry's receipt). When
 *                given, they are used as-is and no number is allocated.
 * `source`     : 'manual' | 'import' | 'demo'.
 * `paymentTransactionId`: the imported payment this gift was confirmed from.
 */
async function insertOffering(client, fields) {
  const {
    serviceId,
    categoryId,
    categoryKey,
    amount,
    currency,
    offererName,
    offererPhone,
    // Already-encrypted donor fields, passed straight through: a correction
    // keeps the original's donor identity instead of re-encrypting a name the
    // caller cannot decrypt (see routes/offerings.js POST /:id/adjust).
    offererNameEnc,
    offererPhoneEnc,
    memberId,
    subSessionId,
    groupId,
    centerId,
    zoneId,
    reason,
    projectName,
    projectId,
    notes,
    recordedBy,
    receipt,
    receiptNumber,
    verificationToken,
    paymentMethod,
    paymentReference,
    source,
    paymentTransactionId,
    sessionDate,
  } = fields;

  const issueReceipt = receipt === true || !!receiptNumber;
  const nextNumber = receiptNumber || (issueReceipt ? await nextReceiptNo(sessionDate, client) : null);
  const nextToken = verificationToken || (issueReceipt ? generateVerificationToken() : null);

  const { rows } = await client.query(
    `INSERT INTO offerings
      (service_id, category_id, type, amount, currency, offerer_name_enc, offerer_phone_enc,
       member_id, sub_session_id, group_id, revival_center_id, zone_id,
       reason, project_name, notes, receipt_number, recorded_by, project_id, verification_token,
       payment_method, payment_reference, source, payment_transaction_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING id`,
    [
      serviceId,
      categoryId ?? null,
      categoryKey,
      amount,
      currency || 'TZS',
      offererNameEnc !== undefined ? offererNameEnc : (offererName ? encryptField(offererName) : null),
      offererPhoneEnc !== undefined ? offererPhoneEnc : (offererPhone ? encryptField(offererPhone) : null),
      memberId || null,
      subSessionId || null,
      groupId || null,
      centerId || null,
      zoneId || null,
      reason || null,
      projectName || null,
      notes || null,
      nextNumber,
      recordedBy,
      projectId || null,
      nextToken,
      paymentMethod || null,
      paymentReference || null,
      OFFERING_SOURCES.includes(source) ? source : 'manual',
      paymentTransactionId || null,
    ]
  );

  return { id: rows[0].id, receiptNumber: nextNumber, verificationToken: nextToken };
}

module.exports = { insertOffering, OFFERING_SOURCES };
