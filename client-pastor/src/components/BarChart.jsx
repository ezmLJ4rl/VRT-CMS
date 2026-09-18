import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bar, BarChart as RechartsBarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useReducedMotion } from 'motion/react';
import { axisFor } from '../chartScale';
import useTooltipOnDemand from './useTooltipOnDemand';
import { DURATION } from '../motion';

// Real vertical bar chart (Recharts): axis, tooltip, legend, load animation.
// `data` is [{label, ...}] and `valueKey` is the numeric field to plot.
// Category tones come from the VRT family system: attendance → green,
// offerings/money → red; each category gets its own distinguishable tint.
const FAMILIES = {
  people: ['var(--color-people-700)', 'var(--color-people-600)', 'var(--color-people-500)', 'var(--color-people-800)', 'var(--color-people-400)', 'var(--color-people-900)', 'var(--color-people-300)'],
  offering: ['var(--color-offering-700)', 'var(--color-offering-600)', 'var(--color-offering-500)', 'var(--color-offering-800)', 'var(--color-offering-400)', 'var(--color-offering-300)'],
  brand: ['var(--color-brand-700)', 'var(--color-brand-600)', 'var(--color-brand-500)', 'var(--color-brand-800)'],
  ink: ['var(--color-ink-700)', 'var(--color-ink-600)', 'var(--color-ink-800)', 'var(--color-ink-500)'],
};

function compact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${parseFloat((n / 1e6).toFixed(abs >= 1e7 ? 0 : 1))}M`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${n}`;
}

function ChartTooltip({ active, payload, label, format }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="max-w-[240px] rounded-lg border border-ink-200 bg-paper px-3 py-2 shadow-lg">
      <p className="text-xs font-medium text-ink-500">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-ink-900">
        {format ? format(payload[0].value) : Number(payload[0].value).toLocaleString()}
      </p>
    </div>
  );
}

export default function BarChart({
  data,
  valueKey = 'value',
  name,
  tone,
  accent,
  format,
  height = 230,
  emptyMessage,
}) {
  const { t } = useTranslation();
  // The chart's own animation is the only one on these bars. Recharts draws in
  // JS rather than CSS, so the global prefers-reduced-motion rule cannot reach
  // it: the setting is read here and the draw-in dropped for those users.
  const reduced = useReducedMotion();

  const family = useMemo(() => {
    if (tone) return tone;
    const m = /bg-(people|offering|brand)\b/.exec(accent || '');
    return m ? m[1] : 'ink';
  }, [tone, accent]);

  const rows = useMemo(() => (data || []).filter((d) => d[valueKey] != null), [data, valueKey]);
  const tooltipVisible = useTooltipOnDemand();
  const max = useMemo(() => rows.reduce((m, d) => Math.max(m, Number(d[valueKey]) || 0), 0), [rows, valueKey]);
  const axis = useMemo(() => axisFor(max), [max]);

  const colors = FAMILIES[family] || FAMILIES.ink;
  // Only a caller that omits `name` reaches this fallback, so it must resolve to
  // keys that exist in *this* app's catalog. (The pastor app has no `reports`
  // section; pointing at one rendered a raw key.)
  const seriesName =
    name ||
    (family === 'people' ? t('records.attendanceSummary') : family === 'offering' ? t('records.offeringsSummary') : valueKey);

  // Nothing to plot. Callers that pass `emptyMessage` want that stated plainly
  // (a chart of zeroes reads as a scale bug); callers that don't still get the
  // old "render nothing" behaviour.
  if (!rows.length || max <= 0) {
    if (!emptyMessage) return null;
    return (
      <div
        className="flex items-center justify-center rounded-lg border border-dashed border-ink-200 px-4 text-center text-sm text-ink-400"
        style={{ height }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <RechartsBarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: -10 }} barCategoryGap="24%">
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-ink-100)" vertical={false} />
            <XAxis
              dataKey="label"
              interval={0}
              tick={{ fontSize: 11, fill: 'var(--color-ink-400)' }}
              tickLine={{ stroke: 'var(--color-ink-200)' }}
              axisLine={{ stroke: 'var(--color-ink-200)' }}
              tickFormatter={(v) => (v && v.length > 13 ? `${v.slice(0, 12)}…` : v)}
            />
            <YAxis
              width={46}
              allowDecimals={false}
              domain={[0, axis.top]}
              ticks={axis.ticks}
              tick={{ fontSize: 11, fill: 'var(--color-ink-400)' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={compact}
            />
            <Tooltip
              trigger="hover"
              active={tooltipVisible ? undefined : false}
              content={<ChartTooltip format={format} />}
              cursor={{ fill: 'var(--color-ink-50)' }}
            />
            <Bar
              dataKey={valueKey}
              name={seriesName}
              radius={[4, 4, 0, 0]}
              maxBarSize={56}
              isAnimationActive={!reduced}
              animationDuration={DURATION.chart * 1000}
              animationEasing="ease-out"
            >
              {rows.map((r, i) => (
                <Cell key={`${valueKey}-${i}`} fill={colors[i % colors.length]} />
              ))}
            </Bar>
          </RechartsBarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {rows.map((r, i) => (
          <li key={`${r.label}-${i}`} className="flex items-center gap-1.5 text-xs text-ink-600">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colors[i % colors.length] }} />
            {r.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
