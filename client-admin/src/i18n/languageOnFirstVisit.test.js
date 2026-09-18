import { describe, it, expect, afterEach, vi } from 'vitest';
import { detectLanguage } from './detectLanguage';
import { SUPPORTED_LANGUAGES } from './common';

/*
 * A browser set to Kiswahili should open the app in Kiswahili, without anyone
 * having to find a control on the sign-in screen first — and a Kiswahili speaker
 * is exactly the person least able to go looking for one. So the app reads the
 * browser when nobody has chosen anything.
 *
 * Two halves, because they can fail independently:
 *
 *   1. the resolver itself, against the tag shapes browsers actually send;
 *   2. the boot path, by re-importing ./index.js with a stubbed browser. The
 *      language is fixed at module load, so no amount of rendering can exercise
 *      it: only a fresh import can.
 */

const env = (languages, language) => ({ languages, language });
const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((language) => language.code);

describe('detectLanguage: the browser preference, most-preferred first', () => {
  it('reads the exact tag the desk machines send', () => {
    expect(detectLanguage(env(['sw'], 'sw'))).toBe('sw');
    expect(detectLanguage(env(['en-US'], 'en-US'))).toBe('en');
  });

  it('reduces a regional tag to the language we ship a catalog for', () => {
    expect(detectLanguage(env(['sw-KE'], 'sw-KE'))).toBe('sw');
    expect(detectLanguage(env(['SW_ke'], 'SW_ke'))).toBe('sw');
    expect(detectLanguage(env([' en-GB '], 'en-GB'))).toBe('en');
  });

  it('honours the order: the first supported tag wins', () => {
    expect(detectLanguage(env(['en-US', 'sw'], 'en-US'))).toBe('en');
    expect(detectLanguage(env(['sw', 'en-US'], 'sw'))).toBe('sw');
  });

  it('skips an unsupported preference instead of giving up on the list', () => {
    // A French-second, Kiswahili-third browser should still get Kiswahili: the
    // list is a preference order, not one guess.
    expect(detectLanguage(env(['fr-CA', 'sw', 'en'], 'fr-CA'))).toBe('sw');
  });

  it('falls back to English when nothing in the list is supported', () => {
    expect(detectLanguage(env(['fr', 'de'], 'fr'))).toBe('en');
    expect(detectLanguage({})).toBe('en');
    expect(detectLanguage()).toBe('en');
  });

  it('uses navigator.language when there is no languages list, as older browsers give', () => {
    expect(detectLanguage(env(undefined, 'sw-KE'))).toBe('sw');
    expect(detectLanguage(env([], 'sw'))).toBe('sw');
    expect(detectLanguage(env(undefined, 'en-GB'))).toBe('en');
  });

  it('survives junk instead of trusting it', () => {
    expect(detectLanguage(env([null, 42, {}, 'sw'], null))).toBe('sw');
    expect(detectLanguage(env([{}], 42))).toBe('en');
  });

  it('can only ever return a language the app has a catalog for', () => {
    const candidates = ['sw', 'SW-KE', 'en', 'en-US', 'fr', '', '  ', null, 'de-DE'];
    for (const candidate of candidates) {
      expect(SUPPORTED_CODES).toContain(detectLanguage(env([candidate], candidate)));
    }
  });
});

describe('first visit: the browser decides, a saved choice overrides it', () => {
  const original = {
    languages: Object.getOwnPropertyDescriptor(window.navigator, 'languages'),
    language: Object.getOwnPropertyDescriptor(window.navigator, 'language'),
  };

  function stubBrowser(languages, language) {
    Object.defineProperty(window.navigator, 'languages', { value: languages, configurable: true });
    Object.defineProperty(window.navigator, 'language', { value: language, configurable: true });
  }

  function restoreBrowser() {
    for (const name of ['languages', 'language']) {
      try {
        delete window.navigator[name];
      } catch {
        // A browser (or jsdom) that made the property its own non-configurable
        // one cannot be cleaned up; put the original descriptor back instead.
        if (original[name]) Object.defineProperty(window.navigator, name, original[name]);
      }
    }
  }

  /** Boot the app's i18n module as a browser would load it: once, at import. */
  async function boot({ languages, language, saved }) {
    localStorage.clear();
    if (saved !== undefined) localStorage.setItem('vrt_language', saved);
    stubBrowser(languages, language);
    vi.resetModules();
    const fresh = await import('./index.js');
    return fresh.default;
  }

  afterEach(() => {
    restoreBrowser();
    localStorage.clear();
  });

  it('opens in Kiswahili for a Kiswahili browser with nothing saved', async () => {
    const i18n = await boot({ languages: ['sw', 'en-US'], language: 'sw' });

    expect(i18n.language).toBe('sw');
    // ...and the document says so, for screen readers and hyphenation.
    expect(document.documentElement.lang).toBe('sw');
  });

  it('opens in English for an English browser, the common case', async () => {
    const i18n = await boot({ languages: ['en-US', 'en'], language: 'en-US' });

    expect(i18n.language).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('opens in English for a browser asking for something we do not ship', async () => {
    const i18n = await boot({ languages: ['fr-FR', 'de'], language: 'fr-FR' });

    expect(i18n.language).toBe('en');
  });

  it('keeps a saved choice, even when it disagrees with the browser', async () => {
    // Someone who picked English on a Kiswahili machine keeps English across
    // restarts: detection is a starting point, never a correction.
    const savedEnglish = await boot({ languages: ['sw', 'en-US'], language: 'sw', saved: 'en' });
    expect(savedEnglish.language).toBe('en');

    const savedSwahili = await boot({ languages: ['en-US'], language: 'en-US', saved: 'sw' });
    expect(savedSwahili.language).toBe('sw');
  });

  it('does not save the language it detected', async () => {
    await boot({ languages: ['sw'], language: 'sw' });

    // An empty `vrt_language` is what "nobody has chosen yet" means, and it is
    // what keeps the browser's preference live on the next visit.
    expect(localStorage.getItem('vrt_language')).toBeNull();
  });

  it('ignores a stored value we have no catalog for, and detects again', async () => {
    // A stale value from an older build must not pin the app to a language it
    // cannot show, nor disable detection for good.
    const i18n = await boot({ languages: ['sw'], language: 'sw', saved: 'fr' });

    expect(i18n.language).toBe('sw');
  });
});
