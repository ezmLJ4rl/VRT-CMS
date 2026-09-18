import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import LanguageSwitcher from './LanguageSwitcher';
import api from '../api';
import i18n from '../i18n';

vi.mock('../api', () => ({ default: { patch: vi.fn() } }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 7, language_pref: 'en' } }) }));

const trigger = () => screen.getByRole('button', { name: 'Language' });
const option = (name) => screen.getByRole('menuitemradio', { name });

beforeEach(() => {
  api.patch.mockResolvedValue({ data: {} });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
  localStorage.removeItem('vrt_language');
  // changeLanguage() bypasses setLanguage(), so reset the document language too.
  document.documentElement.lang = 'en';
});

describe('LanguageSwitcher: the current language is visible in the header', () => {
  it('names the language on a compact pill rather than hiding it behind a bare select', () => {
    render(<LanguageSwitcher />);

    expect(trigger()).toHaveTextContent('English');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens a short menu listing both languages, with the active one marked', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
    expect(option('English')).toHaveAttribute('aria-checked', 'true');
    expect(option('Kiswahili')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('LanguageSwitcher: it changes the app, not just the button', () => {
  it('switches the real i18n language and persists the choice across a refresh', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(trigger());
    await user.click(option('Kiswahili'));

    expect(i18n.language).toBe('sw');
    // The same key client-pastor reads at boot, which is what makes it survive a reload.
    expect(localStorage.getItem('vrt_language')).toBe('sw');
    // And the document says so, so screen readers pronounce it as Kiswahili.
    expect(document.documentElement.lang).toBe('sw');
    // And the account preference is saved, so the choice follows the pastor.
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/users/me/language', { languagePref: 'sw' }));
  });

  it('closes the menu and relabels the pill after choosing', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    // Held by reference: the trigger's accessible name is itself translated, so
    // after switching it answers to "Lugha" rather than "Language".
    const pill = trigger();
    await user.click(pill);
    await user.click(option('Kiswahili'));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(pill).toHaveTextContent('Kiswahili');
    expect(pill).toHaveAttribute('aria-label', 'Lugha');
  });

  it('still switches the interface when the account preference cannot be saved', async () => {
    api.patch.mockRejectedValue(new Error('offline'));
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(trigger());
    await user.click(option('Kiswahili'));

    // A failed round trip must not cost the user the language they picked.
    expect(i18n.language).toBe('sw');
    expect(localStorage.getItem('vrt_language')).toBe('sw');
  });
});

describe('LanguageSwitcher: getting out of the menu', () => {
  it('closes when the user taps outside, without changing anything', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(trigger());
    await user.click(document.body);

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(i18n.language).toBe('en');
  });

  it('closes on Escape and hands focus back to the pill', async () => {
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.click(trigger());
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });
});
