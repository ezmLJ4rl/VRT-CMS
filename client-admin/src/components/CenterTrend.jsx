import { useTranslation } from 'react-i18next';
import { HandCoins, Minus, TrendingDown, TrendingUp, Users } from 'lucide-react';
import { monthLabel, sparkGeometry, trendOf } from '../centerTrends';

/**
 * How one center is moving: a sparkline and a change badge for attendance and
 * for giving across the same window of complete months.
 *
 * Two series rather than one because they answer different questions, a center
 * can be growing in people while its giving fades, and they carry incomparable
 * units, so each sparkline is scaled to its own range. The reading behind the
 * badges lives in ../centerTrends, where it can be tested without a chart.
 */

const W = 84;
const H = 24;

function Spark({ values, color, summary }) {
  const { line, area, lastX, lastY } = sparkGeometry(values, W, H);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0" aria-hidden="true">
      {/* The numbers behind the line, on hover: a sparkline shows a shape, and
          the exact figures are what a leader repeats out loud. */}
      <title>{summary}</title>
      <path d={area} fill={color} opacity="0.12" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r="2" fill={color} />
    </svg>
  );
}

const BADGE = {
  up: { className: 'bg-people-50 text-people-800', Icon: TrendingUp },
  down: { className: 'bg-danger-50 text-danger-700', Icon: TrendingDown },
  steady: { className: 'bg-ink-100 text-ink-600', Icon: Minus },
  new: { className: 'bg-brand-50 text-brand-800', Icon: TrendingUp },
  none: { className: 'bg-ink-100 text-ink-500', Icon: Minus },
};

function ChangeBadge({ trend }) {
  const { t } = useTranslation();
  if (!trend) return null;
  const { className, Icon } = BADGE[trend.direction] || BADGE.none;
  const text =
    trend.direction === 'up' || trend.direction === 'down'
      ? `${trend.percent > 0 ? '+' : '−'}${Math.abs(trend.percent)}%`
      : t(`centers.trend_${trend.direction}`);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums ${className}`}
      // Spelled out for a screen reader and a hover: a bare "+12%" beside a
      // green dot doesn't say what it is a change OF.
      title={t('centers.trendBadgeTitle')}
    >
      <Icon size={11} /> {text}
    </span>
  );
}

export default function CenterTrend({ months = [], attendance = [], offering = [], format }) {
  const { t, i18n } = useTranslation();

  const series = [
    {
      key: 'attendance',
      label: t('centers.trendAttendance'),
      Icon: Users,
      color: 'var(--color-people-600)',
      values: attendance,
      format: (v) => Number(v).toLocaleString(),
    },
    {
      key: 'offering',
      label: t('centers.trendGiving'),
      Icon: HandCoins,
      color: 'var(--color-offering-600)',
      values: offering,
      format: format || ((v) => Number(v).toLocaleString()),
    },
  ];

  const labels = months.map((m) => monthLabel(m, i18n.language));
  const lastMonth = labels[labels.length - 1];

  return (
    <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
      {series.map((s) => {
        const latest = s.values[s.values.length - 1] ?? 0;
        // A series with nothing in it draws no line and no last figure: an empty
        // sparkline is six months of nothing to look at, and the badge has
        // already said so in words.
        const silent = s.values.every((v) => Number(v) === 0);
        return (
          <div key={s.key} className="min-w-[190px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-600">
                <s.Icon size={13} className="text-ink-400" />
                {s.label}
              </span>
              <ChangeBadge trend={trendOf(s.values)} />
            </div>
            {!silent && (
              <div className="mt-0.5 flex items-center gap-2">
                <Spark
                  values={s.values}
                  color={s.color}
                  summary={labels.map((label, i) => `${label}: ${s.format(s.values[i] ?? 0)}`).join(' · ')}
                />
                <span className="text-xs text-ink-500">
                  {t('centers.trendLatest', { month: lastMonth, value: s.format(latest) })}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
