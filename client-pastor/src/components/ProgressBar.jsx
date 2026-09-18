/*
 * Funding progress bar.
 *
 * The fill is the offerings red family, the same colour money carries everywhere
 * else, so a project bar reads as funding without a label. `pct` may be null,
 * a project with no goal has no percentage to state, and the bar shows an empty
 * track rather than pretending to be 0%. A started project always keeps a sliver
 * so "just begun" and "nothing at all" look different.
 */
const FILLS = {
  offering: 'bg-offering-600',
  people: 'bg-people-600',
};

export default function ProgressBar({ pct, tone = 'offering', value, label, hint }) {
  const fill = FILLS[tone] || FILLS.offering;
  const known = pct !== null && pct !== undefined && !Number.isNaN(pct);
  const clamped = known ? Math.min(100, Math.max(0, pct)) : 0;
  const width = known && clamped > 0 && clamped < 2 ? 2 : clamped;

  return (
    <div>
      {(label || value) && (
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          {label && <span className="text-xs font-medium text-ink-500">{label}</span>}
          {value && <span className="text-sm font-semibold tabular-nums text-ink-900">{value}</span>}
        </div>
      )}
      <div
        className="h-2.5 w-full overflow-hidden rounded-full bg-ink-100"
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
