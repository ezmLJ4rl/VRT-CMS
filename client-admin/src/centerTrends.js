import { locale } from './format';

/*
 * The reading behind a center's trend line, kept out of the component: it is a
 * rule about numbers, and it should be testable (and read) without a chart.
 */

/**
 * Month key ('2026-08') as a short localized label ('Aug 2026').
 *
 * Formatted from UTC so the label can never slide into the neighbouring month
 * for a reader in another timezone.
 */
export function monthLabel(key, lang) {
  const [year, month] = String(key).split('-').map(Number);
  return new Intl.DateTimeFormat(locale(lang), { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1))
  );
}

/**
 * Geometry for one sparkline, as SVG path strings.
 *
 * Scaling includes zero, so a series that never leaves the floor is drawn on the
 * floor: the shape of the thing, not an artefact of its maximum.
 *
 * A completely flat series is the exception. Whatever its level, it has no range
 * to scale to, and a line pinned to an edge reads as a divider rather than as
 * "steady", so it is drawn through the middle, where it says what it means.
 */
export function sparkGeometry(values, width = 84, height = 24, pad = 2) {
  const points = (values || []).map(Number);
  const max = Math.max(0, ...points);
  const min = Math.min(0, ...points);
  const span = max - min;
  const flat = points.length > 0 && Math.max(...points) === Math.min(...points);
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const y = (v) => (flat ? height / 2 : height - pad - ((v - min) / span) * (height - pad * 2));
  const coords = points.map((v, i) => [i * step, y(v)]);
  const line = coords.map(([x, py], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${py.toFixed(1)}`).join(' ');
  const [lastX, lastY] = coords[coords.length - 1] || [0, height / 2];
  return { line, area: `${line} L${width},${height} L0,${height} Z`, lastX, lastY };
}

/**
 * The direction of a series, as a percent change from the average of the earlier
 * months to the latest one.
 *
 * The latest COMPLETE month is compared against the mean of the months before it
 * rather than against just the previous one: one quiet or one exceptional month
 * would otherwise be reported as a trend. A change under FLAT_BELOW percent is
 * called steady, so ordinary week-to-week noise is not dressed up as growth.
 */
const FLAT_BELOW = 3;

export function trendOf(values) {
  const points = (values || []).map(Number);
  if (points.length < 2) return null;
  const latest = points[points.length - 1];
  const prior = points.slice(0, -1);
  const baseline = prior.reduce((sum, n) => sum + n, 0) / prior.length;
  if (baseline === 0) {
    // Nothing to compare against: either nothing is happening at all, or it
    // started now. Those read very differently, so they are different answers.
    return { direction: latest === 0 ? 'none' : 'new', percent: null, latest };
  }
  const change = (latest - baseline) / baseline;
  const percent = Math.round(change * 100);
  if (Math.abs(percent) < FLAT_BELOW) return { direction: 'steady', percent, latest };
  return { direction: percent > 0 ? 'up' : 'down', percent, latest };
}
