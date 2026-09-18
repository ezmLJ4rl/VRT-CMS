/**
 * Tick values for a chart's Y axis, derived from the data it is about to plot.
 *
 * A fixed axis was the bug: with nothing recorded, Recharts falls back to a
 * default 0–4 domain, so an empty chart looked like a scale error. Callers show
 * an empty state when there is nothing to draw (see BarChart), and when there is
 * data this picks a 1/2/5-style step that fits the largest value into at most
 * five intervals, so the axis is scaled to what was actually recorded: a
 * 44-person service never sits on a 0–4 axis, and a 12-person one does not
 * stretch to 100.
 *
 * Returns { top, ticks }: the padded upper bound and the exact tick list, both
 * whole numbers wherever the data is whole.
 */
export function axisFor(max) {
  // Unreachable from BarChart, which shows its empty state before asking for an
  // axis, but a degenerate domain of [0, 0] would be a trap for the next caller.
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };

  let step = null;
  for (let magnitude = 0; magnitude < 12 && step === null; magnitude++) {
    for (const multiplier of [1, 2, 5]) {
      const candidate = multiplier * 10 ** magnitude;
      if (max / candidate <= 5) {
        step = candidate;
        break;
      }
    }
  }
  if (step === null) step = max;

  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = 0; value <= top + step / 1000; value += step) {
    ticks.push(Number(value.toFixed(4)));
  }
  return { top, ticks };
}
