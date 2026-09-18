import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, HandCoins, Scale, TrendingUp, Target } from 'lucide-react';
import api from '../api';
import BarChart from '../components/BarChart';
import ProgressBar from '../components/ProgressBar';

/*
 * One project's progress, as the pastor sees it.
 *
 * Read-only by design: the office keeps the record, the pastor reads it, and it
 * has to be clear enough to show the congregation. The three money states are
 * kept apart on purpose (received / promised / owed), because a single "raised"
 * figure would hide the difference between a promise and a gift.
 */
const STATUS_TONE = { active: 'text-people-700', on_hold: 'text-amber-700', completed: 'text-ink-500' };

function Tile({ label, value, sub, tone = 'ink' }) {
  const tones = {
    offering: 'border-l-offering-600 text-offering-800',
    people: 'border-l-people-600 text-people-800',
    amber: 'border-l-amber-500 text-amber-800',
    ink: 'border-l-ink-300 text-ink-900',
  };
  return (
    <div className={`rounded-xl border border-ink-200 border-l-4 bg-paper p-3 ${tones[tone] || tones.ink}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-ink-400">{label}</p>
      <p className="mt-0.5 font-display text-base font-semibold tabular-nums">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-ink-400">{sub}</p>}
    </div>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const { t } = useTranslation();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api
      .get(`/projects/${id}`)
      .then(({ data: d }) => setData(d))
      .catch(() => setFailed(true));
  }, [id]);

  const money = (amount, currency) => `${Number(amount || 0).toLocaleString()} ${currency}`;

  if (failed) {
    return (
      <div className="space-y-3">
        <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500">
          <ArrowLeft size={15} /> {t('projects.back')}
        </Link>
        <p className="rounded-xl border border-danger-300 bg-danger-50 p-3 text-sm text-danger-700">{t('projects.loadFailed')}</p>
      </div>
    );
  }

  if (!data) return <p className="py-10 text-center text-sm text-ink-400">{t('common.loading')}</p>;

  const { project, summary, timeline, contributors, contributions, monthly, pledges, otherCurrencies } = data;
  const cur = project.currency;
  const openPledges = pledges.filter((p) => p.status !== 'cancelled');

  return (
    <div className="space-y-4">
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-500">
        <ArrowLeft size={15} /> {t('projects.back')}
      </Link>

      <header>
        <h1 className="font-display text-xl font-semibold">{project.name}</h1>
        <p className={`text-xs font-medium ${STATUS_TONE[project.status] || 'text-ink-500'}`}>
          {t(`projects.status_${project.status}`)}
          {timeline.remainingDays !== null && timeline.remainingDays !== undefined && !timeline.overdue
            ? ` · ${t('projects.daysRemaining', { n: timeline.remainingDays })}`
            : ''}
          {timeline.overdue ? ` · ${t('projects.overdueBy', { n: Math.abs(timeline.remainingDays) })}` : ''}
        </p>
        {project.description && <p className="mt-2 text-sm text-ink-600">{project.description}</p>}
      </header>

      {/* Where it stands, in four figures. */}
      <section className="grid grid-cols-2 gap-2">
        <Tile label={t('projects.raised')} value={money(summary.raised, cur)} tone="offering" sub={t('projects.ofGoal', { goal: money(summary.goalAmount, cur) })} />
        <Tile label={t('projects.pledgedOutstanding')} value={money(summary.pledgeOutstanding, cur)} tone="people" sub={t('projects.promised')} />
        <Tile label={t('projects.spent')} value={money(summary.spent, cur)} tone="ink" sub={t('projects.debtsPaid')} />
        <Tile label={t('projects.owed')} value={money(summary.owed, cur)} tone="amber" sub={t('projects.debtsOutstanding')} />
      </section>
      <p className="rounded-xl border border-ink-200 bg-paper px-4 py-3 text-sm">
        <span className="text-ink-500">{t('projects.netRemainingNeed')}: </span>
        <span className="font-display font-semibold text-ink-900">{money(summary.netRemainingNeed, cur)}</span>
      </p>

      {/* Received and promised, never merged into one bar. */}
      <section className="space-y-4 rounded-xl border border-ink-200 bg-paper p-4">
        <div>
          <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold">
            <HandCoins size={15} className="text-offering-600" /> {t('projects.funding')}
          </h2>
          <ProgressBar
            pct={summary.fundedPct}
            value={summary.fundedPct === null ? t('projects.noGoal') : `${summary.fundedPct}%`}
            label={`${money(summary.raised, cur)} / ${money(summary.goalAmount, cur)}`}
          />
        </div>
        <div>
          <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold">
            <Scale size={15} className="text-people-600" /> {t('projects.pledgeFulfilment')}
          </h2>
          <ProgressBar
            pct={summary.pledgePct}
            tone="people"
            value={summary.pledgePct === null ? t('projects.noPledges') : `${summary.pledgePct}%`}
            label={`${money(summary.pledgeFulfilled, cur)} / ${money(summary.pledged, cur)}`}
            hint={t('projects.pledgeNote', { outstanding: money(summary.pledgeOutstanding, cur) })}
          />
        </div>
      </section>

      {otherCurrencies.length > 0 && (
        <p className="rounded-xl border border-ink-200 bg-ink-50/60 px-4 py-2 text-xs text-ink-600">
          {t('projects.otherCurrencies', { list: otherCurrencies.map((o) => money(o.raised, o.currency)).join(' · ') })}
        </p>
      )}

      {monthly.length > 0 && (
        <section className="rounded-xl border border-ink-200 bg-paper p-4">
          <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold">
            <TrendingUp size={15} className="text-offering-600" /> {t('projects.monthlyGiving')}
          </h2>
          <BarChart data={monthly} tone="offering" format={(v) => money(v, cur)} height={190} />
        </section>
      )}

      <section className="rounded-xl border border-ink-200 bg-paper p-4">
        <h2 className="mb-3 flex items-center gap-2 font-display text-sm font-semibold">
          <Target size={15} className="text-offering-600" /> {t('projects.topContributors')}
        </h2>
        {contributors.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-400">{t('projects.noContributions')}</p>
        ) : (
          <ul className="space-y-2">
            {contributors.slice(0, 6).map((c) => (
              <li key={c.key} className="flex items-center justify-between gap-3 border-b border-ink-100 pb-2 last:border-0 last:pb-0">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink-900">{c.name || t('common.anonymous')}</span>
                  <span className="text-xs text-ink-400">{t('projects.givenTimes', { n: c.times })}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-offering-700">{money(c.total, cur)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Pledges: promised money, with what has actually come in per pledge. */}
      <section className="rounded-xl border border-ink-200 bg-paper p-4">
        <h2 className="mb-3 font-display text-sm font-semibold">{t('projects.pledges')}</h2>
        {openPledges.length === 0 ? (
          <p className="py-3 text-center text-sm text-ink-400">{t('projects.noPledges')}</p>
        ) : (
          <ul className="space-y-3">
            {openPledges.map((p) => (
              <li key={p.id}>
                <p className="break-words text-sm font-medium text-ink-900">
                  {p.pledgeNameUnavailable ? t('common.nameUnavailable') : p.pledgeName || p.memberName || t('common.anonymous')}
                </p>
                <div className="mt-1.5">
                  <ProgressBar pct={p.fulfilmentPct} tone="people" value={`${money(p.fulfilledAmount, p.currency)} / ${money(p.amount, p.currency)}`} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* The ledger itself, so a pastor can answer "who gave what?". */}
      <section className="rounded-xl border border-ink-200 bg-paper p-4">
        <h2 className="mb-3 font-display text-sm font-semibold">{t('projects.ledger')}</h2>
        {contributions.length === 0 ? (
          <p className="py-3 text-center text-sm text-ink-400">{t('projects.noContributions')}</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {contributions.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink-900">
                    {c.giverNameUnavailable ? t('common.nameUnavailable') : c.giverName || t('common.anonymous')}
                  </span>
                  <span className="text-xs text-ink-400">{c.date}{c.service ? ` · ${c.service}` : ''}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums text-offering-700">{money(c.amount, c.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
