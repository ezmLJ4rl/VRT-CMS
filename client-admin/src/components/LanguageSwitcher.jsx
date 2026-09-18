import { useTranslation } from 'react-i18next';
import { setLanguage } from '../i18n';
import { SUPPORTED_LANGUAGES } from '../i18n/common';
import { useAuth } from '../context/AuthContext';
import api from '../api';

export default function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();

  async function handleChange(e) {
    const code = e.target.value;
    setLanguage(code);
    if (user) {
      try {
        await api.patch('/users/me/language', { languagePref: code });
      } catch {
        // Non-critical: the UI already switched; the preference just won't persist server-side.
      }
    }
  }

  return (
    <select
      value={i18n.language}
      onChange={handleChange}
      aria-label={t('common.language')}
      className="rounded-md border border-ink-200 bg-paper px-2.5 py-1.5 text-sm text-ink-700 hover:border-brand-600 focus-visible:border-brand-600"
    >
      {SUPPORTED_LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
