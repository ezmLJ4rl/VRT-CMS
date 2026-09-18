import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from 'motion/react';
import { DURATION } from '../motion';

const COLORS = {
  attendance: 'var(--color-people-700)',
  offering: 'var(--color-offering-700)',
};

function shortDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(date);
}

function compact(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (Math.abs(number) >= 1e3) return `${Math.round(number / 1e3)}k`;
  return number.toLocaleString();
}

function MetricChart({ data, dataKey, color, format, showAxis = false }) {
  const reduced = useReducedMotion();
  return (
    <div className="h-28 min-w-0">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 6, right: 6, bottom: showAxis ? 0 : 4, left: -12 }}>
          <XAxis
            dataKey="period"
            hide={!showAxis}
            interval="preserveStartEnd"
            tick={{ fontSize: 10, fill: 'var(--color-ink-400)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--color-ink-200)' }}
            tickFormatter={shortDate}
          />
          <YAxis
            width={34}
            allowDecimals={false}
            tick={{ fontSize: 10, fill: 'var(--color-ink-400)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={compact}
          />
          <Tooltip
            labelFormatter={shortDate}
            formatter={(value) => [format(value), dataKey === 'attendance' ? 'Attendance' : 'Offering']}
            contentStyle={{ borderRadius: 8, borderColor: 'var(--color-ink-200)', background: 'var(--color-paper)', fontSize: 12 }}
            itemStyle={{ color: 'var(--color-ink-800)' }}
          />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={color}
            strokeWidth={2.5}
            dot={{ r: 2, fill: 'var(--color-paper)', strokeWidth: 1.5 }}
            activeDot={{ r: 4 }}
            isAnimationActive={!reduced}
            animationDuration={DURATION.chart * 1000}
            animationEasing="ease-out"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function Metric({ label, value, color, children }) {
  return (
    <div className="min-w-0 rounded-lg border border-ink-100 bg-ink-50/40 p-2.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-600">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-ink-800">{value}</span>
      </div>
      {children}
    </div>
  );
}

export default function ServiceTrendGrid({ services = [], currency = 'TZS' }) {
  const { t } = useTranslation();
  if (!services.length || !services.some((service) => service.points?.length)) {
    return <p className="py-10 text-center text-sm text-ink-400">{t('common.empty')}</p>;
  }

  return (
    <div>
      <p className="mb-4 text-xs text-ink-400">{t('reports.serviceTrendHint')}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {services.map((service) => {
          const points = service.points || [];
          const latest = points[points.length - 1] || { attendance: 0, offering: 0 };
          return (
            <article key={service.key} className="rounded-xl border border-ink-200 bg-paper p-3 shadow-xs">
              <h3 className="mb-3 truncate font-display text-base font-semibold text-ink-900" title={service.label}>
                {service.label}
              </h3>
              <div className="space-y-2">
                <Metric
                  label={t('reports.peopleAttend')}
                  value={Number(latest.attendance || 0).toLocaleString()}
                  color={COLORS.attendance}
                >
                  <MetricChart data={points} dataKey="attendance" color={COLORS.attendance} format={(value) => Number(value).toLocaleString()} />
                </Metric>
                <Metric
                  label={t('reports.offeringsHeader')}
                  value={`${Number(latest.offering || 0).toLocaleString()} ${currency}`}
                  color={COLORS.offering}
                >
                  <MetricChart data={points} dataKey="offering" color={COLORS.offering} format={(value) => `${Number(value).toLocaleString()} ${currency}`} showAxis />
                </Metric>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
