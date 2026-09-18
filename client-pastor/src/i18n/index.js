import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import sw from './sw.json';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    sw: { translation: sw },
  },
  lng: localStorage.getItem('vrt_language') || 'en',
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

// `lang` is not cosmetic: it drives screen-reader pronunciation, hyphenation and
// the browser's own spell/translate suggestions. Set here rather than in the
// switcher so every path that changes language (the header, Settings, a stored
// account preference at boot) keeps it honest.
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
