'use strict';
/**
 * Receipt verification: resolving the token printed in a receipt's QR code.
 *
 * This is the single customer-facing counterpart of utils/receipt.js. It answers
 * one question: "does this receipt exist, and is it still valid?": about ONE
 * offering, identified by its verification token.
 *
 * It is deliberately NOT the audit-chain check. That verifies the day's
 * tamper-evident log as a whole, is admin-only, and lives in
 * routes/reports.js (`GET /api/reports/audit/verify`), with its own admin
 * screen. Mixing the two would mean a member scanning a receipt could read
 * whether the church's books have been altered, and would tie a printed QR code
 * to a day rather than to a transaction.
 *
 * What the public page may show is capped on purpose: receipt number, dates, the
 * service and offering type, the amount, how the gift was paid, and the church.
 * Never the giver's name or phone (even though the receipt the member holds
 * carries it), never the staff member who recorded it, and never the internal
 * offering id.
 */
const pool = require('../db/pg');
const { translator, normalizeLocale, enumLabel } = require('../i18n');
const { CHURCH_NAME, CHURCH_ADDRESS } = require('./brand');
const { escapeHtml, formatAmount, formatDate, formatDateTime, logoDataUri } = require('./receipt');
const { isVerificationToken } = require('./verificationToken');

const ACTIVE = 'active';
const REVOKED = 'revoked';
const NOT_FOUND = 'not_found';

/**
 * The verification status of one receipt row.
 *
 * A voided offering is revoked by definition: voiding is how a mistaken entry is
 * taken out of the ledger (see routes/offerings.js), and a receipt that no longer
 * matches any live record must not keep verifying as valid. An explicit
 * `verification_status = 'revoked'` is the separate, softer case: a receipt
 * invalidated for its own reasons while the ledger entry itself still stands.
 */
function verificationStatusFor(row) {
  if (row.voided_at) return REVOKED;
  if (row.verification_status === REVOKED) return REVOKED;
  return ACTIVE;
}

/** Why a revoked receipt was revoked, phrased without leaking anything else. */
function revocationReasonFor(row) {
  return row.verification_revocation_reason || row.void_reason || null;
}

/**
 * Looks a receipt up by its token, joined to everything the reply needs.
 *
 * The donor columns are not selected at all rather than selected and hidden:
 * what is not read cannot be leaked by a later edit.
 */
async function findReceiptByToken(token) {
  if (!isVerificationToken(token)) return null;
  const { rows } = await pool.query(
    `SELECT o.id, o.amount, o.currency, o.payment_method, o.payment_reference, o.receipt_number, o.timestamp,
            o.verification_token, o.verification_status, o.verification_revoked_at,
            o.verification_revocation_reason, o.voided_at, o.void_reason,
            oc.key AS category_key, oc.name AS category_name,
            s.name AS service_name, s.date AS service_date
     FROM offerings o
     JOIN services s ON s.id = o.service_id
     LEFT JOIN offering_categories oc ON oc.id = o.category_id
     WHERE o.verification_token = $1`,
    [token]
  );
  return rows[0] || null;
}

/**
 * The public view of one receipt, already phrased in the reader's language.
 *
 * How the gift was paid belongs here: it is a fact about the transaction, and
 * the reference (a mobile-money code, a bank slip number) is printed on the very
 * paper being scanned, so showing it back cannot disclose anything the reader
 * does not already hold. That is exactly why the giver's name and phone are NOT
 * selected by findReceiptByToken at all, while these two columns are.
 *
 * The receipt number stays the transaction's identity, as it always was: it is
 * allocated once per gift, printed on the paper and quoted by the audit entries.
 * The payment reference is a different thing: how the money moved, not a
 * second identifier for the gift.
 */
function publicReceiptView(row, locale) {
  const t = translator(locale);
  const status = verificationStatusFor(row);
  return {
    status,
    verified: status === ACTIVE,
    receiptNumber: row.receipt_number,
    date: row.service_date,
    dateLabel: formatDate(row.service_date, locale),
    recordedAt: row.timestamp || null,
    recordedAtLabel: formatDateTime(row.timestamp, locale) || null,
    service: row.service_name || null,
    // A category row that was retired still names the gift honestly through its
    // stored key's label rather than showing a blank.
    offeringType: row.category_name || row.category_key || t('receipt.fallbackCategory'),
    // Both null for an offering recorded without them (or before this existed),
    // which the page renders as "no such row" rather than as an empty claim.
    paymentMethod: row.payment_method ? enumLabel(t, 'payment.method_', row.payment_method) : null,
    paymentReference: row.payment_reference || null,
    amount: row.amount,
    currency: row.currency,
    amountLabel: formatAmount(row.amount, row.currency, locale),
    church: CHURCH_NAME,
    reason: status === REVOKED ? revocationReasonFor(row) : null,
    voided: !!row.voided_at,
  };
}

/** The JSON body of GET /api/verify/receipt/:token. */
function receiptVerificationResult(row, locale) {
  if (!row) {
    return {
      verified: false,
      status: NOT_FOUND,
      error: 'errors.receiptVerificationNotFound',
      receipt: null,
    };
  }
  const receipt = publicReceiptView(row, locale);
  return { verified: receipt.verified, status: receipt.status, receipt };
}

function statusBanner(status, t) {
  if (status === ACTIVE) {
    return { className: 'ok', mark: '✓', title: t('verify.verified'), message: t('verify.verifiedMessage', { church: CHURCH_NAME }) };
  }
  if (status === REVOKED) {
    return { className: 'bad', mark: '✕', title: t('verify.revoked'), message: t('verify.revokedMessage') };
  }
  return { className: 'unknown', mark: '?', title: t('verify.notFound'), message: t('verify.notFoundMessage') };
}

function rowHtml(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`;
}

/**
 * The page a member sees after scanning a receipt.
 *
 * Server-rendered, with no JavaScript and no API call: it has to work in
 * whichever browser app the scan opens, on a phone, possibly on a poor
 * connection at church. It follows the reader like every other generated
 * document (see middleware/locale.js), and it carries `noindex` so a
 * verification URL a member shares is never crawled into a search result.
 */
function renderVerificationPage(result, locale) {
  const t = translator(locale);
  const banner = statusBanner(result.status, t);
  const receipt = result.receipt;
  const logo = logoDataUri();

  const rows = receipt
    ? [
        rowHtml(t('verify.receiptNumber'), receipt.receiptNumber),
        rowHtml(t('verify.date'), receipt.dateLabel),
        rowHtml(t('verify.recordedAt'), receipt.recordedAtLabel),
        rowHtml(t('verify.service'), receipt.service),
        rowHtml(t('verify.offering'), receipt.offeringType),
        rowHtml(t('verify.payment'), receipt.paymentMethod),
        rowHtml(t('verify.reference'), receipt.paymentReference),
        `<div class="row amount"><span class="label">${escapeHtml(t('verify.amount'))}</span><span class="value">${escapeHtml(receipt.amountLabel)}</span></div>`,
        rowHtml(t('verify.church'), receipt.church),
        receipt.status === REVOKED ? rowHtml(t('verify.reason'), receipt.reason) : '',
      ].join('')
    : '';

  return `<!doctype html>
<html lang="${normalizeLocale(locale)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(`${t('verify.pageTitle')}, ${receipt ? receipt.receiptNumber : banner.title}`)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #201E1A; margin: 0; padding: 24px 16px 40px; background: #F6F2E9; -webkit-text-size-adjust: 100%; }
  .card { max-width: 520px; margin: 0 auto; background: #FDFBF6; border: 1px solid #E7E0CE; border-top: 6px solid #69B201; border-bottom: 6px solid #A70210; padding: 28px 24px 24px; }
  .logo { text-align: center; margin-bottom: 8px; }
  .logo img { width: 68px; height: auto; }
  h1 { font-size: 21px; margin: 0 0 2px; letter-spacing: 1px; text-align: center; }
  .sub { color: #78716c; font-size: 11px; text-transform: uppercase; letter-spacing: 2px; margin: 0 0 20px; text-align: center; }
  .banner { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-radius: 6px; border: 1px solid; margin-bottom: 18px; }
  .banner .mark { font-size: 18px; line-height: 1.3; font-weight: bold; }
  .banner h2 { font-size: 16px; margin: 0 0 2px; }
  .banner p { font-size: 13px; margin: 0; }
  .banner.ok { border-color: #69B201; background: #F1F8E6; color: #2F5A05; }
  .banner.bad { border-color: #A70210; background: #FCEFEF; color: #8A0110; }
  .banner.unknown { border-color: #C9C2B2; background: #F4F1EA; color: #57534e; }
  .rule { border-top: 1px solid #E7E0CE; margin: 16px 0; }
  .row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 14px; border-bottom: 1px dotted #EDE7D8; }
  .row:last-child { border-bottom: 0; }
  .row .label { color: #57534e; flex: none; }
  .row .value { font-weight: bold; text-align: right; word-break: break-word; }
  .row.amount .value { color: #A70210; font-size: 19px; }
  .footer { margin-top: 22px; font-size: 11px; color: #78716c; text-align: center; }
  .footer p { margin: 4px 0; }
</style>
</head>
<body>
  <div class="card">
    ${logo ? `<div class="logo"><img src="${logo}" alt="${escapeHtml(CHURCH_NAME)} logo" /></div>` : ''}
    <h1>${escapeHtml(CHURCH_NAME)}</h1>
    <p class="sub">${escapeHtml(t('verify.subtitle'))}</p>

    <div class="banner ${banner.className}" role="status">
      <span class="mark" aria-hidden="true">${banner.mark}</span>
      <div>
        <h2>${escapeHtml(banner.title)}</h2>
        <p>${escapeHtml(receipt && receipt.status === REVOKED && receipt.voided ? t('verify.revokedVoidedMessage') : banner.message)}</p>
      </div>
    </div>

    ${receipt ? `<div class="rule"></div>${rows}` : ''}

    <div class="footer">
      <p>${escapeHtml(t('verify.footer'))}</p>
      <p>${escapeHtml(CHURCH_NAME)} · ${escapeHtml(CHURCH_ADDRESS)}</p>
    </div>
  </div>
</body>
</html>`;
}

module.exports = {
  ACTIVE,
  REVOKED,
  NOT_FOUND,
  verificationStatusFor,
  revocationReasonFor,
  findReceiptByToken,
  publicReceiptView,
  receiptVerificationResult,
  renderVerificationPage,
};
