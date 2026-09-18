import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import sw from './sw.json';
import { detectLanguage } from './detectLanguage';
import { SUPPORTED_LANGUAGES } from './common';

/**
 * Where the interface language comes from, in order:
 *
 *   1. `vrt_language` — a choice a person actually made, either with the header
 *      switcher or taken from their account preference when they sign in. A
 *      saved choice always wins, so signing in does not undo it.
 *   2. the browser's own preference — see `detectLanguage`.
 *   3. English, the fallback for anything we do not ship a catalog for.
 *
 * Detection is deliberately not written to storage: an empty `vrt_language` is
 * what "nobody has chosen yet" means, and it keeps the browser's preference
 * live until someone overrides it.
 */
function startingLanguage() {
  const saved = localStorage.getItem('vrt_language');
  const known = SUPPORTED_LANGUAGES.some((language) => language.code === saved);
  return known ? saved : detectLanguage();
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    sw: { translation: sw },
  },
  lng: startingLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

// `lang` is not cosmetic: it drives screen-reader pronunciation, hyphenation and
// the browser's own spell/translate suggestions, and a browser set to Kiswahili
// now opens the app in Kiswahili without anyone clicking anything. Set here
// rather than in the switcher so every path that changes language (the header, a
// stored account preference at boot, this detection) keeps it honest.
function applyDocumentLanguage(code) {
  if (typeof document !== 'undefined') document.documentElement.lang = code;
}

applyDocumentLanguage(i18n.language);

export function setLanguage(code) {
  i18n.changeLanguage(code);
  localStorage.setItem('vrt_language', code);
  applyDocumentLanguage(code);
}

export default i18n;
