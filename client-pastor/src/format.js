function locale(lang) {
  return lang === 'sw' ? 'sw-TZ' : 'en-GB';
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const s = String(value);
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? `${s}T12:00:00`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)
      ? `${s.replace(' ', 'T')}Z`
      : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(value, lang) {
  const d = toDate(value);
  if (!d) return value || '';
  return new Intl.DateTimeFormat(locale(lang), { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
}

export function formatDateTime(value, lang) {
  const d = toDate(value);
  if (!d) return value || '';
  return new Intl.DateTimeFormat(locale(lang), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function formatMoney(value, currency = 'TZS') {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0)) + ' ' + currency;
}