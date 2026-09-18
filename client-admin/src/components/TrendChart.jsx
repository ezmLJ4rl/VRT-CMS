import { Line, LineChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from 'motion/react';
import { DURATION } from '../motion';

function compact(n) {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${parseFloat((n / 1e6).toFixed(abs >= 1e7 ? 0 : 1))}M`;
  if (abs >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${n}`;
}

function TrendTooltip({ active, payload, label, format }) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter((p) => p.value != null).sort((a, b) => Number(b.value) - Number(a.value));
  if (!rows.length) return null;
  return (
    <div className="min-w-44 rounded-lg border border-ink-200 bg-paper px-3 py-2 shadow-lg">
      <p className="mb-1.5 border-b border-ink-100 pb-1.5 text-xs font-semibold text-ink-700">{label}</p>
      {rows.map((p) => (
        <p key={p.dataKey} className="flex items-center justify-between gap-4 py-0.5 text-xs">
          <span className="flex min-w-0 items-center gap-1.5 text-ink-600">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} />
            <span className="truncate">{p.name}</span>
          </span>
          <span className="font-semibold tabular-nums text-ink-900">
            {format ? format(p.value) : Number(p.value).toLocaleString()}
          </span>
        </p>
      ))}
    </div>
  );
}

export default function TrendChart({ data, series = [], format, height = 260 }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();

  if (!data?.length || !series.length) {
    return <p className="py-16 text-center text-sm text-ink-400">{t('common.empty')}</p>;
  }

  return (
    <div className="service-trend-chart">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-400">{t('admin.attendanceTrendsHint')}</p>
        <span className="rounded-full bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-500">{t('admin.weeklyView')}</span>
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke="var(--color-ink-100)" vertical={false} />
            <XAxis
              dataKey="label"
              interval="preserveStartEnd"
              tick={{ fontSize: 11, fill: 'var(--color-ink-400)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-ink-200)' }}
              tickFormatter={(value) => (value && value.length > 13 ? `${value.slice(0, 12)}…` : value)}
            />
            <YAxis
              width={42}
              allowDecimals={false}
              tick={{ fontSize: 11, fill: 'var(--color-ink-400)' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={compact}
            />
            <Tooltip
              content={<TrendTooltip format={format} />}
              cursor={{ stroke: 'var(--color-ink-300)', strokeDasharray: '4 4' }}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.name}
                stroke={s.color}
                strokeWidth={2.5}
                dot={{ r: 2.5, strokeWidth: 1, fill: 'var(--color-paper)' }}
                activeDot={{ r: 5, strokeWidth: 2, fill: 'var(--color-paper)' }}
                connectNulls
                isAnimationActive={!reduced}
                animationDuration={DURATION.chart * 1000}
                animationEasing="ease-out"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 border-t border-ink-100 pt-3">
        {series.map((s) => (
          <span key={s.key} className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ink-600">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
            <span className="truncate">{s.name}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
