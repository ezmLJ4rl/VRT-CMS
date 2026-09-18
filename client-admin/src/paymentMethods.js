/*
 * How a gift was paid: the admin app's copy of the server's closed vocabulary
 * (see server/utils/payments.js).
 *
 * The four keys are what the database stores. The labels are spelled out here as
 * literal `t('payment.…')` calls rather than assembled from the key, so the
 * catalog sweep (i18n/catalogCoverage.test.js) can see every label a reader can
 * be shown: the same reason Receipts.jsx spells out its status labels.
 *
 * An unknown key returns the key itself. That should be impossible (the server
 * refuses anything that is not one of the four), but a value this build cannot
 * name is better shown plainly than silently rendered as something it is not.
 */
export const PAYMENT_METHODS = ['cash', 'mobile_money', 'bank', 'cheque'];

/** The reference is a code (a mobile-money confirmation, a bank slip, a cheque
 *  number): 64 characters is the server's limit, shared so the input cannot
 *  offer more room than the API accepts. */
export const PAYMENT_REFERENCE_MAX = 64;

/** Cash is the one method that has no number to write down. */
export function methodHasReference(method) {
  return method !== '' && method !== 'cash';
}

export function paymentMethodLabel(t, key) {
  if (key === 'cash') return t('payment.cash');
  if (key === 'mobile_money') return t('payment.mobile_money');
  if (key === 'bank') return t('payment.bank');
  if (key === 'cheque') return t('payment.cheque');
  return key;
}
