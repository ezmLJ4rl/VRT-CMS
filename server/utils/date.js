// All date handling goes through here so "today", date grouping, and display
// use one consistent timezone (configurable; the church operates in East
// Africa Time). Never use bare new Date().toISOString().slice(0, 10), that is
// UTC and off by hours in this timezone.

const TIMEZONE = process.env.APP_TIMEZONE || 'Africa/Dar_es_Salaam';

/** Local calendar date (YYYY-MM-DD) in the configured timezone. */
function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Local date for a given Date object (YYYY-MM-DD) in the configured timezone. */
function toLocalISO(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** Short human date (e.g. 11 Sep 2026) in the configured timezone. */
function formatDate(dateISO) {
  if (!dateISO) return '';
  const d = new Date(`${dateISO}T12:00:00`);
  return new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric' }).format(d);
}

module.exports = { todayISO, toLocalISO, formatDate, TIMEZONE };