'use strict';
/**
 * How a gift was paid, and the reference the desk wrote down beside it.
 *
 * A payment method is a closed, four-value vocabulary, cash, mobile money, bank
 * or cheque, rather than free text, for the same reason a service type's kind
 * is: every method has to be LABELLED, in both languages, on a receipt a church
 * member reads and in the reports a treasurer runs. Free text would print
 * whatever the desk typed ("mpesa", "M-PESA", "simu") and translate to nothing.
 *
 * It is deliberately NOT a second transaction record. There is no payments table
 * and no payment id: the offering IS the transaction and its receipt_number is
 * the reference the audit entries quote, so these two columns only record how
 * the money arrived and what number came with it.
 *
 * NULL means "not recorded", never "cash". Every offering recorded before this
 * feature exists genuinely has no method on file, and defaulting those rows to
 * cash would invent money-handling data the church never entered (the same
 * reasoning as a zone leader's missing role_name in db/schema.sql).
 */

/** The methods the church records. The labels live in the catalogs under
 *  `payment.method_*` (see utils/receipt.js), so a stored key is never printed
 *  raw: the enum sweep in test/generated-text-i18n.test.js enforces that. */
const PAYMENT_METHODS = ['cash', 'mobile_money', 'bank', 'cheque'];

/**
 * The longest reference stored. A mobile-money code or a bank slip number is a
 * dozen characters; the cap exists so a pasted paragraph cannot become a line on
 * a printed receipt (whose layout has no room for one) or a report cell.
 */
const PAYMENT_REFERENCE_MAX = 64;

/**
 * The stored key for a value from a request. Three outcomes, kept apart on
 * purpose because two of them are errors and one is not:
 *
 *   a key     -> store it
 *   null      -> nothing was chosen; a legitimate "not recorded"
 *   undefined -> something that is not one of ours; the caller must reject it
 *                rather than store it, so it can never reach a report as an
 *                unlabelled bucket nobody can explain
 */
function normalizePaymentMethod(value) {
  if (value === undefined || value === null || value === '') return null;
  const key = String(value).trim().toLowerCase();
  return PAYMENT_METHODS.includes(key) ? key : undefined;
}

/** The reference as stored: trimmed, inner whitespace collapsed, '' -> null. */
function normalizePaymentReference(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

module.exports = {
  PAYMENT_METHODS,
  PAYMENT_REFERENCE_MAX,
  normalizePaymentMethod,
  normalizePaymentReference,
};
