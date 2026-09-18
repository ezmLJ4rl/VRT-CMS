import { useTranslation } from 'react-i18next';
import { HandCoins } from 'lucide-react';
import { NOT_RECORDED, paymentMethodLabel, summarizeByPayment } from '../paymentMethods';
import { formatMoney } from '../format';

/**
 * How the period's giving came in: cash, mobile money, bank or cheque.
 *
 * Deliberately aggregate-only. The offerings this is built from each carry a
 * payment reference (a mobile-money code, a bank slip number) and, for the
 * named categories, the giver's name; none of that is rendered here. The pastor
 * asked how the money arrived, and the answer to that question is a set of
 * totals: showing one gift's reference beside a giver's name would be a
 * reconciliation detail with an identity attached to it.
 *
 * Read from the rows the screen already loaded, so the figures cannot disagree
 * with the totals in the header of the same screen, and the screen's own service
 * and date filters apply here as they do everywhere else on it.
 */
export default function GivingByPayment({ offerings }) {
  const { t } = useTranslation();
  const rows = summarizeByPayment(offerings);

  return (
    <section className="tile col-span-12 p-4">
      <h2 className="flex items-center gap-1.5 font-display text-base font-semibold">
        <HandCoins size={15} className="text-offering-600" aria-hidden="true" /> {t('records.givingByPayment')}
      </h2>
      <p className="mb-1 mt-0.5 text-xs text-ink-400">{t('records.givingByPaymentNote')}</p>
      {rows.length === 0 ? (
        <p className="p-4 text-center text-sm text-ink-400">{t('records.noOfferingsInPeriod')}</p>
      ) : (
        <ul className="divide-y divide-ink-100">
          {rows.map((row) => (
            <li key={row.key || 'not-recorded'} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink-900">
                  {row.key === NOT_RECORDED ? t('payment.notRecorded') : paymentMethodLabel(t, row.key)}
                </span>
                <span className="mt-0.5 block text-xs text-ink-400">{t('records.giftCount', { count: row.gifts })}</span>
              </span>
              <span className="shrink-0 text-right font-display text-lg font-semibold tabular-nums text-offering-700">
                {row.amounts.map((a) => formatMoney(a.total, a.currency)).join(' + ')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
