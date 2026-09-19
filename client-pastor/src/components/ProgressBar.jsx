/* The Pastor counterpart of the CMS progress primitive: same meaning, same visual language. */
const FILLS = {
  offering: 'bg-offering-600',
  people: 'bg-people-600',
  brand: 'bg-brand-600',
  amber: 'bg-amber-500',
};

export default function ProgressBar({ pct, tone = 'offering', value, label, hint }) {
  const fill = FILLS[tone] || FILLS.offering;
  const known = pct !== null && pct !== undefined && Number.isFinite(Number(pct));
  const numeric = known ? Number(pct) : 0;
  const clamped = Math.min(100, Math.max(0, numeric));
  const width = known && clamped > 0 && clamped < 1.5 ? 1.5 : clamped;
  const text = known ? `${numeric}%` : 'Not available';

  return (
    <div className="min-w-0">
      {(label || value) && (
        <div className="mb-2 flex min-w-0 items-baseline justify-between gap-3">
          {label && <span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</span>}
          {value && <span className="shrink-0 text-sm font-semibold tabular-nums text-ink-900">{value}</span>}
        </div>
      )}
      <div
        className="relative h-3 w-full overflow-hidden rounded-full border border-ink-200 bg-ink-50 p-0.5"
        role="progressbar"
        aria-valuenow={known ? clamped : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={text}
        aria-label={label || 'Progress'}
        title={known ? text : 'Progress is not available'}
      >
        {known && clamped > 0 && (
          <div
            className={`h-full min-w-0 rounded-full ${fill} transition-[width] duration-500 ease-out`}
            style={{ width: `${width}%` }}
          />
        )}
      </div>
      {hint && <p className="mt-1.5 min-w-0 truncate text-xs text-ink-400">{hint}</p>}
    </div>
  );
}
