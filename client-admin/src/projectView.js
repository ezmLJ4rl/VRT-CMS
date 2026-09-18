/*
 * Presentation helpers shared by the projects list and detail pages.
 *
 * Deliberately presentation only: no money is calculated here. Every figure on a
 * project page comes from /api/projects, which sums the real offering ledger:
 * a client-side total would be a second opinion about the same money, and the
 * whole point of this section is that there is only one.
 */

// Status colours follow the established job-based system: active work is the
// people green, anything waiting is amber, finished work is neutral ink.
export const STATUS_TONE = {
  active: 'category-success',
  on_hold: 'category-amber',
  completed: 'category-ink',
};

export function money(amount, currency = 'TZS') {
  return `${Number(amount || 0).toLocaleString()} ${currency}`;
}

/** "Started 32 days ago · 118 days left": the timeline in words. */
export function daysLabel(timeline, t) {
  if (!timeline) return '';
  const parts = [];
  if (timeline.elapsedDays !== null && timeline.elapsedDays !== undefined) {
    parts.push(t('projects.runningFor', { n: Math.max(0, timeline.elapsedDays) }));
  } else if (timeline.startedOn) {
    parts.push(t('projects.startedOnDate', { date: timeline.startedOn }));
  }
  if (timeline.remainingDays === null || timeline.remainingDays === undefined) {
    parts.push(t('projects.noTarget'));
  } else if (timeline.overdue) {
    parts.push(t('projects.overdueBy', { n: Math.abs(timeline.remainingDays) }));
  } else {
    parts.push(t('projects.daysRemaining', { n: timeline.remainingDays }));
  }
  return parts.join(' · ');
}

/** Top contributors as a chart series (biggest first, capped for legibility). */
export function contributorSeries(contributors, limit = 6) {
  return (contributors || [])
    .slice(0, limit)
    .map((c) => ({ label: c.name || 'Anonymous', value: c.total }));
}

/** Category label for a ledger row that has no giver name. */
export function giverLabel(row, t) {
  if (row.giverName) return row.giverName;
  if (row.giverNameUnavailable) return t('common.nameUnavailable');
  return t('common.anonymous');
}
