// Shared, locale-aware formatting so dates read the same everywhere: "11 Sept 2026".
export function locale(lang) {
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

export function formatDateShort(value, lang) {
  const d = toDate(value);
  if (!d) return value || '';
  return new Intl.DateTimeFormat(locale(lang), { day: 'numeric', month: 'short' }).format(d);
}

export function formatDateTime(value, lang) {
  const d = toDate(value);
  if (!d) return value || '';
  return new Intl.DateTimeFormat(locale(lang), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}

// Resolves an offering category to a human label: prefer the database name,
// fall back to an i18n key, and never show a raw key.
export function offeringLabel(t, { name, key } = {}) {
  if (name) return name;
  if (key) {
    const translated = t(`offeringCat.${key}`);
    if (translated !== `offeringCat.${key}`) return translated;
    return key.charAt(0).toUpperCase() + key.slice(1);
  }
  return '';
}