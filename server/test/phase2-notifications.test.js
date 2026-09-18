'use strict';
/**
 * Phase 2 (notification integrity) regression tests.
 * - offerings never notify the pastor per record
 * - the batched digest is atomic, today-scoped, and idempotent
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'phase2-digest', port: 4601 });
let adminToken;

describe('phase 2: notification integrity', () => {
  before(async () => {
    await suite.waitReady();
    const login = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    // Login is a single step: credentials alone yield a full session token.
    assert.equal(login.status, 200);
    adminToken = login.json.token;
    assert.ok(adminToken);
  });

  it('recording an offering fires no per-record notification', async () => {
    const rec = await suite.api('POST', '/api/offerings', adminToken, { serviceTypeId: 1, category: 'general', amount: 2500 });
    assert.equal(rec.status, 201);
    const logs = (await suite.get("SELECT COUNT(*) c FROM notifications_log WHERE record_type = 'offering'")).c;
    assert.equal(logs, 0);
  });

  it('digest covers only today and is sent once', async () => {
    const sent = await suite.api('POST', '/api/notifications/send-summary', adminToken);
    assert.equal(sent.json.sent, true);
    assert.equal(sent.json.offeringsCount, 1);
    const again = await suite.api('POST', '/api/notifications/send-summary', adminToken);
    assert.equal(again.json.sent, false);
    assert.equal((await suite.get('SELECT COUNT(*) c FROM messages')).c, 1);
    // CURRENT_DATE is the Postgres equivalent of SQLite's date('now').
    const pending = (await suite.get('SELECT COUNT(*) c FROM offerings WHERE notified_at IS NULL AND date(timestamp) = CURRENT_DATE')).c;
    assert.equal(pending, 0);
  });

  it('digest skips voided offerings', async () => {
    const rec = await suite.api('POST', '/api/offerings', adminToken, { serviceTypeId: 1, category: 'general', amount: 999 });
    assert.equal(rec.status, 201);
    const v = await suite.api('PATCH', `/api/offerings/${rec.json.id}/void`, adminToken, { reason: 'test' });
    assert.equal(v.status, 200);
    // The voided gift is the caller's only pending record, so there is nothing
    // left to batch: sent=false (not an empty digest). The point of this test
    // is that the voided amount never reaches the pastor's summary.
    const sent = await suite.api('POST', '/api/notifications/send-summary', adminToken);
    assert.equal(sent.json.sent, false);
    assert.equal(sent.json.offeringsCount, 0);
  });
});

/**
 * The badge the pastor app polls.
 *
 * Both the nav pill and the Home notifications tile render `total` from this
 * one response, so a caller cannot compute a number that disagrees with the
 * nav. The subtle part is the digest: sending a summary writes a message row
 * AND an in-app notification for the same event, so counting both would report
 * one summary as two unread things.
 */
describe('phase 2: the unread badge counts each thing once', () => {
  const PASTOR = { email: 'pastor@victoryrevival.church', password: 'TestPass_123!' };
  let pastorToken;

  const unreadFor = async () => {
    const res = await suite.api('GET', '/api/messages/unread', pastorToken);
    assert.equal(res.status, 200, res.text);
    return res.json;
  };

  before(async () => {
    const login = await suite.api('POST', '/api/auth/login', null, PASTOR);
    assert.equal(login.status, 200, login.text);
    pastorToken = login.json.token;
  });

  it('reports the message count, the notification count, and their total', async () => {
    const { unread, notifications, total } = await unreadFor();

    for (const value of [unread, notifications, total]) assert.equal(typeof value, 'number');
    assert.equal(total, unread + notifications);
    // Earlier tests in this file sent a digest, so the pastor has something unread.
    assert.ok(unread >= 1, 'the digest sent above must be waiting');
  });

  it('counts a summary digest as one thing, not two', async () => {
    const before = await unreadFor();

    const rec = await suite.api('POST', '/api/offerings', adminToken, { serviceTypeId: 1, category: 'general', amount: 4200 });
    assert.equal(rec.status, 201, rec.text);
    const sent = await suite.api('POST', '/api/notifications/send-summary', adminToken);
    assert.equal(sent.json.sent, true, sent.text);

    const after = await unreadFor();
    // The broadcast counts; its in-app twin is the same event and must not.
    assert.equal(after.unread, before.unread + 1);
    assert.equal(after.notifications, before.notifications);
    assert.equal(after.total, before.total + 1);
  });

  it('marks the canonical message read when its Home notification twin is opened', async () => {
    const feed = await suite.api('GET', '/api/notifications', pastorToken);
    assert.equal(feed.status, 200, feed.text);
    const digestNotice = feed.json.notifications.find((row) => ['attendance_digest', 'offering_digest'].includes(row.record_type) && !row.read_at);
    assert.ok(digestNotice, 'an unread summary twin should be in the feed');

    const before = await unreadFor();
    const marked = await suite.api('PATCH', `/api/notifications/${digestNotice.id}/read`, pastorToken);
    assert.equal(marked.status, 200, marked.text);
    const after = await unreadFor();
    assert.equal(after.unread, before.unread - 1);
  });

  it('counts a notification that has no message behind it', async () => {
    const before = await unreadFor();

    const alert = await suite.api('POST', '/api/emergencies', adminToken, { title: 'Badge check', severity: 'low' });
    assert.equal(alert.status, 201, alert.text);

    const after = await unreadFor();
    // An alert reaches the pastor as an in-app notification only, nowhere in
    // the conversation list, so it has to be counted here or not at all.
    assert.equal(after.notifications, before.notifications + 1);
    assert.equal(after.unread, before.unread);
    assert.equal(after.total, before.total + 1);
  });

  it('settles back down once the pastor has read everything', async () => {
    await suite.run("UPDATE messages SET read_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE recipient_role = 'pastor' AND read_at IS NULL");
    await suite.run("UPDATE notifications_log SET read_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE channel = 'in_app' AND read_at IS NULL");

    const { unread, notifications, total } = await unreadFor();
    assert.equal(unread, 0);
    assert.equal(notifications, 0);
    assert.equal(total, 0);
  });
});

// Top level, not inside the first describe: the suite's server has to outlive
// every block in this file, not just the one that used to be last.
after(() => suite.stop());
