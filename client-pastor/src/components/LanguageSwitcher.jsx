import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Globe } from 'lucide-react';
import { setLanguage } from '../i18n';
import { SUPPORTED_LANGUAGES } from '../i18n/common';
import { useAuth } from '../context/AuthContext';
import api from '../api';

/*
 * Language switcher for the pastor header.
 *
 * A compact pill naming the current language, opening a small menu: calmer
 * than the admin app's bare <select>, and it keeps the header readable at phone
 * width where a native select would either crowd the church name or wrap.
 *
 * It changes the real i18n instance via `setLanguage`, which writes vrt_language
 * to localStorage (so the choice survives a refresh) and keeps <html lang> in
 * step, then best-effort saves the preference to the account so it follows the
 * pastor to another device.
 *
 * This is the app's only language control: see src/i18n/oneLanguageControl.test.jsx,
 * which fails if a second one is added anywhere.
 */
export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const trigger = useRef(null);

  const current = SUPPORTED_LANGUAGES.find((l) => l.code === i18n.language) || SUPPORTED_LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event) {
      if (wrap.current && !wrap.current.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function choose(code) {
    setOpen(false);
    setLanguage(code);
    if (user) {
      try {
        await api.patch('/users/me/language', { languagePref: code });
      } catch {
        // Non-critical: the UI already switched; the preference just won't follow the account.
      }
    }
  }

  return (
    <div className="relative shrink-0" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('common.language')}
        className="flex items-center gap-1.5 rounded-full border border-ink-200 bg-paper px-2.5 py-1.5 text-xs font-medium text-ink-700 transition-colors hover:border-brand-400 hover:text-ink-900"
      >
        <Globe size={14} strokeWidth={1.75} aria-hidden="true" />
        <span>{current.label}</span>
        <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {open && (
        <ul
          role="menu"
          aria-label={t('common.language')}
          className="absolute right-0 z-20 mt-2 w-40 overflow-hidden rounded-xl border border-ink-200 bg-paper p-1 shadow-lg"
        >
          {SUPPORTED_LANGUAGES.map((language) => {
            const active = language.code === current.code;
            return (
              <li key={language.code}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => choose(language.code)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                    active ? 'bg-brand-50 font-semibold text-brand-700' : 'text-ink-700 hover:bg-ink-50'
                  }`}
                >
                  {language.label}
                  {active && <Check size={14} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
