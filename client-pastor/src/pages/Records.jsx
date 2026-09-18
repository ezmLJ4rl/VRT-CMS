import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, CalendarDays, ChevronDown, ChevronRight, HandCoins, Users } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import DataTable from '../components/DataTable';
import StatusBanner from '../components/StatusBanner';
import BarChart from '../components/BarChart';
import GivingByPayment from '../components/GivingByPayment';
import { todayISO } from '../dates';
import { formatDate } from '../format';
import { EMPTY_VALUE } from '../emptyValue';
import { attendanceMetrics, attendanceMetricLabel } from '../attendanceMetrics';

// Categories that record gifts by name (they require the giver's full name at
// entry time). These get a collapsible "View names" table in the report; the
// general category is only ever shown as a total.
const NAMED_CATEGORIES = new Set(['zaka', 'thanksgiving', 'special']);

function buildSessions(attendance, offerings) {
  const map = new Map();
  function ensure(id) {
    if (!map.has(id)) map.set(id, { id, attendance: [], offerings: [], name: '', date: '', typeName: '', subSession: '', typeId: null });
    return map.get(id);
  }
  for (const a of attendance) {
    const s = ensure(a.service_id);
    s.attendance.push(a);
    if (!s.name) s.name = a.session_name || '';
    if (!s.date) s.date = a.service_date;
    if (!s.typeName) s.typeName = a.service_type_name || '';
    if (!s.subSession && a.sub_session_name) s.subSession = a.sub_session_name;
    if (!s.typeId) s.typeId = a.service_type_id || null;
    if (!s.eventTitle && a.event_title) s.eventTitle = a.event_title;
    if (!s.eventDescription && a.event_description) s.eventDescription = a.event_description;
  }
  for (const o of offerings) {
    const s = ensure(o.service_id);
    s.offerings.push(o);
    if (!s.name) s.name = o.service_name || '';
    if (!s.date) s.date = o.service_date;
    if (!s.typeName) s.typeName = o.service_type_name || '';
    if (o.service_type_id && !s.typeId) s.typeId = o.service_type_id;
    if (!s.eventTitle && o.event_title) s.eventTitle = o.event_title;
    if (!s.eventDescription && o.event_description) s.eventDescription = o.event_description;
  }
  const list = [...map.values()];
  for (const s of list) {
    s.totalAttendance = s.attendance.reduce((n, r) => n + (r.total || r.count || 0), 0);
    s.label = s.subSession ? `${s.typeName || s.name} · ${s.subSession}` : s.typeName || s.name;
  }
  return list.sort((a, b) => b.date.localeCompare(a.date) || a.label.localeCompare(b.label));
}

function groupOfferings(rows) {
  const map = new Map();
  for (const o of rows) {
    const name = o.category_name || o.category_key || EMPTY_VALUE;
    if (!map.has(name)) map.set(name, { name, key: o.category_key || '', rows: [] });
    map.get(name).rows.push(o);
  }
  return [...map.values()];
}

function OfferingBlock({ t, cat, openName, onToggle }) {
  const needsNames = NAMED_CATEGORIES.has(cat.key);
  const totals = {};
  for (const o of cat.rows) {
    const c = o.currency || 'TZS';
    totals[c] = (totals[c] || 0) + Number(o.amount || 0);
  }
  const sum = Object.entries(totals).map(([c, v]) => `${Number(v).toLocaleString()} ${c}`).join(' + ');
  return (
    <div className="rounded-lg border border-ink-100 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="cat-chip category-offering">{cat.name}</span>
        <span className="text-sm font-semibold tabular-nums text-offering-700">{sum}</span>
      </div>
      {needsNames && cat.rows.length > 0 && (
        <div className="border-t border-ink-100">
          <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-offering-800 hover:bg-offering-50">
            <span className="inline-flex items-center gap-1">
              {openName ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {cat.rows.length} {t('records.namesCount')}
            </span>
            <span className="font-medium text-offering-700">{openName ? t('records.hideNames') : t('records.viewNames')}</span>
          </button>
          {openName && (
            // The one shared table pattern (components/DataTable): same
            // giver/amount/receipt anatomy as the digest card in Messages.
            <div className="border-t border-ink-100 p-2">
              <DataTable
                columns={[
                  { key: 'giver', header: t('records.colGiver'), render: (o) => <span className="text-ink-800">{o.offererName || EMPTY_VALUE}</span> },
                  {
                    key: 'amount',
                    header: t('records.colAmount'),
                    width: 22,
                    align: 'right',
                    cardValue: true,
                    render: (o) => <span className="font-semibold tabular-nums text-ink-900">{Number(o.amount).toLocaleString()} {o.currency || 'TZS'}</span>,
                  },
                  ...(cat.rows.some((x) => x.receipt)
                    ? [
                        {
                          key: 'receipt',
                          header: t('records.colReceipt'),
                          width: 22,
                          align: 'right',
                          render: (o) => <span className="whitespace-nowrap text-xs text-ink-400">{o.receipt || EMPTY_VALUE}</span>,
                        },
                      ]
                    : []),
                ]}
                rows={cat.rows}
                keyOf={(o) => o.id}
                empty={null}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AttendanceBlock({ t, row, open, onToggle }) {
  const label = row.sub_session_name ? `${row.service_type_name} · ${row.sub_session_name}` : row.service_type_name || row.session_name;
  const metrics = attendanceMetrics(row);
  const named = (row.attendees || []).length > 0;
  return (
    <div className="rounded-lg border border-ink-100 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="text-sm font-medium text-ink-900">{label}</span>
        <span className="flex flex-wrap justify-end gap-1.5">
          {metrics.map((metric) => (
            <span key={metric.kind} className={`rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums ${metric.kind === 'unique' ? 'bg-people-50 text-people-700' : 'bg-ink-100 text-ink-700'}`}>
              {metric.count.toLocaleString()} {attendanceMetricLabel(t, metric.kind)}
            </span>
          ))}
        </span>
      </div>
      {named && (
        <div className="border-t border-ink-100">
          <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-people-800 hover:bg-people-50">
            <span className="inline-flex items-center gap-1">
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              {row.attendees.length} {t('records.namesCount')}
            </span>
            <span className="font-medium text-people-700">{open ? t('records.hideNames') : t('records.viewNames')}</span>
          </button>
          {open && (
            <div className="flex flex-wrap gap-1.5 px-3 pb-3">
              {row.attendees.map((n, i) => (
                <span key={i} className="rounded-full bg-people-50 px-2.5 py-0.5 text-xs text-people-800 ring-1 ring-people-100">{n}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {!named && <p className="px-3 pb-2.5 text-xs text-ink-400">{t('records.headcountOnly')}</p>}
    </div>
  );
}

export default function Records() {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState('report');
  const [serviceTypeId, setServiceTypeId] = useState('');
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [selectedId, setSelectedId] = useState(null);
  const [types, setTypes] = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [offerings, setOfferings] = useState([]);
  const [open, setOpen] = useState({});
  const [loadError, setLoadError] = useState('');

  const isSingleDay = from === to;
  // The day report only makes sense for a single selected day, so derive the
  // active view instead of forcing it through state.
  const view = isSingleDay ? tab : 'sessions';

  useEffect(() => {
    api
      .get('/service-types')
      .then(({ data }) => setTypes(data.serviceTypes.filter((x) => x.is_active)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const params = { from, to };
    if (serviceTypeId) params.serviceTypeId = serviceTypeId;
    api
      .get('/attendance', { params })
      .then(({ data }) => {
        setLoadError('');
        setAttendance(data.attendance);
      })
      .catch((err) => setLoadError(apiErrorMessage(err)));
    api
      .get('/offerings', { params })
      .then(({ data }) => setOfferings(data.offerings))
      .catch((err) => setLoadError(apiErrorMessage(err)));
  }, [from, to, serviceTypeId]);

  const sessions = useMemo(() => buildSessions(attendance, offerings), [attendance, offerings]);

  const totals = useMemo(() => {
    const sums = {};
    for (const s of sessions) for (const o of s.offerings) sums[o.currency || 'TZS'] = (sums[o.currency || 'TZS'] || 0) + Number(o.amount || 0);
    return { gifts: Object.entries(sums).map(([c, v]) => `${Number(v).toLocaleString()} ${c}`).join(' + ') };
  }, [sessions]);

  const selected = sessions.find((s) => s.id === selectedId);

  const typeGroups = useMemo(() => {
    const m = new Map();
    for (const s of sessions) {
      if (!s.typeId) continue;
      if (!m.has(s.typeId)) m.set(s.typeId, { typeId: s.typeId, name: s.typeName, sessions: [] });
      m.get(s.typeId).sessions.push(s);
    }
    return [...m.values()];
  }, [sessions]);

  function resetToday() {
    const today = todayISO();
    setFrom(today);
    setTo(today);
    setSelectedId(null);
  }

  function renderAttendanceCard(s, extra) {
    if (!s.attendance.length) {
      return <p className="rounded-lg border border-dashed border-ink-200 p-3 text-center text-xs text-ink-400">{t('records.noAttendance')}</p>;
    }
    return (
      <div className="space-y-2">
        {s.attendance.map((r) => (
          <AttendanceBlock key={r.id} t={t} row={r} open={!!open[`att-${r.id}`]} onToggle={() => setOpen((o) => ({ ...o, [`att-${r.id}`]: !o[`att-${r.id}`] }))} />
        ))}
        {extra}
      </div>
    );
  }

  function renderOfferingsCard(s) {
    const groups = groupOfferings(s.offerings);
    if (!groups.length) return <p className="rounded-lg border border-dashed border-ink-200 p-3 text-center text-xs text-ink-400">{t('records.noOfferings')}</p>;
    return (
      <div className="space-y-2">
        {groups.map((cat) => (
          <OfferingBlock key={cat.name} t={t} cat={cat} openName={!!open[`cat-${s.id}-${cat.name}`]} onToggle={() => setOpen((o) => ({ ...o, [`cat-${s.id}-${cat.name}`]: !o[`cat-${s.id}-${cat.name}`] }))} />
        ))}
      </div>
    );
  }

  // ---------------- Detail ----------------
  if (selected) {
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => setSelectedId(null)} className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-600 hover:text-ink-900">
          <ArrowLeft size={15} /> {t('records.backToList')}
        </button>
        <div>
          <h1 className="font-display text-xl font-semibold">{selected.label}</h1>
          <p className="text-sm text-ink-400">{formatDate(selected.date, i18n.language)}</p>
          {selected.eventTitle && (
            <p className="mt-1 text-sm text-ink-600">
              <CalendarDays size={13} className="mr-1 inline align-[-2px] text-people-600" /> {selected.eventTitle}
            </p>
          )}
          {selected.eventDescription && <p className="mt-0.5 text-sm text-ink-500">{selected.eventDescription}</p>}
        </div>

        <section className="tile p-4">
          <h2 className="mb-3 flex items-center gap-1.5 font-display text-base font-semibold"><Users size={15} className="text-people-600" /> {t('records.attendanceSummary')}</h2>
          {renderAttendanceCard(selected)}
        </section>

        <section className="tile p-4">
          <h2 className="mb-3 flex items-center gap-1.5 font-display text-base font-semibold"><HandCoins size={15} className="text-offering-600" /> {t('records.offeringsSummary')}</h2>
          {renderOfferingsCard(selected)}
        </section>
      </div>
    );
  }

  // ---------------- List ----------------
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-semibold">{t('records.title')}</h1>
          <p className="truncate text-sm text-ink-400">{formatDate(from, i18n.language)}: {formatDate(to, i18n.language)}</p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2 text-right">
          {totals.gifts && <span className="rounded-full bg-offering-50 px-2.5 py-0.5 text-sm font-semibold text-offering-700">{totals.gifts}</span>}
        </div>
      </div>

      {loadError && <StatusBanner type="error" message={loadError} />}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-40">
          <label className="mb-1 block text-xs font-medium text-ink-500" htmlFor="rec-svc">{t('records.filterService')}</label>
          <select id="rec-svc" value={serviceTypeId} onChange={(e) => setServiceTypeId(e.target.value)} className="w-full rounded-md border border-ink-200 px-2.5 py-2 text-sm focus-visible:border-brand-600">
            <option value="">{t('records.allServices')}</option>
            {types.map((x) => (
              <option key={x.id} value={x.id}>{x.name}</option>
            ))}
          </select>
        </div>
        <div className="min-w-0 flex-1 basis-36">
          <label className="mb-1 block text-xs font-medium text-ink-500" htmlFor="rec-from">{t('records.from')}</label>
          <input id="rec-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setSelectedId(null); }} className="w-full rounded-md border border-ink-200 px-2.5 py-2 text-sm focus-visible:border-brand-600" />
        </div>
        <div className="min-w-0 flex-1 basis-36">
          <label className="mb-1 block text-xs font-medium text-ink-500" htmlFor="rec-to">{t('records.to')}</label>
          <input id="rec-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setSelectedId(null); }} className="w-full rounded-md border border-ink-200 px-2.5 py-2 text-sm focus-visible:border-brand-600" />
        </div>
        <button type="button" onClick={resetToday} className="btn btn-secondary whitespace-nowrap">{t('records.today')}</button>
      </div>

      {isSingleDay && (
        <div className="flex rounded-md border border-ink-200 p-1">
          <button onClick={() => setTab('report')} className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${view === 'report' ? 'bg-ink-800 text-white' : 'text-ink-700'}`}>{t('records.viewReport')}</button>
          <button onClick={() => setTab('sessions')} className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${view === 'sessions' ? 'bg-ink-800 text-white' : 'text-ink-700'}`}>{t('records.viewSessions')}</button>
        </div>
      )}

      {view === 'report' ? (
        <>
          <section className="tile col-span-12 p-4">
            <h2 className="mb-3 font-display text-base font-semibold">{t('records.sessionsRan')}</h2>
            {sessions.length === 0 ? (
              <p className="p-4 text-center text-sm text-ink-400">{t('records.noSessions')}</p>
            ) : (
              <ul className="space-y-3">
                {sessions.map((s) => (
                  <li key={s.id} className="rounded-xl border border-ink-200 bg-paper p-3">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-ink-900">{s.label}</p>
                      <span className="text-xs text-ink-400">{formatDate(s.date, i18n.language)}</span>
                    </div>
                    <div className="mb-3">{renderAttendanceCard(s)}</div>
                    {renderOfferingsCard(s)}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <GivingByPayment offerings={offerings} />

          {typeGroups.length > 0 && (
            <section className="bento">
              {typeGroups.map((g) => (
                <div key={g.typeId} className="tile col-span-12 p-4 lg:col-span-6">
                  <h3 className="mb-3 font-display text-base font-semibold">{g.name}</h3>
                  <BarChart
                    data={g.sessions.map((s) => {
                      const row = s.attendance[0];
                      const metrics = attendanceMetrics(row);
                      return {
                        label: `${s.subSession || s.label} · ${metrics.map((metric) => attendanceMetricLabel(t, metric.kind)).join(' + ')}`,
                        attendance: metrics[0]?.count || 0,
                      };
                    })}
                    tone="people"
                    valueKey="attendance"
                    name={t('records.attendanceSummary')}
                  />
                  {g.sessions.some((s) => s.offerings.length > 0) && (
                    <div className="mt-4 border-t border-ink-100 pt-3">
                      <BarChart
                        data={g.sessions.map((s) => ({ label: s.subSession || s.label, amount: s.offerings.reduce((n, o) => n + Number(o.amount || 0), 0) }))}
                        tone="offering"
                        valueKey="amount"
                        name={t('records.offeringsSummary')}
                        format={(v) => `${Number(v).toLocaleString()} ${g.sessions[0]?.offerings[0]?.currency || 'TZS'}`}
                      />
                    </div>
                  )}
                </div>
              ))}
            </section>
          )}
        </>
      ) : (
        <>
          {sessions.length === 0 ? (
            <p className="rounded-xl border border-dashed border-ink-200 p-6 text-center text-sm text-ink-400">{t('records.noRecords')}</p>
          ) : (
            <ul className="space-y-2">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(s.id)}
                    className="w-full rounded-xl border border-ink-200 bg-paper px-4 py-3 text-left shadow-sm transition-colors hover:border-brand-400 hover:bg-brand-50/40"
                  >
                    <span className="block truncate font-medium text-ink-900">{s.label}</span>
                    <span className="mt-0.5 block text-xs text-ink-400">{formatDate(s.date, i18n.language)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <GivingByPayment offerings={offerings} />
        </>
      )}
    </div>
  );
}