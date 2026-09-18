import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import VrtLogo from './VrtLogo';
import CountBadge from './CountBadge';
import LanguageSwitcher from './LanguageSwitcher';
import { CHURCH_NAME } from '../i18n/common';
import { TABS, BADGE_TONE } from '../nav';

export default function AppShell({ children, openEmergencyCount = 0, openMessageCount = 0 }) {
  const { t } = useTranslation();
  const counts = { emergencies: openEmergencyCount, messages: openMessageCount };

  return (
    <div className="flex min-h-screen flex-col bg-ink-50 text-ink-900">
      <header
        className="sticky top-0 z-10 border-b border-ink-200 bg-paper"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-4 pb-3">
          <VrtLogo size={32} className="shrink-0" />
          <h1 className="min-w-0 truncate font-display text-base font-semibold tracking-tight text-ink-900">{CHURCH_NAME}</h1>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Decorative brand accent; dropped on phones so the language
                switcher, which is functional: keeps its room. */}
            <span className="hidden h-1 w-10 rounded-full bg-gradient-to-r from-brand-600 to-people-600 lg:block" />
            <LanguageSwitcher />
          </div>
        </div>

        {/* Wide windows: the same destinations as a horizontal tab bar, wrapping
            onto a second row rather than scrolling, so nothing is ever hidden
            off the right edge. */}
        <nav
          id="app-nav-tabs"
          aria-label={t('nav.mainNav')}
          className="mx-auto hidden w-full max-w-7xl flex-wrap gap-1 px-4 pb-2 lg:flex"
        >
          {TABS.map(({ to, key, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive ? 'bg-brand-600 text-white' : 'text-ink-700 hover:bg-ink-100'
                }`
              }
            >
              <span className="relative">
                <Icon size={17} strokeWidth={1.75} aria-hidden="true" />
                <CountBadge count={counts[key]} tone={BADGE_TONE[key]} />
              </span>
              {t(`nav.${key}`)}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-4 lg:pb-8">{children}</main>

      {/* Phones: the bottom bar stays, because one thumb-reachable tap beats a
          drawer for the destinations a pastor opens all day. */}
      <nav
        id="app-nav-bar"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-ink-200 bg-paper/95 backdrop-blur lg:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="mx-auto flex max-w-md justify-around">
          {TABS.map(({ to, key, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `relative flex min-w-0 flex-1 flex-col items-center gap-0.5 px-0.5 py-2.5 text-[11px] font-medium sm:text-xs ${
                  isActive ? 'text-brand-600' : 'text-ink-400'
                }`
              }
            >
              <span className="relative">
                <Icon size={22} strokeWidth={1.75} aria-hidden="true" />
                <CountBadge count={counts[key]} tone={BADGE_TONE[key]} />
              </span>
              <span className="w-full truncate text-center">{t(`nav.${key}`)}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
