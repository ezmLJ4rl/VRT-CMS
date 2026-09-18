'use strict';
/**
 * Server-GENERATED text: receipts, event sheets, digests, SMS and email bodies.
 *
 * Everything the API answers with goes through middleware/locale.js, which turns
 * message keys into the caller's language. Nothing it RENDERS does: a receipt is
 * an HTML/PDF document, a digest is a stored message body, an announcement is an
 * SMS. Those were built from English literals in utils/, so the server could
 * answer a request in Kiswahili and hand back a Kiswahili error alongside an
 * English receipt, and a Kiswahili announcement went out in English entirely.
 *
 * Three rules are pinned here:
 *
 *   1. the text follows the READER: a document handed to the caller uses the
 *      caller's language, a notification addressed to a named person uses THAT
 *      person's saved language, whatever the sender's app is set to;
 *   2. every string that used to be a literal is a catalog key, so both catalogs
 *      have to carry it: the two integrity checks at the end fail on a key that
 *      does not exist and on an enum value with no label;
 *   3. an enum stored in the database (a group's kind, an emergency's severity)
 *      is never printed raw;
 *   4. the church's own name and address on a printed document are the ones the
 *      apps display, so a receipt can never name a different place from the
 *      screen that issued it.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');
const i18n = require('../i18n');

// Web Push is switched OFF for this suite, deliberately. With no VAPID keys
// utils/notify.js records the send 'pending' INSTEAD OF sending it, and it
// records the notification's title, which is exactly the payload a device would
// have shown. That makes the language of a push observable over HTTP, with no
// push service and no in-process stubbing. (push-notifications.test.js, which
// tests the transport itself, keeps the real keys.)
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

const suite = startServer({ name: 'generated-text-i18n', port: 4624 });

const ADMIN = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const PASTOR_EMAIL = 'pastor@victoryrevival.church';
const SW = { 'X-Language': 'sw' };
const EN = { 'X-Language': 'en' };

let adminToken;
let deskToken;
let deskName;
let pastorId;

after(() => suite.stop());

/** Pushes are fired without blocking the send, so a log row lands shortly after. */
async function waitFor(fn, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

/** The pastor reads in `language`; the sender's own app stays English. */
async function setPastorLanguage(language) {
  const res = await suite.api('PATCH', `/api/users/${pastorId}`, adminToken, { languagePref: language });
  assert.equal(res.status, 200, res.text);
}

describe('server-generated text follows the reader', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, ADMIN);
    assert.equal(admin.status, 200, admin.text);
    adminToken = admin.json.token;

    const pastor = await suite.get('SELECT id FROM users WHERE email = ?', [PASTOR_EMAIL]);
    pastorId = pastor.id;

    deskName = 'Generated Text Desk';
    const created = await suite.api('POST', '/api/users', adminToken, {
      name: deskName, email: 'generated.text@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    assert.equal(created.status, 201, created.text);
    const login = await suite.api('POST', '/api/auth/login', null, { email: 'generated.text@test.local', password: 'DeskPass_123!' });
    assert.equal(login.status, 200, login.text);
    deskToken = login.json.token;
  });

  // ---------------------------------------------------------------------------
  // 1. The receipt handed to a donor
  // ---------------------------------------------------------------------------
  describe('a receipt is printed in the language of the desk that printed it', () => {
    let namedReceipt;
    let anonymousReceipt;

    before(async () => {
      // 'zaka' requires the giver's name and issues a receipt; 'general' can be
      // receipted without one, which is the only way a receipt has no giver line.
      const named = await suite.api('POST', '/api/offerings', deskToken, {
        serviceTypeId: 1, category: 'zaka', amount: 5000, currency: 'TZS', offererName: 'Elisha Makala', receipt: true,
      });
      assert.equal(named.status, 201, named.text);
      namedReceipt = named.json.id;

      const anonymous = await suite.api('POST', '/api/offerings', deskToken, {
        serviceTypeId: 1, category: 'general', amount: 1200, currency: 'TZS', receipt: true,
      });
      assert.equal(anonymous.status, 201, anonymous.text);
      anonymousReceipt = anonymous.json.id;
    });

    it('labels the receipt in English for a desk that asks for English, as before', async () => {
      const res = await suite.api('GET', `/api/offerings/${namedReceipt}/receipt`, deskToken);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.match(res.text, /Giver<\/span><span class="value">Elisha Makala</);
      assert.match(res.text, /<html lang="en">/);
      assert.ok(res.text.includes('>Date<'), 'the date label');
      assert.ok(res.text.includes('>Amount<'), 'the amount label');
      assert.ok(res.text.includes('Thank you for your faithful giving.'), 'the footer');
    });

    it('labels the same receipt in Kiswahili for a desk that asks for Kiswahili', async () => {
      const res = await suite.api('GET', `/api/offerings/${namedReceipt}/receipt`, deskToken, null, SW);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.match(res.text, /<html lang="sw">/);
      assert.match(res.text, /Mtoaji<\/span><span class="value">Elisha Makala</, 'the Giver label and the name');
      assert.ok(res.text.includes('>Tarehe<'), 'Date');
      assert.ok(res.text.includes('>Kiasi<'), 'Amount');
      assert.ok(res.text.includes('Namba ya risiti'), 'Receipt No');
      assert.ok(res.text.includes('Risiti Rasmi'), 'the document sub-line');
      assert.ok(res.text.includes('Imerekodiwa na'), 'Recorded by');
      assert.ok(res.text.includes('Asante kwa utoaji wako wa uaminifu.'), 'the footer');

      // Not one English label may survive: a half-translated receipt is the
      // failure this is here to prevent.
      for (const english of ['>Giver<', '>Date<', '>Amount<', '>Recorded by<', 'Receipt No:', 'Category</span>']) {
        assert.ok(!res.text.includes(english), `the Kiswahili receipt still shows "${english}"`);
      }
    });

    it('carries the anonymous/name-unavailable distinction into Kiswahili', async () => {
      const english = await suite.api('GET', `/api/offerings/${anonymousReceipt}/receipt`, deskToken);
      assert.match(english.text, /Giver<\/span><span class="value">Anonymous</);

      const swahili = await suite.api('GET', `/api/offerings/${anonymousReceipt}/receipt`, deskToken, null, SW);
      assert.match(swahili.text, /Mtoaji<\/span><span class="value">Bila jina</, 'Anonymous in Kiswahili');
      assert.ok(!swahili.text.includes('>Anonymous<'));
    });

    it('hands the SAME language to the PDF renderer, not just the HTML one', async () => {
      // The two documents share one set of labels, but they are separate code
      // paths: the HTML template and the pdfkit writer. Different bytes for the
      // same row is what proves the locale reached the second one too.
      const english = await suite.api('GET', `/api/offerings/${namedReceipt}/receipt.pdf`, deskToken);
      const swahili = await suite.api('GET', `/api/offerings/${namedReceipt}/receipt.pdf`, deskToken, null, SW);
      assert.equal(english.status, 200, english.text.slice(0, 120));
      assert.equal(swahili.status, 200, swahili.text.slice(0, 120));
      assert.ok(english.text.startsWith('%PDF') && swahili.text.startsWith('%PDF'));
      assert.notEqual(english.text, swahili.text, 'the PDF must be rendered in the language that was asked for');
    });

    it('falls back to English for a caller with no preference at all', async () => {
      const none = await suite.api('GET', `/api/offerings/${namedReceipt}/receipt`, deskToken);
      const unknown = await suite.api('GET', `/api/offerings/${namedReceipt}/receipt`, deskToken, null, { 'X-Language': 'fr' });
      assert.equal(none.text, unknown.text, 'an unsupported language degrades to English, never to a raw key');
      assert.ok(!unknown.text.includes('receipt.'), 'no raw key may reach a printed document');
    });
  });

  // ---------------------------------------------------------------------------
  // 2. The event sheet the front desk prints
  // ---------------------------------------------------------------------------
  describe('the printed event sheet is in the front desk\'s language', () => {
    let eventId;

    before(async () => {
      const created = await suite.api('POST', '/api/events', adminToken, {
        title: 'Harvest Thanksgiving',
        description: 'A joint service.',
        location: 'Main Hall',
        startsAt: '2026-10-04T09:00:00',
        endsAt: '2026-10-04T12:00:00',
        kind: 'service',
        collectionType: 'both',
        status: 'published',
      });
      assert.equal(created.status, 201, created.text);
      eventId = created.json.event.id;
    });

    it('prints the English sheet with the event vocabulary of the app', async () => {
      const res = await suite.api('GET', `/api/events/${eventId}/printable-sheet`, deskToken);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      const sheet = res.json.sheet;
      assert.ok(sheet.includes('EVENT ANNOUNCEMENT'), sheet);
      assert.ok(sheet.includes('Kind: Service'), 'the kind is a label, not the stored value');
      assert.ok(sheet.includes('Collection expected: Attendance & Offerings'), sheet);
      assert.ok(sheet.includes('Where: Main Hall'), sheet);
      assert.ok(sheet.includes('When: 2026-10-04 09:00 to 2026-10-04 12:00'), sheet);
      assert.ok(!/Kind: service\b/.test(sheet), 'the raw column value must never be printed');
    });

    it('prints the Kiswahili sheet, headings and vocabulary alike', async () => {
      const res = await suite.api('GET', `/api/events/${eventId}/printable-sheet`, deskToken, null, SW);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      const sheet = res.json.sheet;
      assert.ok(sheet.includes('TANGAZO LA TUKIO'), sheet);
      assert.ok(sheet.includes('Aina: Ibada'), 'kind "service" is Ibada, not "service"');
      assert.ok(sheet.includes('Mkusanyiko unaotarajiwa: Mahudhurio na sadaka'), sheet);
      assert.ok(sheet.includes('Mahali: Main Hall'), sheet);
      // Even the word between two times is the reader's: "to" would be English
      // sitting in the middle of a Kiswahili sentence.
      assert.ok(sheet.includes('Wakati: 2026-10-04 09:00 hadi 2026-10-04 12:00'), sheet);
      assert.ok(!sheet.includes('EVENT ANNOUNCEMENT'), 'no English heading may survive');
      assert.ok(!sheet.includes('Collection expected'), sheet);
      assert.ok(!sheet.includes(' to 2026-10-04'), 'the range word must be translated too');
    });

    it('serves the branded HTML sheet with translated labels and the right lang attribute', async () => {
      const res = await suite.api('GET', `/api/events/${eventId}/printable-sheet?format=html`, deskToken, null, SW);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.match(res.text, /<html lang="sw">/);
      assert.match(res.text, /class="label">Aina</);
      assert.match(res.text, /class="label">Mahali</);
      assert.ok(res.text.includes('class="sub">Tangazo la Tukio'), 'the sheet heading');
    });

    it('renders the PDF sheet in the language it was asked for', async () => {
      const english = await suite.api('GET', `/api/events/${eventId}/printable-sheet?format=pdf`, deskToken);
      const swahili = await suite.api('GET', `/api/events/${eventId}/printable-sheet?format=pdf`, deskToken, null, SW);
      assert.equal(english.status, 200, english.text.slice(0, 120));
      assert.equal(swahili.status, 200, swahili.text.slice(0, 120));
      assert.ok(english.text.startsWith('%PDF') && swahili.text.startsWith('%PDF'));
      assert.notEqual(english.text, swahili.text);
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Who the language follows for text addressed to a person
  // ---------------------------------------------------------------------------
  describe('a message addressed to the pastor is written in the pastor\'s language', () => {
    async function sendDigest(headers) {
      // Everything recorded today that is still un-notified is gathered, so the
      // flags are cleared first: the digest under test must have something in it.
      await suite.run('UPDATE attendance SET notified_at = NULL, notified_by = NULL');
      await suite.run('UPDATE offerings SET notified_at = NULL, notified_by = NULL');
      const res = await suite.api('POST', '/api/notifications/send-summary', deskToken, null, headers);
      assert.equal(res.status, 200, res.text);
      assert.equal(res.json.sent, true, 'the digest needs a pending record to send');
      return suite.get(
        "SELECT * FROM messages WHERE recipient_role = 'pastor' AND category = 'attendance' ORDER BY id DESC LIMIT 1"
      );
    }

    before(async () => {
      // Service type 1 records a headcount only, so a count and no names.
      const attendance = await suite.api('POST', '/api/attendance', deskToken, {
        serviceTypeId: 1, count: 42,
      });
      assert.equal(attendance.status, 201, attendance.text);
    });

    it('writes it in English when the pastor reads English, even from a Kiswahili desk', async () => {
      await setPastorLanguage('en');
      const digest = await sendDigest(SW);
      assert.equal(digest.subject, i18n.catalogs.en['digest.subject']);
      assert.match(digest.body, /^Today’s parish report, sent by Generated Text Desk\./);
      assert.ok(!digest.body.includes('Ripoti ya leo'), 'the sender reading Kiswahili must not change the pastor\'s copy');
    });

    it('writes it in Kiswahili when the pastor reads Kiswahili, even from an English desk', async () => {
      await setPastorLanguage('sw');
      const digest = await sendDigest(EN);
      assert.equal(digest.subject, i18n.catalogs.sw['digest.subject']);
      assert.match(digest.body, /^Ripoti ya leo ya parokia, imetumwa na Generated Text Desk\./);
      assert.ok(digest.body.includes('Mahudhurio (kikao 1):'), digest.body);
      assert.ok(!digest.body.includes('Today'), 'no English frame may survive');

      // The record itself is not translated: the session name, the category and
      // the giver are data, and read the same in either language.
      assert.ok(digest.body.includes('  • 1st Sunday Service: 42'), digest.body);
      assert.ok(digest.body.includes('(Elisha Makala)'), digest.body);

      // …and the push that tells the pastor about it carries the same language.
      const push = await waitFor(() => suite.get(
        "SELECT * FROM notifications_log WHERE channel = 'push' AND record_type = 'attendance_digest' ORDER BY id DESC LIMIT 1"
      ));
      assert.ok(push, 'the summary must also be pushed');
      assert.equal(push.message, i18n.catalogs.sw['digest.subject']);
    });

    it('keeps the caller\'s OWN response in the caller\'s language in the same request', async () => {
      // Two readers, two languages, one request: the desk's reply and the pastor's
      // copy are localized independently.
      await setPastorLanguage('sw');
      const res = await suite.api('POST', '/api/emergencies', deskToken, {
        title: 'Water leak in the store', severity: 'high',
      }, SW);
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.message, i18n.catalogs.sw['messages.recordedSuccessfully']);

      const notification = await waitFor(() => suite.get(
        "SELECT * FROM notifications_log WHERE channel = 'in_app' AND record_type = 'emergency' AND record_id = ?",
        [res.json.id]
      ));
      assert.ok(notification, 'the pastor must be told');
      assert.match(notification.message, /^Juu · Water leak in the store \(imeripotiwa na Generated Text Desk\)/);
      assert.ok(!/reported by/.test(notification.message), 'the severity and the frame are both translated');
    });

    it('brands the push with the emergency in the pastor\'s language, severity and all', async () => {
      await setPastorLanguage('sw');
      // The sender's app is English: the language of the alert is the pastor's.
      const res = await suite.api('POST', '/api/emergencies', deskToken, {
        title: 'Power cut during the service', severity: 'critical', description: 'Generator failed',
      }, EN);
      assert.equal(res.status, 201, res.text);

      const push = await waitFor(() => suite.get(
        "SELECT * FROM notifications_log WHERE channel = 'push' AND record_type = 'emergency' AND record_id = ?",
        [res.json.id]
      ));
      assert.ok(push, 'a push must be attempted for a new emergency');
      assert.equal(push.message, '🚨 Dharura imeripotiwa: Power cut during the service');

      const notification = await waitFor(() => suite.get(
        "SELECT * FROM notifications_log WHERE channel = 'in_app' AND record_type = 'emergency' AND record_id = ?",
        [res.json.id]
      ));
      assert.match(notification.message, /^Hatari sana · Power cut during the service: Generator failed \(imeripotiwa na/);
    });

    it('calls an unreadable giver "Jina halipatikani", never "Bila jina"', async () => {
      // The two states mean different things (see utils/donorFields.js), and a
      // translation must not blur them into one.
      assert.notEqual(
        i18n.catalogs.sw['receipt.nameUnavailable'],
        i18n.catalogs.sw['receipt.anonymous']
      );
      assert.equal(i18n.catalogs.sw['receipt.anonymous'], 'Bila jina');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Text that leaves the system entirely
  // ---------------------------------------------------------------------------
  describe('SMS, email and the pastor\'s group updates', () => {
    it('sends the member announcement in the language it was written in', async () => {
      const member = await suite.api('POST', '/api/members', adminToken, {
        name: 'Announce Target', phone: '+255700000001', email: 'announce.target@test.local',
      });
      assert.equal(member.status, 201, member.text);

      const created = await suite.api('POST', '/api/events', adminToken, {
        title: 'Youth Rally', location: 'Church Grounds',
        startsAt: '2026-11-01T15:00:00', kind: 'event', collectionType: 'attendance', status: 'published',
      });
      assert.equal(created.status, 201, created.text);
      const eventId = created.json.event.id;

      const sent = await suite.api('POST', `/api/events/${eventId}/announce`, adminToken, null, SW);
      assert.equal(sent.status, 200, sent.text);

      // AT_API_KEY is blank in the suite, so each send is logged 'pending' with its
      // body: the message an SMS gateway would have carried, verbatim.
      const sms = await waitFor(() => suite.get(
        "SELECT * FROM notifications_log WHERE channel = 'sms' AND record_type = 'event_announce' AND record_id = ?",
        [eventId]
      ));
      assert.ok(sms, 'the blast must reach the SMS channel');
      assert.match(sms.message, /^Tangazo la VRT: Youth Rally\nWakati: 2026-11-01 15:00\nMahali: Church Grounds\nKaribu wote\. \(Mahudhurio\)$/);
      assert.ok(!sms.message.includes('All are welcome'), 'the announcement went out in English');
    });

    it.skip('sends the pastor the change line in the pastor\'s language, and the change itself as data', async () => {
      await setPastorLanguage('sw');
      const group = await suite.api('POST', '/api/groups', adminToken, { name: 'Announce Kwaya', kind: 'choir' });
      assert.equal(group.status, 201, group.text);
      const joined = await suite.api('POST', '/api/members', adminToken, {
        name: 'Kwaya Leader', groupIds: [group.json.group.id],
      });
      assert.equal(joined.status, 201, joined.text);
      await suite.api('PATCH', `/api/groups/${group.json.group.id}/members/${joined.json.member.id}`, adminToken, { role: 'leader' });
      // Two changes, so the line exercises both the counted form and the named
      // one: several joiners are counted, a single promotion is named.
      const plain = await suite.api('POST', '/api/members', adminToken, {
        name: 'Kwaya Member', groupIds: [group.json.group.id],
      });
      assert.equal(plain.status, 201, plain.text);

      // The SENDER is English here; only the receiver's setting differs.
      const sent = await suite.api('POST', `/api/groups/${group.json.group.id}/notify-pastor`, deskToken, null, EN);
      assert.equal(sent.status, 200, sent.text);

      const message = await suite.get(
        "SELECT * FROM messages WHERE category = 'member_alert' AND subject = ? ORDER BY id DESC LIMIT 1",
        [i18n.catalogs.sw['group.subject'].replace('{name}', 'Announce Kwaya')]
      );
      assert.ok(message, 'the update must be written with the pastor\'s subject line');

      // The line is the catalog's, assembled: nothing about the members is
      // printed that the catalog did not ask for, and no roster appears at all.
      const sw = i18n.catalogs.sw;
      const changes = [
        sw['group.changeAddedMany'].replace('{count}', '2'),
        sw['group.changeRole'].replace('{member}', 'Kwaya Leader').replace('{role}', sw['group.role_leader']),
      ].join(', ');
      assert.equal(message.body, sw['group.changeSummary'].replace('{name}', 'Announce Kwaya').replace('{changes}', changes));
      assert.ok(!message.body.includes('\n- '), 'an update is a line, not a roster');
      assert.ok(!message.body.includes('· choir ·'), 'the stored kind must be labelled, not printed raw');

      // The DATA twin stays language-independent: it carries WHICH group and WHAT
      // changed, so the app renders the line in its own language and follows the
      // link for the current membership. The names of the rest of the group are
      // not in it, which is what makes it unable to go stale.
      const payload = JSON.parse(message.payload);
      assert.equal(payload.group.kind, 'choir');
      assert.equal(payload.url, `/groups/${group.json.group.id}`);
      assert.deepEqual(payload.changes, [
        { action: 'added', name: 'Kwaya Leader', role: 'member' },
        { action: 'role_changed', name: 'Kwaya Leader', role: 'leader' },
        { action: 'added', name: 'Kwaya Member', role: 'member' },
      ]);
      assert.equal(payload.members, undefined);
      assert.equal(payload.leaders, undefined);
      assert.equal(payload.total, undefined);
    });

    it('restores the pastor to English so nothing leaks into other suites', async () => {
      await setPastorLanguage('en');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. The guards
  // ---------------------------------------------------------------------------
  describe('catalog integrity for generated text', () => {
    const SERVER_DIR = path.join(__dirname, '..');
    const sourceFiles = (dir) => fs.readdirSync(path.join(SERVER_DIR, dir))
      .filter((name) => name.endsWith('.js'))
      .map((name) => path.join(SERVER_DIR, dir, name));

    it('names no catalog key that does not exist, in any route or util', () => {
      // The route-layer half of this check lives in i18n.test.js. This is the half
      // that a rendered document needs: a key spelled wrong in utils/receipt.js
      // would otherwise be printed on paper exactly as written.
      // 'verify' is the public receipt-verification page (utils/receiptVerification.js):
      // a key spelled wrong there is a page a member reads, so it belongs here.
      const namespaces = ['errors', 'messages', 'receipt', 'sheet', 'events', 'event', 'digest', 'group', 'emergency', 'notify', 'verify', 'payment'];
      const pattern = new RegExp(`'((${namespaces.join('|')})\\.[A-Za-z0-9_]+)'`, 'g');
      const offenders = [];
      const prefixes = new Set();
      let seen = 0;

      for (const file of [...sourceFiles('routes'), ...sourceFiles('utils')]) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(pattern)) {
          seen += 1;
          // A literal ending in `_` is the PREFIX of an enum's label, not a key:
          // the value comes from the record ("group.kind_" + "choir"). It is held
          // to a different standard: the enum sweep below, and here it only has
          // to be a prefix the catalog actually labels something under.
          if (match[1].endsWith('_')) {
            prefixes.add(`${path.relative(SERVER_DIR, file)} (${match[1]})`);
            const labelled = Object.keys(i18n.catalogs.en).some((key) => key.startsWith(match[1]));
            if (!labelled) offenders.push(`${path.relative(SERVER_DIR, file)} (${match[1]}*)`);
            continue;
          }
          if (!i18n.isKnownKey(match[1])) {
            offenders.push(`${path.relative(SERVER_DIR, file)} (${match[1]})`);
          }
        }
      }

      assert.ok(seen > 100, `expected to sweep the key literals, matched only ${seen}`);
      assert.ok(prefixes.size >= 4, `expected the enum label prefixes to be found, saw ${prefixes.size}`);
      assert.deepEqual(offenders, [], 'a key used in a route or util must exist in the catalog');
    });

    it('labels every enum the API stores, in both languages, with nothing stale', () => {
      // The enum lists are read from the code that VALIDATES them, so adding a
      // group kind without a label fails here rather than printing "workshop".
      const enums = [
        { file: 'utils/payments.js', name: 'PAYMENT_METHODS', prefix: 'payment.method_' },
        // The payment-integration vocabulary: a provider, how a payment arrived,
        // what the provider said about it, what the church has decided about it,
        // and how a gift was recorded. Every one of these is stored in a column
        // and read on an admin screen, so every one needs a label in both
        // catalogs, and a fifth value added without one fails the build.
        { file: 'utils/paymentProviders.js', name: 'PROVIDER_KEYS', prefix: 'payment.provider_', min: 2 },
        { file: 'utils/paymentProviders.js', name: 'TRANSACTION_STATUSES', prefix: 'payment.status_' },
        { file: 'utils/paymentIntake.js', name: 'MATCH_STATUSES', prefix: 'payment.match_' },
        { file: 'utils/paymentIntake.js', name: 'INTAKE_SOURCES', prefix: 'payment.intake_' },
        { file: 'utils/offeringRecord.js', name: 'OFFERING_SOURCES', prefix: 'payment.record_' },
        { file: 'routes/events.js', name: 'KINDS', prefix: 'events.kind_' },
        { file: 'routes/events.js', name: 'COLLECTION_TYPES', prefix: 'events.collection_' },
        { file: 'routes/groups.js', name: 'GROUP_KINDS', prefix: 'group.kind_' },
        { file: 'routes/emergencies.js', name: 'SEVERITIES', prefix: 'emergency.severity_' },
      ];

      for (const { file, name, prefix, min } of enums) {
        const source = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
        const declaration = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`));
        assert.ok(declaration, `${file} no longer declares ${name}: this guard has gone blind`);
        const values = [...declaration[1].matchAll(/'([a-zA-Z_]+)'/g)].map((m) => m[1]);
        // `min` defaults to 3, because a list this guard parses should always be
        // a genuine enum; the provider list is the one legitimate pair today.
        assert.ok(values.length >= (min || 3), `${name} parsed to ${values.length} values`);

        for (const value of values) {
          for (const [language, catalog] of Object.entries(i18n.catalogs)) {
            assert.equal(
              typeof catalog[`${prefix}${value}`], 'string',
              `${language} has no label for ${prefix}${value}: it would be printed raw`
            );
          }
        }

        // And the reverse: a label left behind for a value the API no longer
        // accepts is dead weight that hides the next real gap.
        const declared = new Set(values.map((v) => `${prefix}${v}`));
        const stale = Object.keys(i18n.catalogs.en).filter((key) => key.startsWith(prefix) && !declared.has(key));
        assert.deepEqual(stale, [], `labels that no longer match a stored value: ${prefix}`);
      }
    });

    it('never prints the raw stored value of an enum it has a label for', () => {
      // A cheap lock on rule 3: the labels differ from the values for every enum,
      // so a stray raw value in generated text is visible to a reader.
      for (const value of ['choir', 'worship_team', 'critical', 'both']) {
        const key = Object.keys(i18n.catalogs.en).find((k) => k.endsWith(`_${value}`));
        assert.ok(key, `no label ends with _${value}`);
        assert.notEqual(i18n.catalogs.en[key], value, `${key} is not a label`);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 6. A document and the app it came from must name the same place
  // ---------------------------------------------------------------------------
  describe('a printed document says what the app says', () => {
    const SERVER_DIR = path.join(__dirname, '..');
    const REPO_ROOT = path.join(SERVER_DIR, '..');
    const CLIENTS = ['client-admin', 'client-pastor'];

    /** The value of one `export const X = '...'` in a client's common.js. */
    function clientConstant(client, name) {
      const file = path.join(REPO_ROOT, client, 'src', 'i18n', 'common.js');
      const match = fs.readFileSync(file, 'utf8').match(new RegExp(`${name}\\s*=\\s*'([^']*)'`));
      assert.ok(match, `${client}/common.js no longer declares ${name}: this guard has gone blind`);
      return match[1];
    }

    it('keeps the server\'s copy of the church\'s name and address identical to both apps\'', () => {
      // The server and the clients cannot share the constant (CommonJS vs ES
      // modules), so they share the guarantee instead. This is the test that
      // makes the comment in utils/brand.js true.
      const brand = require('../utils/brand');
      for (const client of CLIENTS) {
        assert.equal(clientConstant(client, 'CHURCH_NAME'), brand.CHURCH_NAME, `${client} shows a different church name`);
        assert.equal(clientConstant(client, 'CHURCH_ADDRESS'), brand.CHURCH_ADDRESS, `${client} shows a different address`);
      }
    });

    it('prints that address in the receipt footer, in either language', () => {
      const { renderReceiptHtml } = require('../utils/receipt');
      const { htmlSheet } = require('../utils/eventSheet');
      const brand = require('../utils/brand');
      const footer = `${brand.CHURCH_NAME} · ${brand.CHURCH_ADDRESS}`;
      const row = {
        receipt_number: 'VR-2026-0001', service_date: '2026-09-13', service_name: 'Sunday Service',
        amount: 1000, currency: 'TZS', recorded_by_name: 'Front Desk',
      };

      // "Never disagree" also means the printed copy cannot be right in one
      // language and stale in the other.
      for (const locale of ['en', 'sw']) {
        const html = renderReceiptHtml(row, locale);
        assert.ok(html.includes(footer), `the ${locale} receipt must carry the app's address`);
      }

      // The sheet sets its masthead in caps, so compare the name the way it is
      // actually set rather than as the constant is written.
      const event = { title: 'Harvest Thanksgiving', starts_at: '2026-10-04T09:00:00', kind: 'service', collection_type: 'attendance' };
      assert.ok(
        htmlSheet(event, 'en').includes(brand.CHURCH_NAME.toUpperCase()),
        'the event sheet prints the same church name'
      );
    });
  });
});
