import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, ShieldAlert, ArchiveRestore } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import DataTable from '../components/DataTable';
import StatCard from '../components/StatCard';
import StatusBanner from '../components/StatusBanner';
import TrendChart from '../components/TrendChart';
import { formatDateShort } from '../format';
import { EMPTY_VALUE } from '../emptyValue';

const PALETTE = ['var(--color-people-600)', 'var(--color-people-400)', 'var(--color-people-800)', 'var(--color-people-300)', 'var(--color-people-500)', 'var(--color-people-700)', 'var(--color-people-200)', 'var(--color-people-900)'];

// "2025-49" (strftime %Y-%W) -> readable week label like "8 Dec 2025".
function weekLabel(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const [y, w] = [Number(m[1]), Number(m[2])];
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const dow = (jan4.getUTCDay() + 6) % 7; // Monday == 0
  const monday = new Date(Date.UTC(y, 0, 4 - dow + (w - 1) * 7));
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(monday);
}

export default function AdminDashboard() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState({ byType: [], byService: [] });
  const [trends, setTrends] = useState([]);
  const [serviceBreakdown, setServiceBreakdown] = useState([]);
  const [rehearsalBreakdown, setRehearsalBreakdown] = useState([]);
  const [topContributors, setTopContributors] = useState([]);
  const [auditStatus, setAuditStatus] = useState(null);
  const [pendingEvents, setPendingEvents] = useState([]);
  const [finalizingId, setFinalizingId] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [finalizeNote, setFinalizeNote] = useState(null);

  useEffect(() => {
    api
      .get('/offerings/summary')
      .then(({ data }) => setSummary(data))
      .catch((err) => setLoadError(apiErrorMessage(err)));
    api
      .get('/attendance/trends', { params: { granularity: 'weekly' } })
      // The stacked chart is keyed by service type, so it consumes the byType
      // series ([{key, name, points:[{period,total}]}]), not the overall one,
      // whose rows have no .points and crashed the chartData memo.
      .then(({ data }) => setTrends(data.byType || []))
      .catch((err) => setLoadError(apiErrorMessage(err)));
    api
      .get('/reports/breakdown', { params: { groupBy: 'service' } })
      .then(({ data }) => {
        setServiceBreakdown(data.breakdown || []);
        // Rehearsals come back beside the services, never inside their totals.
        setRehearsalBreakdown(data.rehearsals || []);
      })
      .catch(() => {});
    api.get('/offerings/top-contributors').then(({ data }) => setTopContributors(data.topContributors)).catch(() => {});
    api.get('/reports/audit-integrity').then(({ data }) => setAuditStatus(data)).catch(() => {});
    api.get('/events/pending-finalization').then(({ data }) => setPendingEvents(data.events || [])).catch(() => {});
  }, []);

  async function finalize(e) {
    if (!window.confirm(t('admin.finalizeConfirm', { title: e.title }))) return;
    setFinalizingId(e.id);
    setFinalizeNote(null);
    try {
      const { data } = await api.post(`/events/${e.id}/finalize`);
      setPendingEvents((prev) => prev.filter((x) => x.id !== e.id));
      setFinalizeNote({
        type: 'success',
        message: t('admin.finalizedEvent', { title: e.title, att: data.summary.attendance, total: Number(data.summary.offerings).toLocaleString() }),
      });
    } catch (err) {
      setFinalizeNote({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setFinalizingId(null);
    }
  }

  const offeringTotals = useMemo(() => {
    const map = new Map();
    for (const r of summary.byType) {
      const c = r.currency || 'TZS';
      map.set(c, (map.get(c) || 0) + (r.total || 0));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [summary]);
  const totalAttendance = serviceBreakdown.reduce((sum, row) => sum + (row.attendance || 0), 0);

  const chartData = useMemo(() => {
    const periods = [...new Set(trends.flatMap((s) => (s.points || []).map((p) => p.period)))].sort();
    return periods.map((period) => {
      const row = { period, label: weekLabel(period) };
      for (const s of trends) {
        const p = (s.points || []).find((x) => x.period === period);
        row[s.key] = p ? p.total : 0;
      }
      return row;
    });
  }, [trends]);

  const trendSeries = useMemo(() => trends.map((s, i) => ({ key: s.key, name: s.name, color: PALETTE[i % PALETTE.length] })), [trends]);

  const byTypeRows = summary.byType
    .map((row) => ({
      key: row.key,
      label: row.name || t(`offeringCat.${row.key}`),
      total: row.total,
      entries: row.entries,
      currency: row.currency,
    }))
    .sort((a, b) => b.total - a.total);

  return (
    <AppShell>
      <h1 className="mb-5 font-display text-2xl font-semibold">{t('admin.title')}</h1>

      {loadError && (
        <div className="mb-5">
          <StatusBanner type="error" message={loadError} />
        </div>
      )}
      {finalizeNote && (
        <div className="mb-5">
          <StatusBanner type={finalizeNote.type} message={finalizeNote.message} />
        </div>
      )}

      <div className="bento">
        <div className="col-span-12 lg:col-span-3">
          <StatCard label={t('admin.totalAttendance')} value={totalAttendance.toLocaleString()} accent="people" />
        </div>
        <div className="col-span-12 lg:col-span-3">
          <StatCard label={t('admin.totalOfferings')} value={offeringTotals.map(([c, t]) => `${t.toLocaleString()} ${c}`).join(' · ')} accent="offering" sub={`${summary.byType.reduce((s, r) => s + r.entries, 0)} ${t('receptionist.entries')}`} />
        </div>
        {byTypeRows.slice(0, 2).map((row) => (
          <div key={row.key} className="col-span-12 lg:col-span-3">
            <StatCard
              label={row.label}
              value={`${row.total.toLocaleString()} ${row.currency}`}
              sub={`${row.entries} ${t('receptionist.entries')}`}
              accent="offering"
            />
          </div>
        ))}
      </div>

      {pendingEvents.length > 0 && (
        <div className="bento mt-4">
          <section className="tile col-span-12 border-l-4 border-l-amber-500 p-5">
            <h2 className="mb-1 font-display text-lg font-semibold">{t('admin.finalizeQueue')}</h2>
            <p className="mb-3 text-xs text-ink-400">{t('admin.finalizeQueueNote', { count: pendingEvents.length })}</p>
            <ul className="space-y-2">
              {pendingEvents.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-100 bg-ink-50/50 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink-900">{e.title}</p>
                    <p className="text-xs text-ink-400">
                      {formatDateShort(String(e.starts_at).slice(0, 10))} · {e.attendance.toLocaleString()} {t('admin.finalizeQueueAttended')} · {Number(e.offerings).toLocaleString()} {t('admin.finalizeQueueCollected')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => finalize(e)}
                    disabled={finalizingId === e.id}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800 disabled:opacity-60"
                  >
                    <ArchiveRestore size={13} /> {t('admin.finalizeQueueAction')}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}

      <div className="bento mt-4">
        <section className="tile col-span-12 p-5 lg:col-span-7">
          <h2 className="mb-1 font-display text-lg font-semibold">{t('admin.attendanceTrends')}</h2>
          <p className="mb-4 text-xs text-ink-400">{t('admin.attendanceTrendsNote')}</p>
          <TrendChart data={chartData} series={trendSeries} format={(v) => v.toLocaleString()} />
        </section>

        <section className="tile col-span-12 p-5 lg:col-span-5">
          <h2 className="mb-4 font-display text-lg font-semibold">{t('admin.byServiceType')}</h2>
          {/* The one shared table pattern (components/DataTable). The
              rehearsals sub-list rides along as extra rows with its heading
              rendered inside the first column, so one pattern covers both. */}
          <DataTable
            columns={[
              {
                key: 'label',
                header: t('admin.serviceTypeHeader'),
                render: (row) =>
                  row.heading ? (
                    <span>
                      {row.label}
                      <span className="ml-2 text-xs normal-case tracking-normal text-ink-400">{t('admin.rehearsalsNote')}</span>
                    </span>
                  ) : (
                    <span className="font-medium text-ink-900">
                      {row.label}
                      {row.mode === 'named' && <span className="cat-chip category-ink ml-2">By name</span>}
                    </span>
                  ),
              },
              {
                key: 'attendance',
                header: t('admin.attendanceHeader'),
                width: 20,
                align: 'right',
                cardValue: true,
                render: (row) =>
                  row.heading ? null : (
                    <span className="font-medium text-people-700">{row.attendance ? row.attendance.toLocaleString() : EMPTY_VALUE}</span>
                  ),
              },
              {
                key: 'offering',
                header: t('admin.offeringsHeader'),
                width: 22,
                align: 'right',
                render: (row) =>
                  row.heading ? null : (
                    <span className="font-medium text-offering-700">
                      {row.offering ? `${row.offering.toLocaleString()} ${row.currency || 'TZS'}` : EMPTY_VALUE}
                    </span>
                  ),
              },
            ]}
            rows={[
              ...serviceBreakdown,
              ...(rehearsalBreakdown.length > 0
                ? [{ key: '__rehearsals-heading', label: t('admin.rehearsalsTitle'), heading: true },
                   ...rehearsalBreakdown.map((r) => ({ ...r, rehearsal: true }))]
                : []),
            ]}
            keyOf={(row, i) => row.key ?? `row-${i}`}
            rowClassName={(row) =>
              row.heading
                ? 'border-b-0 [&>td]:py-1 [&>td]:text-xs [&>td]:font-medium [&>td]:uppercase [&>td]:tracking-wide [&>td]:text-ink-400'
                : row.rehearsal
                  ? 'bg-ink-50/40'
                  : ''
            }
            empty={<p className="py-4 text-center text-sm text-ink-400">{EMPTY_VALUE}</p>}
          />
        </section>

        <section className="tile col-span-12 p-5 lg:col-span-6">
          <h2 className="mb-1 font-display text-lg font-semibold">{t('admin.byCategory')}</h2>
          <p className="mb-4 text-xs text-ink-400">{t('admin.byCategoryNote')}</p>
          <DataTable
            columns={[
              { key: 'label', header: t('admin.categoryHeader'), render: (row) => <span className="font-medium text-ink-900">{row.label}</span> },
              { key: 'entries', header: t('admin.entriesHeader'), width: 16, align: 'right', cardValue: true, render: (row) => <span className="text-ink-600">{row.entries}</span> },
              {
                key: 'total',
                header: t('admin.offeringsHeader'),
                width: 22,
                align: 'right',
                render: (row) => <span className="font-medium text-offering-700">{row.total.toLocaleString()} {row.currency}</span>,
              },
            ]}
            rows={byTypeRows}
            keyOf={(row) => row.key}
            empty={<p className="py-4 text-center text-sm text-ink-400">{EMPTY_VALUE}</p>}
          />
        </section>

        <section className="tile col-span-12 p-5 lg:col-span-6">
          <h2 className="mb-1 font-display text-lg font-semibold">{t('admin.topContributors')}</h2>
          <p className="mb-4 text-xs text-ink-400">{t('admin.topContributorsNote')}</p>
          <DataTable
            columns={[
              { key: 'name', header: t('projects.colGiver'), render: (c) => <span className="font-medium text-ink-900">{c.name}</span> },
              {
                key: 'total',
                header: t('admin.offeringsHeader'),
                width: 24,
                align: 'right',
                cardValue: true,
                render: (c) => <span className="font-medium">{c.total.toLocaleString()} {c.currency}</span>,
              },
            ]}
            rows={topContributors}
            keyOf={(c, i) => i}
            empty={<p className="py-4 text-center text-sm text-ink-400">{EMPTY_VALUE}</p>}
          />
        </section>

        <section className="tile col-span-12 p-5 lg:col-span-6">
          <h2 className="mb-4 font-display text-lg font-semibold">{t('admin.auditIntegrity')}</h2>
          {auditStatus === null ? (
            <p className="text-sm text-ink-400">{t('common.loading')}</p>
          ) : auditStatus.valid ? (
            <div className="flex items-center gap-2 text-people-700">
              <ShieldCheck size={20} />
              <span className="text-sm">{t('admin.auditValid')}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-danger-700">
              <ShieldAlert size={20} />
              <span className="text-sm">{t('admin.auditInvalid', { id: auditStatus.brokenAtId })}</span>
            </div>
          )}
        </section>

        <section className="tile col-span-12 p-5 lg:col-span-6">
          <h2 className="mb-1 font-display text-lg font-semibold">{t('admin.todaySessions', { count: summary.byService.length })}</h2>
          <ul className="mt-3 space-y-1.5">
            {summary.byService.map((row, i) => (
              <li key={i} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-ink-800">
                  {row.service_name} <span className="text-ink-400">({formatDateShort(row.date)})</span>
                </span>
                <span className="font-medium text-offering-700">{row.total.toLocaleString()} {row.currency}</span>
              </li>
            ))}
            {summary.byService.length === 0 && <li className="text-sm text-ink-400">{EMPTY_VALUE}</li>}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}