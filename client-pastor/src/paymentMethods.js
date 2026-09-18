/*
 * How a gift was paid: the pastor app's copy of the server's closed vocabulary
 * (see server/utils/payments.js).
 *
 * The four keys are what the database stores. The labels are spelled out here as
 * literal `t('payment.…')` calls rather than assembled from the key, so the
 * catalog sweep (i18n/catalogCoverage.test.js) can see every label a reader can
 * be shown.
 *
 * Cash is first and the order is fixed rather than sorted by amount: the pastor
 * compares today's split against last month's, and a list whose order moves with
 * the money makes that comparison read as a change that did not happen.
 */
export const PAYMENT_METHODS = ['cash', 'mobile_money', 'bank', 'cheque'];

/** A gift whose method the desk left blank. Not cash, and never folded into
 *  cash: offerings recorded before the desk started noting the method have no
 *  method on file, and reporting them as cash would invent money-handling data
 *  the church never entered (the same reason the server stores NULL). */
export const NOT_RECORDED = '';

/** An unknown key returns the key itself. The server refuses anything that is
 *  not one of the four, so this should be impossible, but a value this build
 *  cannot name is better shown plainly than silently rendered as something it
 *  is not, and it is kept as its own row rather than merged into "not
 *  recorded", which would claim nobody recorded a method that WAS recorded. */
export function paymentMethodLabel(t, key) {
  if (key === 'cash') return t('payment.cash');
  if (key === 'mobile_money') return t('payment.mobile_money');
  if (key === 'bank') return t('payment.bank');
  if (key === 'cheque') return t('payment.cheque');
  return key;
}

/**
 * Giving for a period, split by how it came in.
 *
 * The pastor's view of money is aggregate: how much arrived by cash, mobile
 * money, bank or cheque, never a single gift's payment reference, and never the
 * giver behind it. Taking the flat offering rows (already voided-filtered and
 * already narrowed by the screen's own service and date filters) keeps this
 * figure consistent with the totals on the same screen, which a separate
 * server-side call could quietly contradict.
 *
 * Amounts are summed per currency and kept apart: the church banks in TZS and
 * occasionally receives USD, and adding them into one number would be a total
 * that means nothing.
 */
export function summarizeByPayment(offerings) {
  const buckets = new Map();
  for (const row of offerings || []) {
    const key = row?.payment_method ? String(row.payment_method) : NOT_RECORDED;
    if (!buckets.has(key)) buckets.set(key, { key, gifts: 0, byCurrency: new Map() });
    const bucket = buckets.get(key);
    const currency = row.currency || 'TZS';
    bucket.gifts += 1;
    bucket.byCurrency.set(currency, (bucket.byCurrency.get(currency) || 0) + Number(row.amount || 0));
  }

  const known = PAYMENT_METHODS.filter((key) => buckets.has(key));
  const unknown = [...buckets.keys()].filter((key) => key !== NOT_RECORDED && !PAYMENT_METHODS.includes(key)).sort();
  // "Not recorded" closes the list: it is a gap to notice, not a way of paying.
  const order = [...known, ...unknown, ...(buckets.has(NOT_RECORDED) ? [NOT_RECORDED] : [])];

  return order.map((key) => {
    const bucket = buckets.get(key);
    return {
      key,
      gifts: bucket.gifts,
      amounts: [...bucket.byCurrency.entries()]
        .map(([currency, total]) => ({ currency, total }))
        .sort((a, b) => b.total - a.total || a.currency.localeCompare(b.currency)),
    };
  });
}
