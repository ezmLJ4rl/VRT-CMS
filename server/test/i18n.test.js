'use strict';
/**
 * Localization (see i18n/).
 *
 * The API answers in the language the caller asks for: the two apps send
 * X-Language, a plain browser is honoured through Accept-Language, and a link
 * opened outside the app can carry ?lang=. English is the default, so callers
 * that ask for nothing (every other suite, and any older client) keep exactly
 * the messages they always got.
 *
 * The last two tests are the ones that keep this honest over time: they fail if
 * a key is used in a route without an entry in the catalog, or if a translation
 * is added for the wrong English message.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');
const i18n = require('../i18n');

const suite = startServer({ name: 'i18n', port: 4606 });

const ADMIN = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const SW = { 'X-Language': 'sw' };

let adminToken;

async function signIn(email, password) {
  return suite.api('POST', '/api/auth/login', null, { email, password });
}

after(() => suite.stop());

describe('localization: choosing the language', () => {
  before(async () => {
    await suite.waitReady();
    const login = await signIn(ADMIN.email, ADMIN.password);
    assert.equal(login.status, 200, login.text);
    adminToken = login.json.token;
  });

  it('answers in English when the caller expresses no preference', async () => {
    // An unknown API route is the cheapest localized response to assert on: it
    // comes from index.js itself, not from a route module.
    const notFound = await suite.api('GET', '/api/nothing-here');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error, 'Not found.');

    const unauthorized = await suite.api('GET', '/api/users');
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.json.error, 'Authentication required.');
  });

  it('answers in Kiswahili for X-Language: sw, the header the apps send', async () => {
    const notFound = await suite.api('GET', '/api/nothing-here', null, null, SW);
    assert.equal(notFound.status, 404);
    assert.equal(notFound.json.error, 'Haipatikani.');

    const unauthorized = await suite.api('GET', '/api/users', null, null, SW);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.json.error, 'Uthibitishaji unahitajika.');
  });

  it('honours Accept-Language, so a plain browser is covered too', async () => {
    const swahili = await suite.api('GET', '/api/nothing-here', null, null, {
      'Accept-Language': 'sw,en-US;q=0.9,en;q=0.8',
    });
    assert.equal(swahili.json.error, 'Haipatikani.');

    // Quality values decide, not order: English wins here.
    const english = await suite.api('GET', '/api/nothing-here', null, null, {
      'Accept-Language': 'sw;q=0.2,en;q=0.9',
    });
    assert.equal(english.json.error, 'Not found.');
  });

  it('honours ?lang= so a link opened outside the app still reads correctly', async () => {
    const res = await suite.api('GET', '/api/nothing-here?lang=sw');
    assert.equal(res.json.error, 'Haipatikani.');
  });

  it('understands a regional or uppercase tag, and falls back for unknown ones', async () => {
    const regional = await suite.api('GET', '/api/nothing-here', null, null, { 'X-Language': 'SW-KE' });
    assert.equal(regional.json.error, 'Haipatikani.');

    // A language we have no catalog for must degrade to English, never to a key.
    const unsupported = await suite.api('GET', '/api/nothing-here', null, null, { 'X-Language': 'fr' });
    assert.equal(unsupported.json.error, 'Not found.');
    assert.ok(!unsupported.json.error.includes('errors.'), 'a caller must never see a raw key');
  });

  it('translates the message the user actually reported: a failed sign-in', async () => {
    const english = await signIn('nobody@test.local', 'WrongPass_123!');
    assert.equal(english.status, 401);
    assert.equal(english.json.error, 'Invalid email or password.');

    const swahili = await suite.api('POST', '/api/auth/login', null, { email: 'nobody@test.local', password: 'WrongPass_123!' }, SW);
    assert.equal(swahili.status, 401);
    assert.equal(swahili.json.error, 'Barua pepe au nywila si sahihi.');
  });

  it('fills in placeholders in both languages', async () => {
    // An account that has recorded an offering cannot be deleted, and the refusal
    // names what it recorded: the one message with an interpolated value.
    const created = await suite.api('POST', '/api/users', adminToken, {
      name: 'Swahili Desk', email: 'swahili.desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    assert.equal(created.status, 201, created.text);
    const id = created.json.id;

    const login = await signIn('swahili.desk@test.local', 'DeskPass_123!');
    const offering = await suite.api('POST', '/api/offerings', login.json.token, {
      serviceTypeId: 1, category: 'general', amount: 1200,
    });
    assert.equal(offering.status, 201, offering.text);

    const english = await suite.api('DELETE', `/api/users/${id}`, adminToken);
    assert.equal(english.status, 409);
    assert.match(english.json.error, /^This account recorded offerings\./);
    assert.deepEqual(english.json.blockedBy, ['offerings']);

    const swahili = await suite.api('DELETE', `/api/users/${id}`, adminToken, null, SW);
    assert.equal(swahili.status, 409);
    assert.match(swahili.json.error, /^Akaunti hii ilirekodi offerings\./);
    assert.ok(!swahili.json.error.includes('{labels}'), 'the placeholder must be replaced, not shown');
    // The machine-readable part of the payload is language-independent.
    assert.deepEqual(swahili.json.blockedBy, ['offerings']);

    // `params` is an internal detail of the call site and must not leak.
    assert.equal(swahili.json.params, undefined);
  });
});

describe('localization: catalog integrity', () => {
  it('has a translation for every English key, with the same placeholders', () => {
    const en = i18n.catalogs.en;
    const sw = i18n.catalogs.sw;

    assert.deepEqual(i18n.missingTranslations('sw'), [], 'every key must exist in Kiswahili');

    const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join(',');
    const mismatched = Object.keys(en).filter((key) => placeholders(en[key]) !== placeholders(sw[key]));
    assert.deepEqual(mismatched, [], 'a translation must keep the placeholders of its English text');
  });

  it('holds real Kiswahili, not the English text copied across', () => {
    // A copied string reads as fluent English on a Kiswahili screen, which is
    // how an invented word or a wrong one survives review. Strings with nothing
    // in them to translate: an acronym, or a bare placeholder: are left alone.
    const isBareEnglish = (text) =>
      /[a-z]/.test(String(text).replace(/\{\{?\w+\}?\}/g, '').replace(/[\s·+/(),.:%—-]/g, ''));

    const untranslated = Object.keys(i18n.catalogs.en).filter(
      (key) => i18n.catalogs.sw[key] === i18n.catalogs.en[key] && isBareEnglish(i18n.catalogs.en[key]),
    );
    assert.deepEqual(untranslated, [], 'a translation that is the English text is not a translation');

    // Pin the rule so it cannot quietly loosen.
    assert.equal(isBareEnglish('PDF'), false);
    assert.equal(isBareEnglish('{labels}'), false);
    assert.equal(isBareEnglish('Debt not found.'), true);
  });

  it('never leaves a route returning prose instead of a key', () => {
    // The guarantee behind the whole design: if a handler slips back to a raw
    // English sentence, no translation can ever match it, so this fails loudly.
    const serverDir = path.join(__dirname, '..');
    const files = [path.join(serverDir, 'index.js')];
    for (const dir of ['routes', 'middleware']) {
      for (const name of fs.readdirSync(path.join(serverDir, dir))) {
        if (name.endsWith('.js')) files.push(path.join(serverDir, dir, name));
      }
    }

    const offenders = [];
    const fakeKeys = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\b(error|message):\s*'([^']*)'/g)) {
        const [, field, value] = match;
        const where = `${path.relative(serverDir, file)} (${field}: '${value}')`;
        if (!/^(errors|messages)\./.test(value)) offenders.push(where);
        else if (!i18n.isKnownKey(value)) fakeKeys.push(where);
      }
    }

    assert.deepEqual(offenders, [], 'response text must be a message key, not prose');
    assert.deepEqual(fakeKeys, [], 'every key used in a route must exist in the catalog');
  });
});

describe('localization: the module', () => {
  it('returns null for anything that is not a known key, so it cannot mangle a payload', () => {
    assert.equal(i18n.translate('sw', 'This is ordinary prose, not a key.'), null);
    assert.equal(i18n.translate('sw', 'errors.doesNotExist'), null);
    assert.equal(i18n.translate('sw', undefined), null);
    assert.equal(i18n.translate('sw', 42), null);
  });

  it('leaves an unrecognised payload untouched', () => {
    const payload = { error: 'from a library, not our catalog', id: 7 };
    assert.equal(i18n.localizePayload(payload, 'sw'), payload);
  });

  it('falls back to English for a key that exists but is untranslated', () => {
    // Simulates a new key added to en.json before the translation lands: the
    // user sees English rather than the raw key. Both catalogs are restored, so
    // this cannot leak into the integrity checks above.
    i18n.catalogs.en['errors.__temp_probe'] = 'Temporary probe message.';
    try {
      assert.equal(i18n.translate('sw', 'errors.__temp_probe'), 'Temporary probe message.');
    } finally {
      delete i18n.catalogs.en['errors.__temp_probe'];
      delete i18n.catalogs.sw['errors.__temp_probe'];
    }
  });

  it('resolves tags the way the app and browsers actually send them', () => {
    const req = (headers) => ({ get: (name) => headers[name.toLowerCase()], query: {} });
    assert.equal(i18n.resolveLocale(req({})), 'en');
    assert.equal(i18n.resolveLocale(req({ 'x-language': 'sw' })), 'sw');
    assert.equal(i18n.resolveLocale(req({ 'accept-language': 'sw-KE,sw;q=0.9' })), 'sw');
    assert.equal(i18n.resolveLocale(req({ 'accept-language': 'de-DE,de;q=0.9' })), 'en');
    // The app's explicit choice beats the browser's.
    assert.equal(i18n.resolveLocale(req({ 'x-language': 'en', 'accept-language': 'sw' })), 'en');
  });
});
