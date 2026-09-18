import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import AppShell from './AppShell';
import { AuthProvider } from '../context/AuthContext';
import { TABS } from '../nav';
import i18n from '../i18n';

// No network and no unread provider: the shell takes its counts as props, so the
// nav rules can be checked directly. AuthProvider is the real one, which stays
// inert without a stored token (so the header's language switcher renders
// without a request), and the unread source is only used by the pages.
function renderShell({ counts = {}, path = '/home' } = {}) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <AppShell openEmergencyCount={counts.emergencies || 0} openMessageCount={counts.messages || 0}>
          <p>screen</p>
        </AppShell>
      </MemoryRouter>
    </AuthProvider>
  );
}

const tabs = () => document.getElementById('app-nav-tabs');
const bar = () => document.getElementById('app-nav-bar');
const linkIn = (nav, label) => within(nav).getByRole('link', { name: new RegExp(label) });

const EN_LABELS = ['Home', 'Records', 'Alerts', 'Events', 'Messages', 'Special Projects', 'More'];

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Pastor nav: the same destinations in both presentations', () => {
  it('renders every destination, in one order, in the bottom bar and the tab bar', async () => {
    renderShell();

    for (const nav of [bar(), tabs()]) {
      const links = within(nav).getAllByRole('link');
      expect(links.map((l) => l.textContent)).toEqual(EN_LABELS);
      expect(links.map((l) => l.getAttribute('href'))).toEqual(TABS.map((t) => t.to));
    }
  });

  it('puts one icon on every destination in both presentations', async () => {
    renderShell();

    for (const nav of [bar(), tabs()]) {
      for (const link of within(nav).getAllByRole('link')) {
        expect(link.querySelector('svg')).toBeTruthy();
      }
    }
  });

  it('keeps the phone bar a phone bar and gives wide windows a wrapping tab bar', async () => {
    renderShell();

    // The contract: exactly one presentation at every width, and the tab bar
    // wraps rather than scrolling sideways (nothing hidden off the right edge).
    expect(bar().className).toContain('lg:hidden');
    expect(tabs().className).toContain('hidden');
    expect(tabs().className).toContain('lg:flex');
    expect(tabs().className).toContain('flex-wrap');
    expect(tabs().className).not.toContain('overflow-x-auto');
    expect(bar().className).not.toContain('overflow-x-auto');
  });

  it('drops the bottom-bar padding once the tab bar appears', () => {
    renderShell();

    // 96px of clearance for a fixed bar is wasted space at desktop widths.
    const main = document.querySelector('main');
    expect(main.className).toContain('pb-24');
    expect(main.className).toContain('lg:pb-8');
  });
});

describe('Pastor nav: badges', () => {
  it('shows no badge when there is nothing to read', () => {
    renderShell({ counts: { emergencies: 0, messages: 0 } });

    for (const nav of [bar(), tabs()]) {
      expect(within(nav).getByRole('link', { name: /Home/ }).textContent).toBe('Home');
      expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(EN_LABELS);
    }
  });

  it('pins the open-alert and unread-message counts to their own destinations, in both navs', () => {
    renderShell({ counts: { emergencies: 3, messages: 5 } });

    for (const nav of [bar(), tabs()]) {
      // The count rides along with its destination, not with some other item.
      expect(linkIn(nav, 'Alerts')).toHaveTextContent('3');
      expect(linkIn(nav, 'Messages')).toHaveTextContent('5');
      expect(linkIn(nav, 'Home').textContent).toBe('Home');
      expect(linkIn(nav, 'Records').textContent).toBe('Records');
      expect(linkIn(nav, 'Events').textContent).toBe('Events');
      expect(linkIn(nav, 'More').textContent).toBe('More');
    }
  });

  it('uses the error colour for alerts and brand attention for messages', () => {
    renderShell({ counts: { emergencies: 1, messages: 2 } });

    const badgeFor = (label) => linkIn(tabs(), label).querySelector('span span');
    expect(badgeFor('Alerts').className).toContain('bg-danger-600');
    expect(badgeFor('Messages').className).toContain('bg-brand-600');
  });
});

describe('Pastor nav: active destination', () => {
  it('marks the current screen in both presentations, in each one’s own style', () => {
    renderShell({ path: '/records' });

    const barActive = linkIn(bar(), 'Records');
    const tabActive = linkIn(tabs(), 'Records');
    for (const el of [barActive, tabActive]) expect(el).toHaveAttribute('aria-current', 'page');
    expect(barActive.className).toContain('text-brand-600');
    expect(tabActive.className).toContain('bg-brand-600');

    expect(linkIn(bar(), 'Home')).not.toHaveAttribute('aria-current');
    expect(linkIn(tabs(), 'Home')).not.toHaveAttribute('aria-current');
  });
});

describe('Pastor nav: language', () => {
  it('follows the selected language rather than hardcoding labels', async () => {
    renderShell();
    await i18n.changeLanguage('sw');

    for (const nav of [bar(), tabs()]) {
      expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual([
        'Nyumbani',
        'Kumbukumbu',
        'Arifa',
        'Matukio',
        'Ujumbe',
        'Miradi Maalum',
        'Zaidi',
      ]);
    }
    expect(tabs()).toHaveAccessibleName('Urambazaji mkuu');
  });
});
