import { describe, it, expect } from 'vitest';
import { monthLabel, sparkGeometry, trendOf } from './centerTrends';

/*
 * The badge is the part a leader acts on ("this area is fading"), so the rule
 * behind it is tested on its own rather than through a rendered chart.
 */
describe('trendOf', () => {
  it('compares the latest month with the average of the ones before it', () => {
    // 160 against a mean of 120 is a third more, and one quiet middle month
    // (the 120) must not be allowed to look like the trend on its own.
    expect(trendOf([100, 110, 120, 130, 140, 160])).toMatchObject({ direction: 'up', percent: 33, latest: 160 });
  });

  it('reads a fall as a fall', () => {
    expect(trendOf([80, 70, 60, 50, 40, 20])).toMatchObject({ direction: 'down', percent: -67, latest: 20 });
  });

  it('calls ordinary noise steady instead of dressing it up as growth', () => {
    expect(trendOf([100, 100, 100, 100, 100, 102])).toMatchObject({ direction: 'steady' });
    expect(trendOf([100, 100, 100, 100, 100, 98])).toMatchObject({ direction: 'steady' });
  });

  it('separates "nothing is happening" from "it just started"', () => {
    expect(trendOf([0, 0, 0, 0, 0, 0])).toMatchObject({ direction: 'none', percent: null });
    expect(trendOf([0, 0, 0, 0, 0, 40])).toMatchObject({ direction: 'new', percent: null, latest: 40 });
  });

  it('has no opinion about a series too short to compare', () => {
    expect(trendOf([])).toBeNull();
    expect(trendOf([120])).toBeNull();
    expect(trendOf(undefined)).toBeNull();
  });
});

describe('sparkGeometry', () => {
  const points = (path) => path.slice(1).split(/[L ]+/).filter(Boolean).map((pair) => pair.split(',').map(Number));

  it('keeps every point inside the box, whatever the values', () => {
    for (const values of [[0, 0, 0, 0, 0, 0], [100, 110, 120, 130, 140, 160], [0, 0, 5], [900, 4, 250, 0]]) {
      const { line, lastY } = sparkGeometry(values, 84, 24);
      for (const [x, y] of points(line)) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(84);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(24);
      }
      expect(lastY).toBeGreaterThanOrEqual(0);
      expect(lastY).toBeLessThanOrEqual(24);
    }
  });

  it('draws a rising series upward, one step per month', () => {
    const { line } = sparkGeometry([100, 200, 300], 84, 24);
    const ys = points(line).map(([, y]) => y);
    expect(ys[0]).toBeGreaterThan(ys[1]);
    expect(ys[1]).toBeGreaterThan(ys[2]);
    // Three points across the full width, evenly spaced.
    expect(points(line).map(([x]) => x)).toEqual([0, 42, 84]);
  });

  it('draws a flat series through the middle rather than along the floor', () => {
    // A line pinned to the bottom edge reads as a divider, not as "steady".
    for (const values of [[0, 0, 0], [250, 250, 250]]) {
      const ys = points(sparkGeometry(values, 84, 24).line).map(([, y]) => y);
      expect(new Set(ys).size).toBe(1);
      expect(ys[0]).toBeCloseTo(12, 5);
    }
  });

  it('gives a one-month series a point instead of a NaN path', () => {
    const { line, lastX } = sparkGeometry([120], 84, 24);
    expect(line).not.toMatch(/NaN/);
    expect(lastX).toBe(0);
    expect(sparkGeometry([], 84, 24).line).toBe('');
  });
});

describe('monthLabel', () => {
  it('names a month key without sliding into a neighbouring month', () => {
    // Parsed in UTC, so a reader east or west of the church still sees the month
    // the figure belongs to.
    expect(monthLabel('2026-08', 'en')).toBe('Aug 2026');
    expect(monthLabel('2026-01', 'en')).toBe('Jan 2026');
  });

  it('follows the interface language', () => {
    expect(monthLabel('2026-08', 'sw')).not.toBe('Aug 2026');
  });
});
