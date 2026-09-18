import { SUPPORTED_LANGUAGES } from './common';

// The language to open in when nobody has chosen one yet.
//
// The desk is used in both English and Kiswahili, and the people most likely to
// need Kiswahili are also the least likely to go hunting for a language control
// on a sign-in screen — so the app reads the browser instead of defaulting to
// English.
//
// This deliberately mirrors the API's own resolver (server/i18n/index.js):
// X-Language first, then Accept-Language, then English. On a first visit the app
// sends no X-Language header, so the API is already reading the very browser
// preference this resolves — which is what keeps the interface and the
// server-side messages (validation errors, refusals) in the same language
// instead of disagreeing about it.
const DEFAULT_LANGUAGE = 'en';
const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((language) => language.code);

/** `sw-KE`, `SW`, `sw_KE` → `sw`. Null when we ship no catalog for it. */
function baseLanguage(tag) {
  if (typeof tag !== 'string') return null;
  const base = tag.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_CODES.includes(base) ? base : null;
}

/**
 * The browser's own preference, most-preferred first: `navigator.languages` is
 * that list already ordered, and `navigator.language` is the single-tag fallback
 * an older browser gives instead. Chrome ships `sw` first on a machine set to
 * Kiswahili and `en-US` first on one set to English, so the first supported tag
 * wins and an unsupported preference (French, say) falls through to the next
 * rather than dropping straight to English.
 */
export function detectLanguage(env = typeof navigator === 'undefined' ? {} : navigator) {
  const tags = Array.isArray(env.languages) && env.languages.length ? env.languages : [env.language];
  for (const tag of tags) {
    const base = baseLanguage(tag);
    if (base) return base;
  }
  return DEFAULT_LANGUAGE;
}

export default detectLanguage;
