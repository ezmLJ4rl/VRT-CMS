import { describe, it, expect } from 'vitest';
import i18n from './i18n';
import { money, daysLabel, contributorSeries, giverLabel, STATUS_TONE } from './projectView';

const t = (key, params) => i18n.t(key, params);

describe('project view helpers', () => {
  it('formats money in the project currency', () => {
    expect(money(1234567, 'TZS')).toBe('1,234,567 TZS');
    expect(money(0, 'USD')).toBe('0 USD');
    expect(money(null, 'TZS')).toBe('0 TZS');
  });

  it('states the timeline in words, including when it is late', () => {
    const running = daysLabel({ elapsedDays: 10, remainingDays: 12, overdue: false }, t);
    expect(running).toContain('10');
    expect(running).toContain('12');

    const late = daysLabel({ elapsedDays: 400, remainingDays: -3, overdue: true }, t);
    expect(late).toContain('overdue');
    expect(late).toContain('3');

    const noTarget = daysLabel({ elapsedDays: 5, remainingDays: null, overdue: false }, t);
    expect(noTarget).toContain('No target date');
  });

  it('falls back to the raw start date when elapsed days are unknown', () => {
    expect(daysLabel({ startedOn: '2026-01-05', elapsedDays: null, remainingDays: null }, t)).toContain('2026-01-05');
    expect(daysLabel(null, t)).toBe('');
  });

  it('charts the top contributors, biggest first and capped', () => {
    const contributors = Array.from({ length: 9 }, (_, i) => ({ name: `Giver ${i}`, total: 100 - i }));
    const series = contributorSeries(contributors, 6);
    expect(series).toHaveLength(6);
    expect(series[0]).toEqual({ label: 'Giver 0', value: 100 });
  });

  it('keeps anonymous, unavailable and named givers apart', () => {
    expect(giverLabel({ giverName: 'Elisha Makala' }, t)).toBe('Elisha Makala');
    expect(giverLabel({ giverName: null, giverNameUnavailable: true }, t)).toBe('Name unavailable');
    expect(giverLabel({ giverName: null, giverNameUnavailable: false }, t)).toBe('Anonymous');
  });

  it('colours each project status by its meaning', () => {
    expect(STATUS_TONE.active).toBe('category-success');
    expect(STATUS_TONE.on_hold).toBe('category-amber');
    expect(STATUS_TONE.completed).toBe('category-ink');
  });
});
