'use strict';
/**
 * Server-side message localization: the one place that turns a message key into
 * the caller's language.
 *
 * Route handlers return KEYS, never prose:
 *
 *     res.status(400).json({ error: 'errors.amountRequired' });
 *     res.status(400).json({
 *       error: 'errors.categoryRequiresGiverFullName',
 *       params: { category: cat.name },
 *     });
 *
 * `middleware/locale.js` translates those keys on the way out using the language
 * the request asked for, so no handler ever deals with language and adding a
 * third language means adding one catalog file: no route changes.
 *
 * The English catalog is the source of truth for "is this string a key?":
 * a value is translated only when it exists in `en.json`. Anything else: an
 * interpolated sentence, a message from a library, or an unrelated payload field
 * that happens to be called `error`: is passed through untouched, so this layer
 * can never mangle a response it does not recognise.
 */
const catalogs = {
  en: require('./en.json'),
  sw: require('./sw.json'),
};

const DEFAULT_LOCALE = 'en';
const SUPPORTED_LOCALES = Object.keys(catalogs);

// The payload fields that carry human-readable text. Values are keys.
const TRANSLATABLE_FIELDS = ['error', 'message'];

/** `sw-KE`, `SW`, `sw_KE` → `sw`. Returns null when we have no catalog for it. */
function baseLocale(tag) {
  if (!tag || typeof tag !== 'string') return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.includes(base) ? base : null;
}

/**
 * Accept-Language, highest quality first: `sw,en-US;q=0.9` → sw, then en for
 * `en-US;q=0.9,sw;q=0.1`. Falls back to null when nothing matches.
 */
function fromAcceptLanguage(header) {
  if (!header || typeof header !== 'string') return null;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='));
      const quality = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag, quality: Number.isFinite(quality) ? quality : 0 };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.quality - a.quality);

  for (const entry of ranked) {
    const match = baseLocale(entry.tag);
    if (match) return match;
  }
  return null;
}

/**
 * Which language to answer this request in. Precedence: an explicit choice from
 * the app (X-Language, or ?lang= for links opened outside it), then the browser's
 * own Accept-Language, then English.
 */
function resolveLocale(req) {
  return (
    baseLocale(req.get('X-Language')) ||
    baseLocale(req.query && req.query.lang) ||
    fromAcceptLanguage(req.get('Accept-Language')) ||
    DEFAULT_LOCALE
  );
}

/** Replace `{name}` placeholders. A missing param stays visible rather than
 *  silently dropping text: a half-formed sentence should be obvious in dev. */
function interpolate(text, params) {
  if (!params || typeof params !== 'object') return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

/** True when this exact value is a key we know about. */
function isKnownKey(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(catalogs.en, key);
}

/** A catalog id we can actually look up: `sw-KE`/`SW`/`sw_KE` → `sw`, else English. */
function normalizeLocale(locale) {
  return baseLocale(locale) || DEFAULT_LOCALE;
}

/**
 * The Intl tag to format numbers and dates in for a catalog id: the same
 * mapping the two clients use in their format.js, so a date on a printed receipt
 * reads exactly as it does on screen ("11 Sept 2026", never "Sep 11, 2026").
 * Kiswahili also renames the currency: TZS formats as "TSh".
 */
const INTL_TAGS = { en: 'en-GB', sw: 'sw-TZ' };

function intlLocale(locale) {
  return INTL_TAGS[normalizeLocale(locale)] || INTL_TAGS[DEFAULT_LOCALE];
}

/**
 * A bound translator for text the server GENERATES rather than answers with:
 * a receipt, an event sheet, an SMS body. Those are built at a call site that
 * knows who will read them, so it needs a translator, not a key-then-translate
 * round trip through a response payload.
 *
 * Unlike `translate` (which returns null for anything it does not recognise, so
 * it can never mangle a JSON response), this ALWAYS returns a string: a document
 * cannot be assembled with a hole in it. An untranslated key degrades to English,
 * and a key that does not exist shows itself: visible in dev, and caught by the
 * catalog-integrity test rather than shipped.
 */
function translator(locale) {
  const table = catalogs[normalizeLocale(locale)];
  return (key, params) => {
    const text = table[key] !== undefined ? table[key] : catalogs.en[key];
    return text === undefined ? String(key) : interpolate(text, params);
  };
}

/**
 * Plurals without a plural-rule library: the catalog carries a `_one` and an
 * `_other` variant of a counted string and the count picks between them. English
 * and Kiswahili both get what they need: in Kiswahili the noun itself changes
 * ("kikao kimoja" / "vikao viwili"), so counting is the wrong axis anyway.
 */
function plural(t, count, oneKey, otherKey, params) {
  return t(count === 1 ? oneKey : otherKey, params);
}

/**
 * The label for an ENUM value (`choir` → `groups.kind_choir`), so a stored value
 * like a group's kind or an emergency's severity is never printed raw. The
 * signal that the lookup failed is `translator`'s own behaviour, it hands back
 * the key, so an unmapped value degrades to a readable "Worship Team" instead of
 * "groups.kind_worship_team".
 */
function enumLabel(t, prefix, value) {
  const key = `${prefix}${value}`;
  const label = t(key);
  if (label !== key) return label;
  return String(value == null ? '' : value).replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/**
 * Translate one key. Returns null when the value is not a key at all, which the
 * callers treat as "leave it alone". Falls back to English for a key that exists
 * in the English catalog but has no translation yet, so a missing translation
 * degrades to English rather than to a raw key.
 */
function translate(locale, key, params) {
  if (!isKnownKey(key)) return null;
  const table = catalogs[baseLocale(locale) || DEFAULT_LOCALE];
  const text = table[key] !== undefined ? table[key] : catalogs.en[key];
  return interpolate(text, params);
}

/**
 * Translate the text fields of a JSON response body in place-ish (returns a new
 * object only when something changed). `params` is an internal detail of the
 * call site, so it is stripped from anything it was used to translate.
 */
function localizePayload(payload, locale) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  let localized = null;
  for (const field of TRANSLATABLE_FIELDS) {
    const text = translate(locale, payload[field], payload.params);
    if (text === null) continue;
    if (!localized) localized = { ...payload };
    localized[field] = text;
  }
  if (localized && localized.params !== undefined) delete localized.params;
  return localized || payload;
}

/** Keys present in English but missing from a locale (used by the catalog test). */
function missingTranslations(locale) {
  const table = catalogs[baseLocale(locale)];
  if (!table) return Object.keys(catalogs.en);
  return Object.keys(catalogs.en).filter((key) => table[key] === undefined);
}

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  catalogs,
  enumLabel,
  interpolate,
  intlLocale,
  isKnownKey,
  localizePayload,
  missingTranslations,
  normalizeLocale,
  plural,
  resolveLocale,
  translate,
  translator,
};
