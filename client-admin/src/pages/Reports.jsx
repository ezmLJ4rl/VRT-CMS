import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Users, CalendarDays, Gift, Landmark, X } from 'lucide-react';
import api, { apiErrorMessage, API_BASE } from '../api';
import AppShell from '../components/AppShell';
import DataTable from '../components/DataTable';
import StatusBanner from '../components/StatusBanner';
import BarChart from '../components/BarChart';
import ServiceTrendGrid from '../components/ServiceTrendGrid';
import { paymentMethodLabel } from '../paymentMethods';
import { EMPTY_VALUE } from '../emptyValue';
import MemberLink from '../components/MemberLink';

function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// The Reports breakdowns ride the one shared table pattern: this wrapper
// only adds what Reports specifically needs: whole-row drill-down clicks and
// the label column emphasised.
function dataTable(rows, columns, drillable, onDrill) {
  return (
    <div className="mt-3 rounded-lg border border-ink-100 p-3">
      <DataTable
        columns={columns.map((c) => ({
          key: c.key,
          header: c.label,
          width: c.width,
          align: c.align,
          render: (r) => (
            <span
              className={[
                c.align === 'right' ? 'tabular-nums text-ink-600' : '',
                c.key === 'label' ? 'font-medium text-ink-900' : 'text-ink-600',
              ].join(' ')}
            >
              {c.format ? c.format(r[c.key]) : (r[c.key] ?? EMPTY_VALUE)}
            </span>
          ),
        }))}
        rows={rows}
        keyOf={(_r, i) => i}
        rowClassName={(r) => (drillable && drillable(r) ? 'cursor-pointer hover:bg-ink-50' : '')}
        onRowClick={drillable ? (r) => { const target = drillable(r); if (target) onDrill(target); } : undefined}
        empty={<p className="py-4 text-center text-sm text-ink-400">{EMPTY_VALUE}</p>}
      />
    </div>
  );
}

export default function Reports() {
  const { t } = useTranslation();
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  });
  const [to, setTo] = useState(todayISO());
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);
  const [breakdowns, setBreakdowns] = useState({});
  const [serviceTrends, setServiceTrends] = useState([]);
  const [loading, setLoading] = useState(false);
  const [drill, setDrill] = useState(null);
  const [drillData, setDrillData] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);

  useEffect(() => {
    if (!from || !to || from > to) return;
    setLoading(true);
    setError('');
    Promise.all([
      api.get('/reports/summary', { params: { from, to } }),
      ...['service', 'center', 'group', 'category', 'payment', 'day'].map((gb) => api.get('/reports/breakdown', { params: { from, to, groupBy: gb } })),
      api.get('/reports/service-trends', { params: { from, to } }).catch(() => ({ data: { services: [] } })),
    ])
      .then(([s, service, center, group, category, payment, day, serviceTrend]) => {
        setSummary(s.data);
        setServiceTrends(serviceTrend.data.services || []);
        setBreakdowns({
          service: service.data.breakdown,
          // Rehearsals arrive with the service response, already separated.
          rehearsals: service.data.rehearsals || [],
          center: center.data.breakdown,
          group: group.data.breakdown,
          category: category.data.breakdown,
          payment: payment.data.breakdown,
          day: day.data.breakdown,
        });
      })
      .catch((err) => setError(apiErrorMessage(err)))
      .finally(() => setLoading(false));
  }, [from, to]);

  function drillTarget(groupBy) {
    return (r) => {
      if (r.key == null) return null;
      let params;
      if (groupBy === 'service') params = { serviceTypeId: r.key };
      else if (groupBy === 'center') params = { centerId: r.key };
      else if (groupBy === 'group') params = { groupId: r.key };
      else if (groupBy === 'category') params = { category: r.key };
      else if (groupBy === 'payment') params = { paymentMethod: r.key };
      else params = { from: r.key, to: r.key };
      return { label: r.label, params };
    };
  }

  function openDrill(target) {
    setDrill(target);
    setDrillLoading(true);
    setError('');
    Promise.all([
      api.get('/attendance', { params: { from, to, ...target.params } }),
      api.get('/offerings', { params: { from, to, ...target.params } }),
    ])
      .then(([a, o]) => setDrillData({ attendance: a.data.attendance, offerings: o.data.offerings }))
      .catch((err) => setError(apiErrorMessage(err)))
      .finally(() => setDrillLoading(false));
  }

  const money = useMemo(() => new Intl.NumberFormat('en-TZ', { style: 'currency', currency: 'TZS', maximumFractionDigits: 0 }), []);

  /**
   * Names the "no centre / no group" bucket.
   *
   * Attendance is not always filed under a centre or a group (it is optional on
   * the front desk), and those rows come back with a null label. A null label
   * rendered a legend entry as a bare colour dot beside the real ones, "● ● CAs
   * (Vijana)", and an unlabelled bar on the axis. Saying "Not recorded" makes
   * both the chart and its legend read correctly, and tells the reader what that
   * bar actually is. Applied at render (not when the response lands) so it
   * follows a language change too.
   */
  function labelRows(rows) {
    return (rows || []).map((r) => (r.label ? r : { ...r, label: t('reports.unassigned') }));
  }

  /**
   * The payment breakdown comes back keyed by the STORED value, not by a label:
   * the server has no interface language of its own, and the reader's is chosen
   * here. A null key is money whose method nobody recorded: named honestly
   * rather than folded into cash, which is what a default would have done (see
   * server/utils/payments.js).
   */
  function paymentRows(rows) {
    return (rows || []).map((r) => ({
      ...r,
      label: r.key ? paymentMethodLabel(t, r.key) : t('reports.unassigned'),
    }));
  }

  function download(kind) {
    setError('');
    const token = localStorage.getItem('vrt_token');
    const url = `${API_BASE}/reports/${kind}.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => (res.ok ? res.blob() : res.json().then((b) => Promise.reject(new Error(b?.error || t('common.error'))))))
      .then((blob) => {
        const link = document.createElement('a');
        link.href = window.URL.createObjectURL(blob);
        link.download = `${kind}_${from}_${to}.csv`;
        link.click();
        window.URL.revokeObjectURL(link.href);
      })
      .catch((err) => setError(err.message || t('common.error')));
  }

  const stats = [
    { icon: CalendarDays, label: t('reports.sessions'), value: summary ? summary.attendance.sessions : null, chip: 'category-people' },
    { icon: Users, label: t('reports.peopleAttend'), value: summary ? summary.attendance.people : null, chip: 'category-people' },
    { icon: Gift, label: t('reports.gifts'), value: summary ? summary.offerings.gifts : null, chip: 'category-offering' },
    { icon: Landmark, label: t('reports.sacrifices'), value: summary ? money.format(summary.offerings.total) : null, chip: 'category-offering' },
  ];

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-semibold">{t('reports.title')}</h1>
      <p className="mb-5 text-sm text-ink-400">{t('reports.subtitle')}</p>

      {error && (
        <div className="mb-5">
          <StatusBanner type="error" message={error} />
        </div>
      )}

      <div className="mb-6 flex flex-col gap-3 rounded-xl border border-ink-200 bg-paper p-5 shadow-sm sm:flex-row sm:items-end">
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="from">{t('reports.from')}</label>
          <input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="to">{t('reports.to')}</label>
          <input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
        </div>
        <div className="flex gap-2 sm:ml-auto">
          <button onClick={() => download('offerings')} className="btn btn-ink">
            <Download size={15} /> {t('reports.exportOfferings')}
          </button>
          <button onClick={() => download('attendance')} className="btn btn-ink">
            <Download size={15} /> {t('reports.exportAttendance')}
          </button>
        </div>
      </div>

      {loading && <p className="mb-5 text-sm text-ink-400">{t('common.loading')}</p>}

      {summary && !loading && (
        <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className={`rounded-xl border border-ink-200 bg-paper p-4 shadow-sm`}>
              <div className="flex items-center gap-2 text-sm font-medium text-ink-500">
                <s.icon size={15} /> {s.label}
              </div>
              <div className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink-900">{s.value ?? EMPTY_VALUE}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm lg:col-span-2">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="font-display font-semibold text-brand-900">{t('reports.byService')}</h2>
              <p className="mt-1 text-xs text-ink-400">{t('reports.serviceTrendSubtitle')}</p>
            </div>
            <span className="rounded-full bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-500">{from} – {to}</span>
          </div>
          <ServiceTrendGrid services={serviceTrends} />
        </section>

        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-1 font-display font-semibold text-brand-900">{t('reports.rehearsalsTitle')}</h2>
          <p className="mb-4 text-xs text-ink-400">{t('reports.rehearsalsNote')}</p>
          {/* Rehearsals record attendance only, so a simple ranked list is more
              honest and easier to scan than a money-style chart. */}
          {dataTable(labelRows(breakdowns.rehearsals), [
            { key: 'label', label: t('reports.rehearsalsTitle') },
            { key: 'sessions', label: t('reports.sessions'), align: 'right' },
            { key: 'attendance', label: t('reports.peopleAttend'), align: 'right' },
          ], drillTarget('service'), openDrill)}
        </section>

        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display font-semibold text-brand-900">{t('reports.byCategory')}</h2>
          <BarChart data={labelRows(breakdowns.category)} tone="offering" valueKey="amount" name={t('reports.offeringsHeader')} format={(v) => money.format(v)} />
          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-medium text-brand-800 hover:underline">{t('reports.viewTable')}</summary>
            {dataTable(labelRows(breakdowns.category), [
              { key: 'label', label: t('reports.byCategory') },
              { key: 'gifts', label: t('reports.gifts'), align: 'right' },
              { key: 'amount', label: t('reports.sacrifices'), align: 'right', format: money.format },
            ], drillTarget('category'), openDrill)}
          </details>
        </section>

        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-1 font-display font-semibold text-brand-900">{t('reports.byPayment')}</h2>
          <p className="mb-4 text-xs text-ink-400">{t('reports.byPaymentNote')}</p>
          <BarChart data={paymentRows(breakdowns.payment)} tone="offering" valueKey="amount" name={t('reports.sacrifices')} format={(v) => money.format(v)} />
          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-medium text-brand-800 hover:underline">{t('reports.viewTable')}</summary>
            {dataTable(paymentRows(breakdowns.payment), [
              { key: 'label', label: t('reports.byPayment') },
              { key: 'gifts', label: t('reports.gifts'), align: 'right' },
              { key: 'amount', label: t('reports.sacrifices'), align: 'right', format: money.format },
            ], drillTarget('payment'), openDrill)}
          </details>
        </section>

        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display font-semibold text-brand-900">{t('reports.byCenter')}</h2>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('reports.attendByCenter')}</h3>
          <BarChart data={labelRows(breakdowns.center)} tone="people" valueKey="attendance" name={t('reports.peopleAttend')} />
          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('reports.offerByCenter')}</h3>
          <BarChart data={labelRows(breakdowns.center)} tone="offering" valueKey="offering" name={t('reports.offeringsHeader')} format={(v) => money.format(v)} />
          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-medium text-brand-800 hover:underline">{t('reports.viewTable')}</summary>
            {dataTable(labelRows(breakdowns.center), [
              { key: 'label', label: t('reports.byCenter') },
              { key: 'sessions', label: t('reports.sessions'), align: 'right' },
              { key: 'attendance', label: t('reports.peopleAttend'), align: 'right' },
              { key: 'gifts', label: t('reports.gifts'), align: 'right' },
              { key: 'offering', label: t('reports.offeringsHeader'), align: 'right', format: money.format },
            ], drillTarget('center'), openDrill)}
          </details>
        </section>

        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display font-semibold text-brand-900">{t('reports.byGroup')}</h2>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('reports.attendByGroup')}</h3>
          <BarChart data={labelRows(breakdowns.group)} tone="people" valueKey="attendance" name={t('reports.peopleAttend')} />
          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('reports.offerByGroup')}</h3>
          <BarChart data={labelRows(breakdowns.group)} tone="offering" valueKey="offering" name={t('reports.offeringsHeader')} format={(v) => money.format(v)} />
          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-medium text-brand-800 hover:underline">{t('reports.viewTable')}</summary>
            {dataTable(labelRows(breakdowns.group), [
              { key: 'label', label: t('reports.byGroup') },
              { key: 'sessions', label: t('reports.sessions'), align: 'right' },
              { key: 'attendance', label: t('reports.peopleAttend'), align: 'right' },
              { key: 'gifts', label: t('reports.gifts'), align: 'right' },
              { key: 'offering', label: t('reports.offeringsHeader'), align: 'right', format: money.format },
            ], drillTarget('group'), openDrill)}
          </details>
        </section>

        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm lg:col-span-2">
          <h2 className="mb-4 font-display font-semibold text-brand-900">{t('reports.activityPerDay')}</h2>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('reports.attendPerDay')}</h3>
          <BarChart data={labelRows(breakdowns.day)} tone="people" valueKey="attendance" name={t('reports.peopleAttend')} />
          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('reports.offerPerDay')}</h3>
          <BarChart data={labelRows(breakdowns.day)} tone="offering" valueKey="offering" name={t('reports.offeringsHeader')} format={(v) => money.format(v)} />
          <details className="mt-4">
            <summary className="cursor-pointer text-xs font-medium text-brand-800 hover:underline">{t('reports.viewTable')}</summary>
            {dataTable(labelRows(breakdowns.day), [
              { key: 'label', label: t('reports.activityPerDay') },
              { key: 'sessions', label: t('reports.sessions'), align: 'right' },
              { key: 'attendance', label: t('reports.peopleAttend'), align: 'right' },
              { key: 'gifts', label: t('reports.gifts'), align: 'right' },
              { key: 'offering', label: t('reports.offeringsHeader'), align: 'right', format: money.format },
            ], drillTarget('day'), openDrill)}
          </details>
        </section>
      </div>

      {drill && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink-900/50 p-4 pt-16" onClick={() => setDrill(null)}>
          <div className="w-full max-w-3xl rounded-xl bg-paper shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-5 py-4">
              <div>
                <h2 className="font-display text-lg font-semibold text-ink-900">{t('reports.drillRecords')}</h2>
                <p className="text-sm text-ink-400">{drill.label}</p>
              </div>
              <button onClick={() => setDrill(null)} className="rounded-md p-1.5 text-ink-400 hover:bg-ink-100 hover:text-ink-700" aria-label={t('reports.drillClose')}>
                <X size={18} />
              </button>
            </div>
            <div className="max-h-[65vh] overflow-y-auto p-5">
              {drillLoading && <p className="text-sm text-ink-400">{t('common.loading')}</p>}
              {drillData && (
                <>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-people-700">{t('reports.drillAttendance')}</h3>
                  {drillData.attendance.length === 0 ? (
                    <p className="mb-5 text-sm text-ink-400">{t('reports.drillEmpty')}</p>
                  ) : (
                    <div className="mb-5 rounded-lg border border-ink-100 p-3">
                      <DataTable
                        columns={[
                          { key: 'date', header: t('reports.drillDate'), width: 15, render: (r) => <span className="text-ink-600">{r.date}</span> },
                          { key: 'service', header: t('reports.byService'), render: (r) => <span className="font-medium text-ink-900">{r.service_type_name || r.service_name}</span> },
                          { key: 'total', header: t('reports.peopleAttend'), width: 12, align: 'right', cardValue: true, render: (r) => <span className="tabular-nums text-ink-600">{r.total}</span> },
                          { key: 'attendees', header: t('reports.drillAttendees'), width: 30, render: (r) => <span className="text-ink-600">{(r.attendees || []).slice(0, 4).join(', ')}{(r.attendees || []).length > 4 ? '…' : ''}</span> },
                        ]}
                        rows={drillData.attendance}
                        keyOf={(r) => r.id}
                        empty={null}
                      />
                    </div>
                  )}
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-offering-700">{t('reports.drillOfferings')}</h3>
                  {drillData.offerings.length === 0 ? (
                    <p className="text-sm text-ink-400">{t('reports.drillEmpty')}</p>
                  ) : (
                    <div className="rounded-lg border border-ink-100 p-3">
                      <DataTable
                        columns={[
                          { key: 'date', header: t('reports.drillDate'), width: 13, render: (r) => <span className="text-ink-600">{r.service_date}</span> },
                          { key: 'service', header: t('reports.byService'), render: (r) => <span className="font-medium text-ink-900">{r.service_type_name || r.service_name}</span> },
                          { key: 'category', header: t('reports.byCategory'), width: 15, render: (r) => <span className="text-ink-600">{r.category_name || r.category_key}</span> },
                          {
                            key: 'amount',
                            header: t('reports.sacrifices'),
                            width: 13,
                            align: 'right',
                            cardValue: true,
                            render: (r) => <span className="tabular-nums text-ink-900">{money.format(r.amount)}{r.currency && r.currency !== 'TZS' ? ` ${r.currency}` : ''}</span>,
                          },
                          { key: 'payment', header: t('reports.drillPayment'), width: 15, render: (r) => <span className="text-ink-600">{r.payment_method ? paymentMethodLabel(t, r.payment_method) : t('reports.unassigned')}</span> },
                          { key: 'giver', header: t('reports.drillGiver'), width: 15, render: (r) => (
                            r.member_id || r.memberId
                              ? <MemberLink memberId={r.member_id || r.memberId}>{r.offererName || EMPTY_VALUE}</MemberLink>
                              : <span className="text-ink-600">{r.offererName || EMPTY_VALUE}</span>
                          ) },
                          { key: 'receipt', header: t('reports.drillReceipt'), width: 14, render: (r) => <span className="text-ink-600">{r.receipt_number || EMPTY_VALUE}</span> },
                        ]}
                        rows={drillData.offerings}
                        keyOf={(r) => r.id}
                        empty={null}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}