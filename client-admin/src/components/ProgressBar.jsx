/*
 * Progress bar for funding and pledge fulfilment.
 *
 * One primitive so a project page reads as one system: the bar is always the
 * category colour (offerings → the red family), the fill is labelled, and a
 * nearly-empty bar still shows a sliver so "started" and "never started" are
 * visually different. `pct` may be null: a project with no goal, or with no
 * pledges yet, has no percentage to state, and the bar says so instead of
 * pretending to be 0%.
 */
const FILLS = {
  offering: 'bg-offering-600',
  people: 'bg-people-600',
  brand: 'bg-brand-600',
  amber: 'bg-amber-500',
};

export default function ProgressBar({ pct, tone = 'offering', height = 'h-2.5', label, value, hint }) {
  const fill = FILLS[tone] || FILLS.offering;
  const known = pct !== null && pct !== undefined && !Number.isNaN(pct);
  const clamped = known ? Math.min(100, Math.max(0, pct)) : 0;
  const width = known && clamped > 0 && clamped < 2 ? 2 : clamped;

  return (
    <div>
      {(value || label) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          {label && <span className="text-xs font-medium text-ink-500">{label}</span>}
          {value && <span className="font-display text-sm font-semibold tabular-nums text-ink-900">{value}</span>}
        </div>
      )}
      <div
        className={`w-full overflow-hidden rounded-full bg-ink-100 ${height}`}
        role="progressbar"
        aria-valuenow={known ? clamped : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className={`h-full rounded-full transition-all ${fill}`} style={{ width: `${width}%` }} />
      </div>
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}
