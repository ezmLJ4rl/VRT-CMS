import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import BarChart from './BarChart';
import { axisFor } from '../chartScale';
import '../i18n'; // initialises the i18n instance the chart translates through

describe('BarChart axis: scaled to the data, never a fixed range', () => {
  it('fits a 44-person service on a 0–50 axis rather than the default 0–4', () => {
    // The reported symptom: a real figure drawn against an arbitrary tiny scale.
    expect(axisFor(44)).toEqual({ top: 50, ticks: [0, 10, 20, 30, 40, 50] });
  });

  it('keeps small counts exact instead of padding them out', () => {
    expect(axisFor(4)).toEqual({ top: 4, ticks: [0, 1, 2, 3, 4] });
    expect(axisFor(1)).toEqual({ top: 1, ticks: [0, 1] });
    expect(axisFor(12)).toEqual({ top: 15, ticks: [0, 5, 10, 15] });
  });

  it('handles money magnitudes without inventing decimals', () => {
    expect(axisFor(20000)).toEqual({ top: 20000, ticks: [0, 5000, 10000, 15000, 20000] });
    expect(axisFor(98500)).toEqual({ top: 100000, ticks: [0, 20000, 40000, 60000, 80000, 100000] });
  });

  it('always covers the tallest bar in a handful of whole-number ticks', () => {
    for (const max of [1, 3, 7, 9, 11, 18, 44, 97, 120, 999, 4800, 123456]) {
      const { top, ticks } = axisFor(max);
      expect(top).toBeGreaterThanOrEqual(max);
      expect(ticks[0]).toBe(0);
      expect(ticks[ticks.length - 1]).toBe(top);
      expect(ticks.length).toBeLessThanOrEqual(6);
      for (const tick of ticks) expect(Number.isInteger(tick)).toBe(true);
    }
  });

  it('stays a usable axis even when asked for zero, so it can never go degenerate', () => {
    // Unreachable from BarChart, which shows the empty state first, but a
    // scale of [0, 0] would be a trap for the next caller.
    expect(axisFor(0)).toEqual({ top: 1, ticks: [0, 1] });
    expect(axisFor(-5)).toEqual({ top: 1, ticks: [0, 1] });
  });
});

describe('BarChart empty states', () => {
  it('states that nothing is recorded instead of drawing a zero-valued scale', () => {
    render(<BarChart data={[]} valueKey="value" emptyMessage="No attendance recorded yet today." />);

    expect(screen.getByText('No attendance recorded yet today.')).toBeInTheDocument();
  });

  it('treats an all-zero dataset as empty too, that is what produced the 0–4 axis', () => {
    const rows = [
      { label: '1st Sunday Service', value: 0 },
      { label: 'Wednesday Service', value: 0 },
    ];
    render(<BarChart data={rows} valueKey="value" emptyMessage="No attendance recorded yet today." />);

    expect(screen.getByText('No attendance recorded yet today.')).toBeInTheDocument();
  });

  it('still renders nothing at all for callers that did not ask for an empty state', () => {
    const { container } = render(<BarChart data={[]} valueKey="value" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('draws the chart and its legend once there is something to plot', () => {
    const rows = [
      { label: '1st Sunday Service · Sunday School', value: 12 },
      { label: '1st Sunday Service · Main Service', value: 44 },
    ];
    render(<BarChart data={rows} valueKey="value" emptyMessage="No attendance recorded yet today." />);

    expect(screen.queryByText('No attendance recorded yet today.')).not.toBeInTheDocument();
    expect(screen.getByText('1st Sunday Service · Sunday School')).toBeInTheDocument();
    expect(screen.getByText('1st Sunday Service · Main Service')).toBeInTheDocument();
  });
});
