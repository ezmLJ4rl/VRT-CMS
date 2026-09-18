import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft, HandCoins, Scale, Target, TrendingUp, Pencil, Plus, Trash2, Check, X,
} from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import DataTable from '../components/DataTable';
import StatusBanner from '../components/StatusBanner';
import StatCard from '../components/StatCard';
import ProgressBar from '../components/ProgressBar';
import BarChart from '../components/BarChart';
import TrendChart from '../components/TrendChart';
import { STATUS_TONE, money, daysLabel, contributorSeries, giverLabel } from '../projectView';
import { EMPTY_VALUE } from '../emptyValue';

/*
 * One project's progress page.
 *
 * Built for a pastor glancing at it for ten seconds, then for a treasurer
 * reading it properly. Three things are kept deliberately apart, because
 * conflating them is how a project ends up looking better funded than it is:
 *
 *   raised      money actually received (the offering ledger)
 *   pledged     money promised, with its own fulfilment bar
 *   spent/owed  money out and money still owed (net position follows)
 *
 * Nothing here is calculated from anything but the API's figures.
 */
const EMPTY_PLEDGE = { name: '', amount: '', memberId: '', pledgedOn: '' };
const EMPTY_DEBT = { description: '', amount: '', status: 'outstanding', incurredOn: '' };
const EMPTY_EDIT = { name: '', description: '', status: 'active', startedOn: '', targetOn: '', goalAmount: '', currency: 'TZS' };

export default function ProjectDetail() {
  const { id } = useParams();
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pledge, setPledge] = useState(EMPTY_PLEDGE);
  const [debt, setDebt] = useState(EMPTY_DEBT);
  const [payments, setPayments] = useState({});
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState(EMPTY_EDIT);

  const load = useCallback(() => {
    api
      .get(`/projects/${id}`)
      .then(({ data: d }) => {
        setData(d);
        setEdit({
          name: d.project.name,
          description: d.project.description || '',
          status: d.project.status,
          startedOn: d.project.startedOn || '',
          targetOn: d.project.targetOn || '',
          goalAmount: String(d.project.goalAmount),
          currency: d.project.currency,
        });
      })
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }, [id]);

  useEffect(load, [load]);

  // Returns whether the write succeeded, so a form only clears its inputs when
  // the server actually accepted them.
  async function run(fn, successKey) {
    setBusy(true);
    setBanner(null);
    try {
      await fn();
      if (successKey) setBanner({ type: 'success', message: t(successKey) });
      load();
      return true;
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <AppShell>
        {banner ? <StatusBanner type={banner.type} message={banner.message} /> : <p className="py-10 text-center text-sm text-ink-400">{t('common.loading')}</p>}
      </AppShell>
    );
  }

  const { project, summary, timeline, contributors, contributions, monthly, pledges, debts, canEdit, giftCount, otherCurrencies } = data;
  const cur = project.currency;

  return (
    <AppShell>
      <Link to="/projects" className="mb-3 inline-flex items-center gap-1.5 text-sm font-medium text-ink-500 hover:text-ink-900">
        <ArrowLeft size={15} /> {t('projects.back')}
      </Link>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-semibold">{project.name}</h1>
            <span className={`cat-chip ${STATUS_TONE[project.status] || 'category-ink'}`}>{t(`projects.status_${project.status}`)}</span>
          </div>
          {project.description && <p className="mt-1.5 max-w-2xl text-sm text-ink-500">{project.description}</p>}
          <p className="mt-1.5 text-xs text-ink-400">{daysLabel(timeline, t)}</p>
        </div>
        {canEdit && (
          <button type="button" onClick={() => setEditing((v) => !v)} className="btn btn-secondary">
            {editing ? <X size={15} /> : <Pencil size={15} />} {editing ? t('common.cancel') : t('projects.edit')}
          </button>
        )}
      </header>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      {editing && canEdit && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await run(
              () => api.patch(`/projects/${id}`, { ...edit, goalAmount: Number(edit.goalAmount || 0), startedOn: edit.startedOn || null, targetOn: edit.targetOn || null }),
              'projects.updated'
            );
            if (ok) setEditing(false);
          }}
          className="tile mb-5 space-y-3 p-5"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="eName">{t('projects.name')}</label>
              <input id="eName" required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="eDesc">{t('projects.description')}</label>
              <textarea id="eDesc" rows={2} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="eGoal">{t('projects.goal')}</label>
              <input id="eGoal" type="number" min="0" value={edit.goalAmount} onChange={(e) => setEdit({ ...edit, goalAmount: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="eStatus">{t('projects.status')}</label>
              <select id="eStatus" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600">
                <option value="active">{t('projects.statusActive')}</option>
                <option value="on_hold">{t('projects.statusOnHold')}</option>
                <option value="completed">{t('projects.statusCompleted')}</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="eStart">{t('projects.startedOn')}</label>
              <input id="eStart" type="date" value={edit.startedOn} onChange={(e) => setEdit({ ...edit, startedOn: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="eTarget">{t('projects.targetOn')}</label>
              <input id="eTarget" type="date" value={edit.targetOn} onChange={(e) => setEdit({ ...edit, targetOn: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
          </div>
          <button type="submit" disabled={busy} className="btn btn-primary btn-lg w-full">{busy ? t('common.saving') : t('common.save')}</button>
        </form>
      )}

      {/* Where the project actually stands, at a glance. */}
      <section className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label={t('projects.raised')} value={money(summary.raised, cur)} accent="offering" sub={`${giftCount} ${t('projects.gifts')}`} />
        <StatCard label={t('projects.pledgedOutstanding')} value={money(summary.pledgeOutstanding, cur)} accent="people" sub={t('projects.pledgedTotal', { total: money(summary.pledged, cur) })} />
        <StatCard label={t('projects.spent')} value={money(summary.spent, cur)} accent="neutral" sub={t('projects.debtsPaid')} />
        <StatCard label={t('projects.owed')} value={money(summary.owed, cur)} accent="amber" sub={t('projects.debtsOutstanding')} />
        <StatCard label={t('projects.netRemainingNeed')} value={money(summary.netRemainingNeed, cur)} accent="brand" sub={t('projects.netPositionIs', { amount: money(summary.netPosition, cur) })} />
      </section>

      {/* Two bars, never one: money in hand and money promised. */}
      <section className="bento mb-5">
        <div className="tile col-span-12 p-5 lg:col-span-6">
          <h2 className="mb-4 flex items-center gap-2 font-display text-lg font-semibold">
            <HandCoins size={17} className="text-offering-600" /> {t('projects.funding')}
          </h2>
          <ProgressBar
            pct={summary.fundedPct}
            label={t('projects.received')}
            value={summary.fundedPct === null ? t('projects.noGoal') : `${summary.fundedPct}%`}
          />
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-semibold text-offering-700">{money(summary.raised, cur)}</span>
            <span className="text-ink-400">{t('projects.ofGoal', { goal: money(summary.goalAmount, cur) })}</span>
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {summary.remainingToGoal > 0
              ? t('projects.stillToRaise', { amount: money(summary.remainingToGoal, cur) })
              : t('projects.goalMet')}
          </p>
        </div>

        <div className="tile col-span-12 p-5 lg:col-span-6">
          <h2 className="mb-4 flex items-center gap-2 font-display text-lg font-semibold">
            <Scale size={17} className="text-people-600" /> {t('projects.pledgeFulfilment')}
          </h2>
          <ProgressBar
            pct={summary.pledgePct}
            tone="people"
            label={t('projects.pledgesHonoured')}
            value={summary.pledgePct === null ? t('projects.noPledges') : `${summary.pledgePct}%`}
          />
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 text-sm">
            <span className="font-semibold text-people-700">{money(summary.pledgeFulfilled, cur)}</span>
            <span className="text-ink-400">{t('projects.ofPledged', { pledged: money(summary.pledged, cur) })}</span>
          </div>
          <p className="mt-2 text-xs text-ink-500">
            {t('projects.pledgeNote', { outstanding: money(summary.pledgeOutstanding, cur) })}
          </p>
        </div>
      </section>

      {otherCurrencies.length > 0 && (
        <p className="mb-5 rounded-lg border border-ink-200 bg-ink-50/60 px-4 py-2 text-xs text-ink-600">
          {t('projects.otherCurrencies', { list: otherCurrencies.map((o) => `${money(o.raised, o.currency)}`).join(' · ') })}
        </p>
      )}

      {/* Charts: the funding trend and who is carrying it. */}
      <section className="bento mb-5">
        <div className="tile col-span-12 p-5 lg:col-span-7">
          <h2 className="mb-4 flex items-center gap-2 font-display text-lg font-semibold">
            <TrendingUp size={17} className="text-offering-600" /> {t('projects.monthlyGiving')}
          </h2>
          <TrendChart
            data={monthly}
            format={(v) => money(v, cur)}
            series={[{ key: 'value', name: t('projects.received'), color: 'var(--color-offering-600)' }]}
            height={220}
          />
        </div>
        <div className="tile col-span-12 p-5 lg:col-span-5">
          <h2 className="mb-4 flex items-center gap-2 font-display text-lg font-semibold">
            <Target size={17} className="text-offering-600" /> {t('projects.topContributors')}
          </h2>
          {contributors.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-400">{t('projects.noContributions')}</p>
          ) : (
            <BarChart data={contributorSeries(contributors)} tone="offering" format={(v) => money(v, cur)} height={200} />
          )}
        </div>
      </section>

      {/* Timeline. */}
      <section className="tile mb-5 p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">{t('projects.timeline')}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-400">{t('projects.startedOn')}</p>
            <p className="font-display text-base font-semibold">{timeline.startedOn || EMPTY_VALUE}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-400">{t('projects.targetOn')}</p>
            <p className="font-display text-base font-semibold">{timeline.targetOn || EMPTY_VALUE}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-ink-400">{t('projects.timeLeft')}</p>
            <p className={`font-display text-base font-semibold ${timeline.overdue ? 'text-amber-700' : ''}`}>
              {timeline.remainingDays === null || timeline.remainingDays === undefined
                ? t('projects.noTarget')
                : timeline.remainingDays < 0
                  ? t('projects.overdueBy', { n: Math.abs(timeline.remainingDays) })
                  : t('projects.daysRemaining', { n: timeline.remainingDays })}
            </p>
          </div>
        </div>
        {timeline.elapsedPct !== null && (
          <div className="mt-4">
            <ProgressBar pct={timeline.elapsedPct} tone="brand" label={t('projects.scheduleElapsed')} value={`${timeline.elapsedPct}%`} />
          </div>
        )}
      </section>

      {/* Contribution ledger + who repeats. */}
      <section className="bento mb-5">
        <div className="tile col-span-12 overflow-hidden p-5 lg:col-span-8">
          <h2 className="mb-4 font-display text-lg font-semibold">{t('projects.ledger')}</h2>
          {/* The one shared table pattern (components/DataTable): same
              giver/service/amount anatomy as the front desk's offerings
              list, and the same card reflow on phones. */}
          {contributions.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">{t('projects.noContributions')}</p>
          ) : (
            <DataTable
              columns={[
                { key: 'date', header: t('projects.colDate'), width: 14, render: (c) => <span className="text-ink-600">{c.date}</span> },
                {
                  key: 'giver',
                  header: t('projects.colGiver'),
                  render: (c) => (
                    <span className="text-ink-900">
                      {c.giverNameUnavailable ? (
                        <span className="font-medium text-amber-700">{t('common.nameUnavailable')}</span>
                      ) : (
                        giverLabel(c, t)
                      )}
                      {c.memberName && <span className="ml-1.5 text-xs text-ink-400">{t('projects.memberTag')}</span>}
                    </span>
                  ),
                },
                { key: 'service', header: t('projects.colService'), width: 18, render: (c) => <span className="text-xs text-ink-500">{c.service}</span> },
                {
                  key: 'amount',
                  header: t('projects.colAmount'),
                  width: 15,
                  align: 'right',
                  cardValue: true,
                  render: (c) => <span className="font-semibold tabular-nums text-offering-700">{money(c.amount, c.currency)}</span>,
                },
              ]}
              rows={contributions}
              keyOf={(c) => c.id}
              empty={<p className="py-6 text-center text-sm text-ink-400">{t('projects.noContributions')}</p>}
            />
          )}
        </div>

        <div className="tile col-span-12 p-5 lg:col-span-4">
          <h2 className="mb-4 font-display text-lg font-semibold">{t('projects.repeatContributors')}</h2>
          {contributors.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">{t('projects.noContributions')}</p>
          ) : (
            <ul className="space-y-2.5">
              {contributors.slice(0, 8).map((c) => (
                <li key={c.key} className="flex items-center justify-between gap-3 border-b border-ink-100 pb-2 last:border-0">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink-900">{c.name || t('common.anonymous')}</span>
                    <span className="text-xs text-ink-400">{t('projects.givenTimes', { n: c.times })}</span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-offering-700">{money(c.total, cur)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Pledges. */}
      <section className="tile mb-5 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">{t('projects.pledges')}</h2>
          <span className="text-sm text-ink-500">
            {t('projects.pledgeSummary', {
              pledged: money(summary.pledged, cur),
              outstanding: money(summary.pledgeOutstanding, cur),
            })}
          </span>
        </div>
        {pledges.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-400">{t('projects.noPledges')}</p>
        ) : (
          <ul className="space-y-3">
            {pledges.map((p) => (
              <li key={p.id} className="rounded-lg border border-ink-100 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-ink-900">
                      {p.pledgeNameUnavailable ? <span className="text-amber-700">{t('common.nameUnavailable')}</span> : p.pledgeName || p.memberName || EMPTY_VALUE}
                      {p.memberName && <span className="ml-1.5 text-xs text-ink-400">{p.memberName}</span>}
                    </p>
                    <p className="text-xs text-ink-500">
                      {t('projects.pledgeLine', { pledged: money(p.amount, p.currency), fulfilled: money(p.fulfilledAmount, p.currency), date: p.pledgedOn || EMPTY_VALUE })}
                    </p>
                  </div>
                  <span className={`cat-chip ${p.status === 'fulfilled' ? 'category-success' : p.status === 'cancelled' ? 'category-ink' : 'category-amber'}`}>
                    {t(`projects.pledgeStatus_${p.status}`)}
                  </span>
                </div>
                <div className="mt-2.5">
                  <ProgressBar pct={p.fulfilmentPct} tone="people" value={`${money(p.fulfilledAmount, p.currency)} / ${money(p.amount, p.currency)}`} />
                </div>
                {canEdit && p.status !== 'cancelled' && p.outstanding > 0 && (
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      value={payments[p.id] ?? ''}
                      onChange={(e) => setPayments({ ...payments, [p.id]: e.target.value })}
                      placeholder={t('projects.paymentAmount')}
                      className="w-32 rounded-md border border-ink-200 px-2.5 py-1.5 text-sm focus-visible:border-brand-600"
                    />
                    <button
                      type="button"
                      disabled={busy || !Number(payments[p.id])}
                      onClick={async () => {
                        const ok = await run(
                          () => api.patch(`/projects/${id}/pledges/${p.id}`, { addFulfilled: Number(payments[p.id]) }),
                          'projects.paymentRecorded'
                        );
                        if (ok) setPayments((m) => ({ ...m, [p.id]: '' }));
                      }}
                      className="btn btn-secondary"
                    >
                      <Check size={15} /> {t('projects.recordPayment')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => api.patch(`/projects/${id}/pledges/${p.id}`, { status: 'cancelled' }), 'projects.updated')}
                      className="btn btn-ghost"
                    >
                      {t('projects.cancelPledge')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      title={t('common.remove')}
                      aria-label={t('common.remove')}
                      onClick={() => run(() => api.delete(`/projects/${id}/pledges/${p.id}`), 'projects.updated')}
                      className="inline-flex h-10 w-10 items-center justify-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-danger-600"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api.post(`/projects/${id}/pledges`, { ...pledge, amount: Number(pledge.amount) }), 'projects.pledgeAdded');
              if (ok) setPledge(EMPTY_PLEDGE);
            }}
            className="mt-4 grid gap-2 border-t border-ink-100 pt-4 sm:grid-cols-4"
          >
            <input required value={pledge.name} onChange={(e) => setPledge({ ...pledge, name: e.target.value })} placeholder={t('projects.pledgerName')} className="rounded-md border border-ink-200 px-3 py-2.5 sm:col-span-2 focus-visible:border-brand-600" />
            <input required type="number" min="0" inputMode="numeric" value={pledge.amount} onChange={(e) => setPledge({ ...pledge, amount: e.target.value })} placeholder={t('projects.amount')} className="rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            <button type="submit" disabled={busy || !pledge.name || !Number(pledge.amount)} className="btn btn-primary">
              <Plus size={16} /> {t('projects.addPledge')}
            </button>
          </form>
        )}
      </section>

      {/* Debts. */}
      <section className="tile p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">{t('projects.debts')}</h2>
          <span className="text-sm text-ink-500">
            {t('projects.debtSummary', { owed: money(summary.owed, cur), spent: money(summary.spent, cur) })}
          </span>
        </div>
        {debts.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-400">{t('projects.noDebts')}</p>
        ) : (
          <ul className="space-y-2">
            {debts.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-100 p-3">
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink-900">{d.description}</span>
                  <span className="text-xs text-ink-500">{d.incurredOn || EMPTY_VALUE}{d.notes ? ` · ${d.notes}` : ''}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-semibold tabular-nums text-ink-900">{money(d.amount, d.currency)}</span>
                  <span className={`cat-chip ${d.status === 'paid' ? 'category-success' : 'category-amber'}`}>{t(`projects.debtStatus_${d.status}`)}</span>
                  {canEdit && (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => run(() => api.patch(`/projects/${id}/debts/${d.id}`, { status: d.status === 'paid' ? 'outstanding' : 'paid' }), 'projects.paymentRecorded')}
                        className="btn btn-secondary"
                      >
                        {d.status === 'paid' ? t('projects.markOutstanding') : t('projects.markPaid')}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        title={t('common.remove')}
                        aria-label={t('common.remove')}
                        onClick={() => run(() => api.delete(`/projects/${id}/debts/${d.id}`), 'projects.updated')}
                        className="inline-flex h-10 w-10 items-center justify-center rounded-md text-ink-400 hover:bg-ink-100 hover:text-danger-600"
                      >
                        <Trash2 size={16} />
                      </button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await run(() => api.post(`/projects/${id}/debts`, { ...debt, amount: Number(debt.amount) }), 'projects.debtAdded');
              if (ok) setDebt(EMPTY_DEBT);
            }}
            className="mt-4 grid gap-2 border-t border-ink-100 pt-4 sm:grid-cols-5"
          >
            <input required value={debt.description} onChange={(e) => setDebt({ ...debt, description: e.target.value })} placeholder={t('projects.debtDescription')} className="rounded-md border border-ink-200 px-3 py-2.5 sm:col-span-3 focus-visible:border-brand-600" />
            <input required type="number" min="0" inputMode="numeric" value={debt.amount} onChange={(e) => setDebt({ ...debt, amount: e.target.value })} placeholder={t('projects.amount')} className="rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            <button type="submit" disabled={busy || !debt.description || !Number(debt.amount)} className="btn btn-primary">
              <Plus size={16} /> {t('projects.addDebt')}
            </button>
          </form>
        )}
      </section>
    </AppShell>
  );
}
