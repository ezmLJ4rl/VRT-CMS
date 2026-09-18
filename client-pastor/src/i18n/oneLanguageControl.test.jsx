import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AppShell from '../components/AppShell';
import { AuthProvider } from '../context/AuthContext';
import { SUPPORTED_LANGUAGES } from './common';
import i18n from './index';
import Home from '../pages/Home';
import Records from '../pages/Records';
import Emergencies from '../pages/Emergencies';
import Messages from '../pages/Messages';
import GroupDetail from '../pages/GroupDetail';
import Projects from '../pages/Projects';
import ProjectDetail from '../pages/ProjectDetail';
import Events from '../pages/Events';
import Settings from '../pages/Settings';

/*
 * There is exactly one language control in this app: the pill in the header.
 *
 * It started with two, the header and a pair of buttons on the Settings screen
 * which meant two places to keep in step and two answers to "where do I change
 * the language?". This file is what stops a third appearing. It has to work two
 * ways to be worth anything:
 *
 *   1. a sweep of every source file, because a control can be added to a page
 *      that no test happens to render (the most likely way it comes back);
 *   2. a render of every screen inside the real shell, because a sweep can only
 *      recognise the shapes it was taught, and a rendered screen cannot lie
 *      about what it puts on screen.
 *
 * Neither half is sufficient alone, which is why both are here.
 */

// Every screen's data load is left pending: each one then renders its real
// controls without needing a fixture per endpoint. What the UI *offers* is the
// subject here, not what it happens to display.
vi.mock('../api', () => ({
  default: {
    get: vi.fn(() => new Promise(() => {})),
    post: vi.fn(() => new Promise(() => {})),
    patch: vi.fn(() => new Promise(() => {})),
    delete: vi.fn(() => new Promise(() => {})),
  },
  apiErrorMessage: (err) => err?.message || 'Something went wrong. Please try again.',
  API_BASE: '',
}));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const rel = (file) => path.relative(SRC, file).split(path.sep).join('/');

// The two ways a module can be involved in choosing a language: putting the
// label list on screen, or changing the language at all.
const SIGNALS = [/SUPPORTED_LANGUAGES/, /setLanguage\s*\(/];

// The complete set of modules allowed to touch either. Anything else in the app
// that does is a second control.
const MAY_BE_LANGUAGE_AWARE = new Map([
  ['i18n/index.js', 'defines setLanguage and keeps <html lang> in step: the mechanism, not a control'],
  ['i18n/common.js', 'defines the label list: data, not a control'],
  ['components/LanguageSwitcher.jsx', 'the one control'],
  ['context/AuthContext.jsx', 'applies the saved account preference at boot and login; renders no UI'],
]);

// Assertions below mine the same identifiers, so they are not part of the sweep.
function sourceFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (!/\.(js|jsx)$/.test(entry.name) || /\.test\.(js|jsx)$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

const LABELS = SUPPORTED_LANGUAGES.map((language) => language.label);
const NAMED_AS_LANGUAGE = /\b(Language|Lugha)\b/;

/**
 * Anything on screen that lets someone choose a language: a control showing a
 * language name on its face (the pill, or a pair of English/Kiswahili buttons),
 * a native select offering the languages, or anything labelled "Language".
 */
function languageControls(root = document.body) {
  return [...root.querySelectorAll('button, select, [role="menuitemradio"], [role="option"]')].filter((node) => {
    if (NAMED_AS_LANGUAGE.test(node.getAttribute('aria-label') || '')) return true;
    if (LABELS.includes((node.textContent || '').trim())) return true;
    if (node.tagName === 'SELECT') return [...node.options].some((option) => LABELS.includes(option.textContent.trim()));
    return false;
  });
}

const SCREENS = {
  Home: { Page: Home, route: '/home' },
  Records: { Page: Records, route: '/records' },
  Emergencies: { Page: Emergencies, route: '/emergencies' },
  Messages: { Page: Messages, route: '/messages' },
  Events: { Page: Events, route: '/events' },
  Projects: { Page: Projects, route: '/projects' },
  ProjectDetail: { Page: ProjectDetail, route: '/projects/7' },
  GroupDetail: { Page: GroupDetail, route: '/groups/7' },
  Settings: { Page: Settings, route: '/settings' },
};

beforeEach(() => {
  localStorage.clear();
});

describe('one language control: the header pill, and only that', () => {
  it('has exactly one module in the app that can change the language', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(20);

    const aware = files.filter((file) => SIGNALS.some((signal) => signal.test(fs.readFileSync(file, 'utf8'))));
    // If this ever finds nothing, the detector has rotted and the rule below
    // would pass vacuously.
    expect(aware.map(rel)).toContain('components/LanguageSwitcher.jsx');

    expect(aware.filter((file) => !MAY_BE_LANGUAGE_AWARE.has(rel(file))).map(rel)).toEqual([]);
  });

  it('renders the switcher in the shell and nowhere else', () => {
    const renderers = sourceFiles(SRC)
      .filter((file) => /<LanguageSwitcher/.test(fs.readFileSync(file, 'utf8')))
      .map(rel);

    expect(renderers).toEqual(['components/AppShell.jsx']);
  });

  it('lists every screen, so a page added later cannot quietly escape the renders below', () => {
    const onDisk = fs
      .readdirSync(path.join(SRC, 'pages'))
      .filter((name) => name.endsWith('.jsx') && !name.endsWith('.test.jsx'))
      .map((name) => name.replace(/\.jsx$/, ''));

    // Login is the one exception: it renders outside the shell, so it has no
    // header to hold a pill. The sweep above is what covers that file.
    expect(Object.keys(SCREENS).sort()).toEqual(onDisk.filter((name) => name !== 'Login').sort());
  });

  for (const [name, { Page, route }] of Object.entries(SCREENS)) {
    it(`${name} adds no language control of its own`, () => {
      render(
        <AuthProvider>
          <MemoryRouter initialEntries={[route]}>
            <AppShell>
              <Page />
            </AppShell>
          </MemoryRouter>
        </AuthProvider>
      );

      const controls = languageControls();
      expect(controls).toHaveLength(1);
      // ...and the one is the header pill, not something a screen smuggled in.
      expect(controls[0]).toHaveAttribute('aria-haspopup', 'menu');
      expect(controls[0].closest('header')).toBeTruthy();
    });
  }

  it('recognises the control it removed, so this rule is not vacuous', async () => {
    // The Settings screen used to render exactly this pair. If the detector
    // below cannot see it, every assertion above would pass for free.
    render(
      <div>
        {SUPPORTED_LANGUAGES.map((language) => (
          <button key={language.code} type="button">
            {language.label}
          </button>
        ))}
      </div>
    );

    expect(languageControls()).toHaveLength(2);
    await i18n.changeLanguage('en');
  });
});
