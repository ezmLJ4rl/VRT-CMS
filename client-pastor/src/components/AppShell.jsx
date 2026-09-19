import { NavLink, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UserRound, MoreHorizontal } from 'lucide-react';
import VrtLogo from './VrtLogo';
import CountBadge from './CountBadge';
import LanguageSwitcher from './LanguageSwitcher';
import { useAuth } from '../context/AuthContext';
import { CHURCH_NAME } from '../i18n/common';
import { PRIMARY_TABS, MORE_TABS, BADGE_TONE } from '../nav';

export default function AppShell({ children, openEmergencyCount = 0, openMessageCount = 0 }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { pathname } = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const counts = { emergencies: openEmergencyCount, messages: openMessageCount };
  const moreActive = MORE_TABS.some(({ to }) => pathname === to || pathname.startsWith(`${to}/`));

  return (
    <div className="flex min-h-screen flex-col bg-ink-50 text-ink-900">
      <header
        className="sticky top-0 z-50 border-b border-ink-200 bg-paper"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
      >
        <div className="mx-auto flex w-full max-w-7xl items-center gap-2 px-4 pb-3">
          <VrtLogo size={32} className="shrink-0" />
          <h1 className="min-w-0 truncate font-display text-base font-semibold tracking-tight text-ink-900">{CHURCH_NAME}</h1>
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
            {/* The signed-in account, replacing the old decorative gradient
                strip: the one fact the header could not answer. The name is
                hidden on phones (the role pill stays) so the functional
                language switcher keeps its room. */}
            {user && (
              <span
                className="hidden min-w-0 items-center gap-1.5 rounded-md border border-ink-200 bg-ink-50/60 py-1 pl-2.5 pr-2 md:flex"
                title={user.email}
              >
                <UserRound size={14} aria-hidden="true" className="shrink-0 text-ink-500" />
                <span className="min-w-0 max-w-[10rem] truncate text-sm font-medium text-ink-800">{user.name}</span>
                <span className="hidden shrink-0 rounded bg-ink-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-500 lg:inline">
                  {t(`settings.role_${user.role}`, user.role)}
                </span>
              </span>
            )}
            <LanguageSwitcher />
          </div>
        </div>

        {/* Wide windows: four frequent destinations plus one More menu. */}
        <nav id="app-nav-tabs" aria-label={t('nav.mainNav')} className="mx-auto hidden w-full max-w-7xl items-center gap-1 px-4 pb-2 lg:flex">
          {PRIMARY_TABS.map(({ to, key, Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${isActive ? 'bg-brand-600 text-white' : 'text-ink-700 hover:bg-ink-100'}`}>
              <span className="relative"><Icon size={17} strokeWidth={1.75} aria-hidden="true" /><CountBadge count={counts[key]} tone={BADGE_TONE[key]} /></span>
              {t(`nav.${key}`)}
            </NavLink>
          ))}
          <div className="relative">
            <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)} className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${moreActive ? 'bg-brand-600 text-white' : 'text-ink-700 hover:bg-ink-100'}`}>
              <MoreHorizontal size={17} strokeWidth={1.75} aria-hidden="true" /> {t('nav.settings')}
            </button>
            {moreOpen && <div className="absolute left-0 top-full z-50 mt-1 min-w-56 rounded-xl border border-ink-200 bg-paper p-2 shadow-lg">{MORE_TABS.map(({ to, key, Icon }) => <NavLink key={to} to={to} onClick={() => setMoreOpen(false)} className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-ink-700 hover:bg-ink-100"><Icon size={18} /> <span>{t(`nav.${key}`)}</span></NavLink>)}</div>}
          </div>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-4 lg:pb-8">{children}</main>

      {/* Phones: four frequent destinations plus More = exactly five comfortable
          tap targets. Lower-frequency screens live in the sheet, not a cramped row. */}
      <nav id="app-nav-bar" className="fixed inset-x-0 bottom-0 z-10 border-t border-ink-200 bg-paper/95 backdrop-blur lg:hidden" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
        <div className="mx-auto flex max-w-md justify-around">
          {PRIMARY_TABS.map(({ to, key, Icon }) => <NavLink key={to} to={to} className={({ isActive }) => `relative flex min-w-0 flex-1 flex-col items-center gap-0.5 px-0.5 py-2.5 text-[11px] font-medium sm:text-xs ${isActive ? 'text-brand-600' : 'text-ink-400'}`}><span className="relative"><Icon size={22} strokeWidth={1.75} aria-hidden="true" /><CountBadge count={counts[key]} tone={BADGE_TONE[key]} /></span><span className="w-full truncate text-center">{t(`nav.${key}`)}</span></NavLink>)}
          <button type="button" aria-expanded={moreOpen} onClick={() => setMoreOpen((open) => !open)} className={`relative flex min-w-0 flex-1 flex-col items-center gap-0.5 px-0.5 py-2.5 text-[11px] font-medium sm:text-xs ${moreActive ? 'text-brand-600' : 'text-ink-400'}`}><span><MoreHorizontal size={22} strokeWidth={1.75} aria-hidden="true" /></span><span className="w-full text-center">{t('nav.settings')}</span></button>
        </div>
      </nav>
      {moreOpen && <div className="fixed inset-0 z-40 bg-ink-900/30 lg:hidden" onClick={() => setMoreOpen(false)}><section role="dialog" aria-label={t('nav.settings')} className="absolute inset-x-0 bottom-0 rounded-t-2xl bg-paper p-4 pb-[calc(5rem+env(safe-area-inset-bottom))] shadow-2xl" onClick={(event) => event.stopPropagation()}><div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-200" /><h2 className="mb-2 px-2 font-display text-lg font-semibold text-ink-900">{t('nav.settings')}</h2><div className="grid gap-1 sm:grid-cols-2">{MORE_TABS.map(({ to, key, Icon }) => <NavLink key={to} to={to} onClick={() => setMoreOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-3.5 text-ink-800 hover:bg-ink-100"><Icon size={20} className="text-brand-700" /><span className="font-medium">{t(`nav.${key}`)}</span></NavLink>)}</div></section></div>}
    </div>
  );
}
