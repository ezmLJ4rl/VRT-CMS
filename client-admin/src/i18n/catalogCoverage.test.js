import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import en from './en.json';
import sw from './sw.json';

/*
 * A missing translation key is a visible bug, not a silent one: i18next falls
 * back to the key itself, so a screen reads "common.saving" or
 * "PROJECTS.NETPOSITION" instead of English or Kiswahili. That is exactly how
 * `projects.netPosition`, referenced by the Special Projects list but only ever
 * added as `netPositionIs`, shipped, and how the admin dashboard's finalize
 * queue ended up asking for `admin.queueAttended` when the catalog defines
 * `admin.finalizeQueueAttended`.
 *
 * So this file holds three rules:
 *
 *   1. every key the app references resolves in BOTH catalogs;
 *   2. en and sw define the same keys, so a Kiswahili interface can never be
 *      left showing English because a translation was never added;
 *   3. no Kiswahili string is just its English text: a copied string reads as
 *      fluent English inside a Kiswahili screen, which is how an invented word
 *      or a wrong one survives review.
 *
 * The sweep reads source text rather than rendering, which is the only way to
 * cover a page no test happens to mount: the likeliest place a typo hides.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');

// i18next resolves `t('x', { count })` through a plural suffix rather than the
// bare key, so a key satisfied only by `x_one` / `x_other` is not missing.
const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

function flatten(obj, prefix = '') {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object' ? flatten(value, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

const enKeys = new Set(flatten(en));
const swKeys = new Set(flatten(sw));

// Values, not only keys. An identical pair is usually a string nobody
// translated, but some strings have nothing in them to translate, an acronym
// like "PDF", or a placeholder-only "{{month}} · {{value}}", so placeholders
// and punctuation are ignored before deciding.
function flattenEntries(obj, prefix = '') {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? flattenEntries(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value]],
  );
}

function isBareEnglish(text) {
  const bare = String(text)
    .replace(/\{\{?\w+\}?\}/g, '')
    .replace(/[\s·+/(),.:%—-]/g, '');
  return /[a-z]/.test(bare);
}

const enEntries = new Map(flattenEntries(en));
const swEntries = new Map(flattenEntries(sw));

function resolves(keys, key) {
  return keys.has(key) || PLURAL_SUFFIXES.some((suffix) => keys.has(`${key}_${suffix}`));
}

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!/\.(js|jsx)$/.test(entry.name)) return [];
    if (/\.test\.(js|jsx)$/.test(entry.name)) return [];
    return [full];
  });
}

// `t('literal')` is the shape used throughout the app. Template/concatenated
// keys can't be checked statically and are deliberately not matched.
function referencedKeys() {
  const found = new Set();
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:^|[^\w$])t\(\s*'([a-zA-Z0-9_.]+)'/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

const referenced = referencedKeys();

describe('translation catalogs', () => {
  it('finds the source tree it is supposed to sweep', () => {
    // Guards against the sweep passing because it silently read nothing.
    expect(fs.existsSync(path.join(SRC, 'pages'))).toBe(true);
    expect(referenced.size).toBeGreaterThan(100);
  });

  it('defines every referenced key in English', () => {
    const missing = [...referenced].filter((key) => !resolves(enKeys, key)).sort();
    expect(missing, `keys missing from en.json: ${missing.join(', ')}`).toEqual([]);
  });

  it('defines every referenced key in Kiswahili', () => {
    const missing = [...referenced].filter((key) => !resolves(swKeys, key)).sort();
    expect(missing, `keys missing from sw.json: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the two catalogs at parity', () => {
    const onlyEn = [...enKeys].filter((key) => !swKeys.has(key)).sort();
    const onlySw = [...swKeys].filter((key) => !enKeys.has(key)).sort();
    expect({ onlyEn, onlySw }).toEqual({ onlyEn: [], onlySw: [] });
  });

  it('detects a key that is genuinely absent', () => {
    // If the resolver ever stops detecting, this fails rather than reporting a
    // clean bill of health for free.
    expect(resolves(enKeys, 'admin.queueAttended')).toBe(false);
    expect(resolves(enKeys, 'projects.netPosition')).toBe(true);
    expect(resolves(swKeys, 'projects.netPosition')).toBe(true);
  });

  it('writes Kiswahili rather than repeating the English', () => {
    const untranslated = [...enEntries.keys()]
      .filter((key) => swEntries.get(key) === enEntries.get(key) && isBareEnglish(enEntries.get(key)))
      .sort();
    expect(untranslated, `strings still in English: ${untranslated.join(', ')}`).toEqual([]);

    // Pin the rule so it cannot quietly loosen: an acronym and a placeholder-only
    // string belong in both languages, a copied sentence does not.
    expect(isBareEnglish('PDF')).toBe(false);
    expect(isBareEnglish('{{month}} · {{value}}')).toBe(false);
    expect(isBareEnglish('Cancel')).toBe(true);
    expect(isBareEnglish('Delete {{name}}?')).toBe(true);
  });
});
