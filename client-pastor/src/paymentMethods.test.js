import { describe, it, expect, afterEach } from 'vitest';

import i18n from './i18n';
import { PAYMENT_METHODS, paymentMethodLabel, summarizeByPayment } from './paymentMethods';

/*
 * The pastor's giving split is only useful if its shape is stable: the same
 * money must produce the same list on every screen and in both languages, and a
 * gap ("nobody recorded how this was paid") must never be read as a way of
 * paying. These tests pin that.
 */
afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('paymentMethodLabel', () => {
  it('labels every method the server can store, in both languages', async () => {
    expect(PAYMENT_METHODS.map((k) => paymentMethodLabel(i18n.t.bind(i18n), k))).toEqual([
      'Cash',
      'Mobile money',
      'Bank transfer',
      'Cheque',
    ]);

    await i18n.changeLanguage('sw');
    expect(PAYMENT_METHODS.map((k) => paymentMethodLabel(i18n.t.bind(i18n), k))).toEqual([
      'Fedha taslimu',
      'Pesa za simu',
      'Benki',
      'Cheki',
    ]);
  });

  it('shows a key it cannot name as itself rather than as another method', () => {
    expect(paymentMethodLabel(i18n.t.bind(i18n), 'crypto')).toBe('crypto');
  });
});

describe('summarizeByPayment', () => {
  const rows = [
    { payment_method: 'cash', amount: 1000, currency: 'TZS' },
    { payment_method: 'mobile_money', amount: 5000, currency: 'TZS' },
    { payment_method: 'cash', amount: 2000, currency: 'TZS' },
  ];

  it('totals each method and counts the gifts behind it', () => {
    const [cash, mobile] = summarizeByPayment(rows);

    expect(cash).toEqual({ key: 'cash', gifts: 2, amounts: [{ currency: 'TZS', total: 3000 }] });
    expect(mobile).toEqual({ key: 'mobile_money', gifts: 1, amounts: [{ currency: 'TZS', total: 5000 }] });
  });

  it('keeps the vocabulary order, so a month reads against a month', () => {
    // The largest gift is mobile money; sorting by amount would move the rows
    // between periods and make the split look like it changed.
    expect(summarizeByPayment(rows).map((r) => r.key)).toEqual(['cash', 'mobile_money']);
  });

  it('leaves out a method nothing came in by, instead of showing a zero', () => {
    const keys = summarizeByPayment(rows).map((r) => r.key);

    expect(keys).not.toContain('bank');
    expect(keys).not.toContain('cheque');
  });

  it('never folds a gift with no recorded method into cash', () => {
    const summary = summarizeByPayment([...rows, { payment_method: null, amount: 700, currency: 'TZS' }]);

    expect(summary.map((r) => r.key)).toEqual(['cash', 'mobile_money', '']);
    expect(summary.find((r) => r.key === 'cash').amounts[0].total).toBe(3000);
    expect(summary.at(-1).gifts).toBe(1);
  });

  it('keeps currencies apart rather than adding shillings to dollars', () => {
    const summary = summarizeByPayment([
      { payment_method: 'bank', amount: 1000000, currency: 'TZS' },
      { payment_method: 'bank', amount: 250, currency: 'USD' },
    ]);

    expect(summary).toEqual([
      { key: 'bank', gifts: 2, amounts: [{ currency: 'TZS', total: 1000000 }, { currency: 'USD', total: 250 }] },
    ]);
  });

  it('gives a method value this build cannot name its own row, not the "not recorded" one', () => {
    const summary = summarizeByPayment([
      { payment_method: 'crypto', amount: 10, currency: 'TZS' },
      { payment_method: null, amount: 20, currency: 'TZS' },
    ]);

    // A recorded-but-unknown method is not the same fact as nobody recording one.
    expect(summary.map((r) => r.key)).toEqual(['crypto', '']);
  });

  it('treats a missing currency as the church\'s own, and a missing amount as zero', () => {
    expect(summarizeByPayment([{ payment_method: 'cash' }])).toEqual([
      { key: 'cash', gifts: 1, amounts: [{ currency: 'TZS', total: 0 }] },
    ]);
  });

  it('says nothing about a period with no gifts', () => {
    expect(summarizeByPayment([])).toEqual([]);
    expect(summarizeByPayment(undefined)).toEqual([]);
  });
});
