'use strict';
/**
 * Phased-prompt regression tests:
 * - Phase 1: login lockouts are scoped per app (admin lockout never touches pastor)
 * - Phase 1: lockout lasts ~60s and self-expires (no admin unlock)
 * - Phase 4: publishing an event notifies the receptionist with a printable sheet
 * - Phase 4: publishing auto-provisions a ready-to-use data-collection workspace
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'phased-prompt', port: 4604 });
let adminToken;
let recToken;
let pastorToken;

// The church's own "today" (Africa/Dar_es_Salaam), which is NOT the UTC date
// between 21:00 and 24:00 UTC, when the church has already rolled over. The
// front desk may only record entries for the church's current day, so an event
// the receptionist then records against has to land on that day. Ask the server
// rather than guessing from the test process's clock.
async function churchToday() {
  const res = await suite.api('GET', '/api/time', adminToken);
  return res.json.date;
}

after(() => suite.stop());

describe('phase 1: per-app lockout independence', () => {
  before(async () => {
    await suite.waitReady();
    const login = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church', password: 'TestPass_123!',
    });
    adminToken = login.json.token;
    await suite.api('POST', '/api/users', adminToken, {
      name: 'Front Desk', email: 'desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const rec = await suite.api('POST', '/api/auth/login', null, { email: 'desk@test.local', password: 'DeskPass_123!' });
    recToken = rec.json.token;
    const pastor = await suite.api('POST', '/api/auth/login', null, {
      email: 'pastor@victoryrevival.church', password: 'TestPass_123!', app: 'pastor',
    });
    pastorToken = pastor.json.token;
  });

  it('locking admin login leaves pastor login on the same account untouched', async () => {
    // 5 failures on the ADMIN app for the pastor's email...
    for (let i = 0; i < 5; i++) {
      const r = await suite.api('POST', '/api/auth/login', null, {
        email: 'pastor@victoryrevival.church', password: 'wrong', app: 'admin',
      });
      assert.ok([401, 429].includes(r.status), `admin-side failure ${i} → 401/429`);
    }
    // ...the admin app is now locked...
    const locked = await suite.api('POST', '/api/auth/login', null, {
      email: 'pastor@victoryrevival.church', password: 'wrong', app: 'admin',
    });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.json.retryAfter) > 0 && Number(locked.json.retryAfter) <= 60);

    // ...but the PASTOR app with the right password still works immediately.
    const ok = await suite.api('POST', '/api/auth/login', null, {
      email: 'pastor@victoryrevival.church', password: 'TestPass_123!', app: 'pastor',
    });
    assert.equal(ok.status, 200, 'pastor app must not share lockout state with admin app');
    assert.ok(ok.json.token);
  });

  it('lockout self-expires after the retry window (no manual unlock)', async () => {
    // Dedicated victim email so the shared per-IP rate limiter (which counts
    // ALL logins from this test process) can never mask the per-account expiry
    // we are proving. Five failures on the admin app...
    const email = 'expiry-probe@test.local';
    await suite.api('POST', '/api/users', adminToken, {
      name: 'Expiry Probe', email, role: 'admin', password: 'ProbePass_123!',
    });
    for (let i = 0; i < 5; i++) {
      const r = await suite.api('POST', '/api/auth/login', null, { email, password: 'wrong', app: 'admin' });
      assert.ok([401, 429].includes(r.status), `failure ${i} → 401/429`);
    }
    const locked = await suite.api('POST', '/api/auth/login', null, { email, password: 'ProbePass_123!', app: 'admin' });
    assert.equal(locked.status, 429, 'locked even with the correct password');

    // ...then wait out the 60s window with ONE poll: the lock must lift on its
    // own (server-side expiry, no admin unlock). A handful of requests total
    // keeps the per-IP limiter out of the picture.
    await new Promise((res) => setTimeout(res, 62000));
    const after = await suite.api('POST', '/api/auth/login', null, { email, password: 'ProbePass_123!', app: 'admin' });
    assert.equal(after.status, 200, 'lockout expires automatically without admin action');
  });
});

describe('phase 4: publish → receptionist notified + printable sheet + workspace ready', () => {
  before(async () => {
    const p = await suite.api('POST', '/api/auth/login', null, {
      email: 'pastor@victoryrevival.church', password: 'TestPass_123!', app: 'pastor',
    });
    pastorToken = p.json.token;
  });

  it('publishing creates the receptionist message with printable sheet + provisioned workspace', async () => {
    const when = `${await churchToday()}T15:00`;
    const ev = await suite.api('POST', '/api/events', pastorToken, {
      title: 'Youth Conference Night',
      description: 'An evening of worship and teaching.',
      location: 'Main Sanctuary',
      startsAt: when,
      collectionType: 'both',
    });
    assert.equal(ev.status, 201, JSON.stringify(ev.json));
    const draftId = ev.json.event.id;

    const pub = await suite.api('PATCH', `/api/events/${draftId}`, pastorToken, { status: 'published' });
    assert.equal(pub.status, 200, JSON.stringify(pub.json));
    const published = pub.json.event;

    // 1. Receptionist received a clear notification with event details.
    const msgs = await suite.api('GET', '/api/messages', recToken);
    const notice = msgs.json.conversations.broadcasts.find((m) => m.category === 'event' && m.subject.includes('Youth Conference Night'));
    assert.ok(notice, 'receptionist broadcast exists');
    assert.match(notice.body, /Collection: Attendance & Offerings/);
    assert.ok(notice.payload.printable, 'printable sheet embedded in payload');
    assert.match(notice.payload.printable, /VICTORY REVIVAL TEMPLE/);
    assert.match(notice.payload.printable, /Youth Conference Night/);

    // 2. A clean printable sheet endpoint exists.
    const sheet = await suite.api('GET', `/api/events/${draftId}/printable-sheet`, recToken);
    assert.equal(sheet.status, 200);
    assert.match(sheet.json.sheet, /Youth Conference Night/);

    // 3. Workspace: a typed services row, pre-filled with the event's name/date.
    const ws = await suite.get('SELECT * FROM services WHERE id = ?', [published.workspace_service_id]);
    assert.ok(ws, 'workspace service row exists');
    assert.equal(ws.name, 'Youth Conference Night');
    assert.equal(ws.date, when.slice(0, 10));
    assert.equal(ws.is_temporary, 1);
    const type = await suite.get('SELECT * FROM service_types WHERE id = ?', [ws.service_type_id]);
    assert.ok(type, 'workspace is typed (recordable through the normal path)');
    assert.equal(type.key, 'special_event');

    // 4. Publish flow is idempotent: re-save never re-provisions or re-notifies.
    const resave = await suite.api('PATCH', `/api/events/${draftId}`, pastorToken, { description: 'Updated details.' });
    assert.equal(resave.status, 200);
    const msgCount = (await suite.get("SELECT COUNT(*) AS n FROM messages WHERE category = 'event'")).n;
    const svcCount = (await suite.get('SELECT COUNT(*) AS n FROM services WHERE event_title = ?', ['Youth Conference Night'])).n;
    assert.equal(svcCount, 1, 'no duplicate workspace on re-save');
    assert.equal(msgCount, 1, 'no duplicate receptionist notification on re-save');
  });

  it('creating an already-published event provisions immediately (POST path)', async () => {
    const when = `${await churchToday()}T09:00`;
    const ev = await suite.api('POST', '/api/events', pastorToken, {
      title: 'Dawn Prayer Summit',
      startsAt: when,
      status: 'published',
      collectionType: 'attendance',
    });
    assert.equal(ev.status, 201);
    const ws = await suite.get('SELECT * FROM services WHERE id = ?', [ev.json.event.workspace_service_id]);
    assert.ok(ws, 'workspace exists straight from POST /events with status published');
  });

  it('front desk can record attendance into the workspace through the normal typed path', async () => {
    const ws = await suite.get("SELECT s.* FROM services s JOIN service_types st ON st.id = s.service_type_id WHERE st.key = 'special_event' AND s.name = 'Dawn Prayer Summit'");
    assert.ok(ws, 'workspace exists');
    // The front desk picks the type, then the event by name in the sub-session
    // picker: exactly how the provisioned workspace is addressed.
    const types = await suite.api('GET', '/api/service-types', recToken);
    const special = types.json.serviceTypes.find((x) => x.key === 'special_event');
    assert.ok(special, 'Special Event type visible to the front desk');
    const sub = (special.subSessions || []).find((x) => x.name === 'Dawn Prayer Summit');
    assert.ok(sub, 'event name appears as a selectable sub-session');

    const rec = await suite.api('POST', '/api/attendance', recToken, {
      serviceTypeId: special.id,
      subSessionId: sub.id,
      date: ws.date,
      count: 42,
    });
    assert.equal(rec.status, 201, JSON.stringify(rec.json));
    // The record landed on the event's own workspace session, not another
    // same-day event's.
    const landed = await suite.get('SELECT service_id FROM attendance WHERE id = ?', [rec.json.id]);
    assert.equal(landed.service_id, ws.id, 'recording resolves to the pre-provisioned workspace');
  });

  it('audit chain stays valid across the publish flow', async () => {
    const res = await suite.api('GET', '/api/reports/audit-integrity', adminToken);
    assert.equal(res.status, 200);
    assert.equal(res.json.valid, true);
  });

  it('printable sheet serves plain text, branded HTML, and a real PDF', async () => {
    const ev = await suite.api('POST', '/api/events', pastorToken, {
      title: 'Sheet Format Check', startsAt: `${await churchToday()}T11:00`, status: 'published',
    });
    const id = ev.json.event.id;

    const text = await suite.api('GET', `/api/events/${id}/printable-sheet`, recToken);
    assert.equal(text.status, 200);
    assert.match(text.json.sheet, /Sheet Format Check/);

    const html = await suite.api('GET', `/api/events/${id}/printable-sheet?format=html`, recToken);
    assert.equal(html.status, 200);
    assert.match(html.text, /VICTORY REVIVAL TEMPLE/);
    assert.match(html.text, /Sheet Format Check/);

    const pdf = await suite.api('GET', `/api/events/${id}/printable-sheet?format=pdf`, recToken);
    assert.equal(pdf.status, 200);
    assert.ok(pdf.text.startsWith('%PDF-'), 'response body is a real PDF');
  });

  it('finalize promotes the workspace to permanent, reports totals, and never acts twice', async () => {
    // Record some data into the Youth Conference Night workspace first.
    const ws = await suite.get("SELECT s.* FROM services s JOIN service_types st ON st.id = s.service_type_id WHERE st.key = 'special_event' AND s.name = 'Youth Conference Night'");
    assert.ok(ws, 'workspace from the publish test exists');
    const types = await suite.api('GET', '/api/service-types', recToken);
    const special = types.json.serviceTypes.find((x) => x.key === 'special_event');
    const sub = (special.subSessions || []).find((x) => x.name === 'Youth Conference Night');
    await suite.api('POST', '/api/attendance', recToken, { serviceTypeId: special.id, subSessionId: sub.id, date: ws.date, count: 120 });
    await suite.api('POST', '/api/offerings', recToken, { serviceTypeId: special.id, subSessionId: sub.id, date: ws.date, category: 'general', amount: 25000 });

    const evRow = await suite.get('SELECT id FROM events WHERE title = ?', ['Youth Conference Night']);

    const fin = await suite.api('POST', `/api/events/${evRow.id}/finalize`, pastorToken);
    assert.equal(fin.status, 200, JSON.stringify(fin.json));
    assert.equal(fin.json.summary.attendance, 120);
    assert.equal(fin.json.summary.gifts, 1);
    assert.equal(fin.json.summary.offerings, 25000);

    const promoted = await suite.get('SELECT is_temporary FROM services WHERE id = ?', [ws.id]);
    const audit = await suite.get("SELECT action FROM audit_log WHERE action = 'event_finalized' AND record_id = ?", [ws.id]);
    const feed = await suite.get("SELECT message FROM notifications_log WHERE record_type = 'event' AND message LIKE '%permanent record%' ORDER BY id DESC LIMIT 1");
    assert.equal(promoted.is_temporary, 0, 'workspace promoted to permanent');
    assert.ok(audit, 'promotion audit-logged');
    assert.ok(feed, 'pastor feed carries the finalize summary');

    // Idempotency: second finalize is refused, data untouched.
    const again = await suite.api('POST', `/api/events/${evRow.id}/finalize`, pastorToken);
    assert.equal(again.status, 409);
    const still = await suite.get('SELECT is_temporary FROM services WHERE id = ?', [ws.id]);
    const finCount = (await suite.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'event_finalized' AND record_id = ?", [ws.id])).n;
    assert.equal(still.is_temporary, 0);
    assert.equal(finCount, 1, 'no duplicate finalize audit rows');

    // The promoted session remains fully visible in records (nothing hidden).
    const list = await suite.api('GET', `/api/attendance?from=${ws.date}&to=${ws.date}`, adminToken);
    assert.ok(list.json.attendance.some((a) => a.service_id === ws.id && a.count === 120), 'promoted records stay in the permanent record');
  });

  it('finalize is pastor/admin-only and refuses drafts', async () => {
    const draft = await suite.api('POST', '/api/events', pastorToken, {
      title: 'Still A Draft', startsAt: `${await churchToday()}T18:00`,
    });
    const denied = await suite.api('POST', `/api/events/${draft.json.event.id}/finalize`, recToken);
    assert.equal(denied.status, 403);
    const noWs = await suite.api('POST', `/api/events/${draft.json.event.id}/finalize`, pastorToken);
    assert.equal(noWs.status, 409, 'draft without a published workspace cannot finalize');
  });

  it('review queue lists only ended, still-temporary events with their totals', async () => {
    // Every workspace from earlier tests carries today's date, so nothing is
    // "ended" yet: make one explicitly past event with data.
    const today = await churchToday();
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const pastDate = yesterday.toISOString().slice(0, 10);
    const past = await suite.api('POST', '/api/events', pastorToken, {
      title: 'Past Outreach', startsAt: `${pastDate}T10:00`, status: 'published', collectionType: 'both',
    });
    assert.equal(past.status, 201);
    const wsId = past.json.event.workspace_service_id;
    const ws = await suite.get('SELECT * FROM services WHERE id = ?', [wsId]);
    const special = await suite.get("SELECT * FROM service_types WHERE key = 'special_event'");
    const sub = await suite.get('SELECT * FROM service_type_sessions WHERE service_type_id = ? AND name = ?', [special.id, 'Past Outreach']);
    // Backdated entry is admin-only (receptionists are locked to today).
    const att = await suite.api('POST', '/api/attendance', adminToken, { serviceTypeId: special.id, subSessionId: sub.id, date: ws.date, count: 75 });
    assert.equal(att.status, 201);
    await suite.api('POST', '/api/offerings', adminToken, { serviceTypeId: special.id, subSessionId: sub.id, date: ws.date, category: 'general', amount: 9000 });

    const queue = await suite.api('GET', '/api/events/pending-finalization', adminToken);
    assert.equal(queue.status, 200);
    const row = queue.json.events.find((e) => e.id === past.json.event.id);
    assert.ok(row, 'ended temporary event is queued');
    assert.equal(row.attendance, 75);
    assert.equal(row.offerings, 9000);
    assert.ok(row.workspace_service_id);

    // Receptionists do not see the queue (admin/pastor-only surface).
    const denied = await suite.api('GET', '/api/events/pending-finalization', recToken);
    assert.equal(denied.status, 403);

    // Finalize removes it from the queue.
    const fin = await suite.api('POST', `/api/events/${past.json.event.id}/finalize`, adminToken);
    assert.equal(fin.status, 200);
    const after = await suite.api('GET', '/api/events/pending-finalization', adminToken);
    assert.equal(after.json.events.some((e) => e.id === past.json.event.id), false, 'finalized event leaves the queue');
  });

  it('announce texts members once, emails the rest, logs every send, and refuses a second blast', async () => {
    // Seed: two members with phone numbers, one with only an email (email
    // channel), one with neither (skipped). Phone numbers are encrypted with
    // the same field cipher the server reads them back with (FIELD_ENCRYPTION_KEY
    // comes from server/.env, loaded by test/helpers.js).
    const { encryptField } = require('../utils/crypto');
    await suite.run('INSERT INTO members (name, phone_enc, is_active) VALUES (?, ?, 1)', ['Anna Mwitu', encryptField('+255700000001')]);
    await suite.run('INSERT INTO members (name, phone_enc, is_active) VALUES (?, ?, 1)', ['Baraka N', encryptField('+255700000002')]);
    await suite.run("INSERT INTO members (name, email, is_active) VALUES ('Cynthia Mail', 'cynthia@test.local', 1)");
    await suite.run("INSERT INTO members (name, is_active) VALUES ('No Contact', 1)");
    const seeded = (await suite.get("SELECT COUNT(*) AS n FROM members WHERE name IN ('Anna Mwitu', 'Baraka N', 'Cynthia Mail', 'No Contact')")).n;
    assert.equal(seeded, 4, 'member seed landed');

    const ev = await suite.api('POST', '/api/events', pastorToken, {
      title: 'Announce Blast Check', startsAt: `${await churchToday()}T17:00`, status: 'published',
    });
    const id = ev.json.event.id;

    // Report before announcing is a 409, not a silent empty report.
    const early = await suite.api('GET', `/api/events/${id}/announce-report`, pastorToken);
    assert.equal(early.status, 409);

    const res = await suite.api('POST', `/api/events/${id}/announce`, pastorToken);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.recipients, 3, 'phone + email members all reached');
    assert.equal(res.json.sms, 2, 'two SMS recipients');
    assert.equal(res.json.email, 1, 'email-only member got the email channel');

    // Blast rows carry record_type 'event_announce' (scoped to the blast), so
    // the publish-time pastor notification (record_type 'event') never pollutes
    // the delivery report.
    const sms = await suite.all("SELECT status, COUNT(*) AS n FROM notifications_log WHERE channel = 'sms' AND record_type = 'event_announce' AND record_id = ? GROUP BY status", [id]);
    const emails = await suite.all("SELECT status, sent_to FROM notifications_log WHERE channel = 'email' AND record_type = 'event_announce' AND record_id = ?", [id]);
    const audit = await suite.get("SELECT details FROM audit_log WHERE action = 'event_announced' AND record_id = ?", [id]);
    const stamp = await suite.get('SELECT announced_at FROM events WHERE id = ?', [id]);
    // Without AT/SMTP credentials every send is 'pending': logged, never lost.
    assert.ok(sms.every((s) => ['pending', 'sent'].includes(s.status)), 'every SMS is logged (sent or pending)');
    assert.equal(emails.length, 1);
    assert.equal(emails[0].sent_to, 'cynthia@test.local');
    assert.ok(['pending', 'sent'].includes(emails[0].status));
    assert.match(String(audit.details), /"sms":2/);
    assert.match(String(audit.details), /"email":1/);
    assert.ok(stamp.announced_at, 'announced_at stamped');

    // Delivery report: per-channel breakdown matching the blast.
    const rep = await suite.api('GET', `/api/events/${id}/announce-report`, pastorToken);
    assert.equal(rep.status, 200);
    assert.equal(rep.json.channels.sms.sent + rep.json.channels.sms.pending, 2);
    assert.equal(rep.json.channels.email.sent + rep.json.channels.email.pending, 1);
    const deniedRep = await suite.api('GET', `/api/events/${id}/announce-report`, recToken);
    assert.equal(deniedRep.status, 403, 'receptionists cannot read the report');

    const again = await suite.api('POST', `/api/events/${id}/announce`, pastorToken);
    assert.equal(again.status, 409, 'second blast is refused: no double-texting the congregation');
    const smsTotal = (await suite.get("SELECT COUNT(*) AS n FROM notifications_log WHERE channel = 'sms' AND record_type = 'event_announce' AND record_id = ?", [id])).n;
    assert.equal(smsTotal, 2, 'no extra SMS rows after the refused retry');

    const denied = await suite.api('POST', `/api/events/${id}/announce`, recToken);
    assert.equal(denied.status, 403, 'receptionists cannot trigger blasts');
  });
});
