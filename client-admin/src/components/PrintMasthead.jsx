import { CHURCH_NAME, CHURCH_ADDRESS, DEFAULT_CURRENCY } from '../i18n/common';
import { formatDate } from '../format';

/*
 * The printed day record's letterhead (index.css prints it; on screen
 * .print-only keeps it invisible). This exists only for the paper the
 * front desk signs and files, so a sheet identifies itself months
 * later: church name and address, what the document is, the day it
 * covers, and the totals the two tables below it add up to.
 *
 * Church name and address are locale-independent constants (see
 * i18n/common.js); every other word comes from the catalogs.
 */
export default function PrintMasthead({ date, lang, people = 0, offeringsTotal = [], t }) {
  // Same shape the screen uses for the offerings heading: a Map-derived
  // list of [currency, total], biggest first, joined for multi-currency days.
  const money =
    offeringsTotal.map(([currency, sum]) => `${sum.toLocaleString()} ${currency}`).join(' · ') ||
    `0 ${DEFAULT_CURRENCY}`;

  return (
    <div className="print-only print-masthead">
      <div className="print-masthead-rule" aria-hidden="true" />
      <p className="print-masthead-church">{CHURCH_NAME}</p>
      <p className="print-masthead-address">{CHURCH_ADDRESS}</p>
      <div className="print-masthead-rule print-masthead-rule-thin" aria-hidden="true" />

      <div className="print-masthead-head">
        <p className="print-masthead-title">{t('receptionist.dayRecordTitle')}</p>
        <p className="print-masthead-date">{date ? formatDate(date, lang) : ''}</p>
      </div>

      <dl className="print-masthead-totals">
        <div className="print-masthead-stat">
          <dt>{t('receptionist.attendanceTitle')}</dt>
          <dd>
            {people.toLocaleString()} {t('receptionist.people')}
          </dd>
        </div>
        <div className="print-masthead-stat">
          <dt>{t('receptionist.offeringsTitle')}</dt>
          <dd>{money}</dd>
        </div>
      </dl>
      <div className="print-masthead-rule print-masthead-rule-thin" aria-hidden="true" />
    </div>
  );
}
