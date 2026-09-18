'use strict';
/**
 * Recalling a message sent to the pastor.
 *
 * A recall has to mean the pastor stops seeing it, not merely that a column
 * changed. These tests therefore assert on the READ PATHS the pastor's app
 * actually calls (the feed, the badge, the notification list) rather than on the
 * row alone, because a half-withdrawn message (gone from the feed, still in the
 * notification list) is the failure this feature exists to prevent.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'messages-recall', port: 4629 });

const PASTOR = { email: 'pastor@victoryrevival.church', password: 'TestPass_123!' };
const DESK = { email: 'recall-desk@test.local', password: 'DeskPass_123!' };
const OTHER_DESK = { email: 'recall-desk-2@test.local', password: 'DeskPass_123!' };

let adminToken;
let deskToken;
let otherDeskToken;
let pastorToken;

async function login(creds) {
  const res = await suite.api('POST', '/api/auth/login', null, creds);
  assert.equal(res.status, 200, res.text);
  return res.json.token;
}

const feedFor = async (token) => {
  const res = await suite.api('GET', '/api/messages', token);
  assert.equal(res.status, 200, res.text);
  return res.json.conversations;
};

const unreadFor = async (token) => {
  const res = await suite.api('GET', '/api/messages/unread', token);
  assert.equal(res.status, 200, res.text);
  return res.json;
};

const notificationsFor = async (token) => {
  const res = await suite.api('GET', '/api/notifications', token);
  assert.equal(res.status, 200, res.text);
  return res.json.notifications;
};

const sentFor = async (token) => {
  const res = await suite.api('GET', '/api/messages/sent?to=pastor', token);
  assert.equal(res.status, 200, res.text);
  return res.json.sent;
};

describe('recall: a message sent to the pastor by mistake', () => {
  before(async () => {
    await suite.waitReady();
    adminToken = await login({ email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' });
    await suite.api('POST', '/api/users', adminToken, {
      name: 'Recall Desk', email: DESK.email, role: 'receptionist', password: DESK.password,
    });
    await suite.api('POST', '/api/users', adminToken, {
      name: 'Other Desk', email: OTHER_DESK.email, role: 'receptionist', password: OTHER_DESK.password,
    });
    deskToken = await login(DESK);
    otherDeskToken = await login(OTHER_DESK);
    pastorToken = await login(PASTOR);
  });

  after(async () => {
    await suite.stop();
  });

  it('the front desk sees what it sent to the pastor, and can recall it', async () => {
    const sent = await suite.api('POST', '/api/messages', deskToken, {
      recipientRole: 'pastor', category: 'general', subject: 'Wrong choir', body: 'Disregard this.',
    });
    assert.equal(sent.status, 201, sent.text);
    const id = sent.json.id;

    // The pastor sees it, and it is unread: the state a recall has to reverse.
    const before = await feedFor(pastorToken);
    assert.ok(before.broadcasts.some((b) => b.id === id));
    assert.ok((await unreadFor(pastorToken)).unread >= 1);

    // The sender can find it without opening the database.
    const listed = await sentFor(deskToken);
    const mine = listed.find((m) => m.id === id);
    assert.ok(mine, 'the sent list must show the message just sent');
    assert.equal(mine.recalled, false);
    assert.equal(mine.canRecall, true);
    assert.equal(mine.sender_id !== undefined, true, 'the row must name its sender so the UI can gate the action');

    const recalled = await suite.api('POST', `/api/messages/${id}/recall`, deskToken);
    assert.equal(recalled.status, 200, recalled.text);
    assert.equal(recalled.json.alreadyRecalled, false);

    // Gone from the pastor's feed and from the badge...
    const after = await feedFor(pastorToken);
    assert.ok(!after.broadcasts.some((b) => b.id === id), 'a recalled message must leave the feed');
    const unread = await unreadFor(pastorToken);
    assert.equal(unread.unread, 0, 'a recalled message is unread for nobody');
    assert.equal(unread.total, 0);

    // ...but not from the record: the row survives, stamped, for the audit trail.
    const row = await suite.get('SELECT * FROM messages WHERE id = ?', [id]);
    assert.ok(row, 'recalling must not delete the row');
    assert.ok(row.recalled_at);
    assert.equal(row.recalled_by, (await suite.get('SELECT id FROM users WHERE email = ?', [DESK.email])).id);
    const audit = await suite.get("SELECT * FROM audit_log WHERE action = 'message_recalled' AND record_id = ?", [id]);
    assert.ok(audit, 'a recall must be auditable');

    // The sender keeps the withdrawn message, clearly marked as such.
    const afterList = await sentFor(deskToken);
    const stillThere = afterList.find((m) => m.id === id);
    assert.ok(stillThere, 'the sender must still be able to see what was withdrawn');
    assert.equal(stillThere.recalled, true);
    assert.equal(stillThere.canRecall, false);
    assert.equal(stillThere.body, 'Disregard this.');
  });

  it('recalling twice is not an error and writes no second audit entry', async () => {
    const sent = await suite.api('POST', '/api/messages', deskToken, {
      recipientRole: 'pastor', category: 'general', subject: 'Twice', body: 'oops',
    });
    const id = sent.json.id;
    assert.equal((await suite.api('POST', `/api/messages/${id}/recall`, deskToken)).status, 200);
    const again = await suite.api('POST', `/api/messages/${id}/recall`, deskToken);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.alreadyRecalled, true);
    const rows = await suite.all("SELECT * FROM audit_log WHERE action = 'message_recalled' AND record_id = ?", [id]);
    assert.equal(rows.length, 1, 'the log counts withdrawals, not clicks');
  });

  it('refuses a receptionist recalling a colleague\'s message, but allows an admin', async () => {
    const sent = await suite.api('POST', '/api/messages', deskToken, {
      recipientRole: 'pastor', category: 'general', subject: 'Not yours', body: 'held',
    });
    const id = sent.json.id;

    const refused = await suite.api('POST', `/api/messages/${id}/recall`, otherDeskToken);
    assert.equal(refused.status, 403, refused.text);
    // The caller gets the catalog's sentence, never a raw key.
    assert.equal(refused.json.error, 'Only the person who sent a message, or an admin, can recall it.');
    assert.equal((await suite.get('SELECT recalled_at FROM messages WHERE id = ?', [id])).recalled_at, null);

    // The second desk cannot even see it: /sent is sender-scoped for the desk.
    const otherList = await sentFor(otherDeskToken);
    assert.ok(!otherList.some((m) => m.id === id), 'one desk must not read the other\'s sends');

    // An admin cleaning up after the front desk may recall it.
    const byAdmin = await suite.api('POST', `/api/messages/${id}/recall`, adminToken);
    assert.equal(byAdmin.status, 200, byAdmin.text);
    const audit = await suite.get("SELECT * FROM audit_log WHERE action = 'message_recalled' AND record_id = ?", [id]);
    assert.match(audit.details, /"byAdmin":true/, 'the log must say the sender was not the one who withdrew it');
  });

  it('an admin\'s sent view covers every send, the desk\'s only its own', async () => {
    const sent = await suite.api('POST', '/api/messages', otherDeskToken, {
      recipientRole: 'pastor', category: 'general', subject: 'From the other desk', body: 'hi',
    });
    const adminList = await sentFor(adminToken);
    assert.ok(adminList.some((m) => m.id === sent.json.id), 'an admin sees every send to the pastor');
    const deskList = await sentFor(deskToken);
    assert.ok(!deskList.some((m) => m.id === sent.json.id));
  });

  it('unknown message, and the sent view, are not open to everyone', async () => {
    const missing = await suite.api('POST', '/api/messages/999999/recall', deskToken);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, 'Message not found.');

    const pastorSent = await suite.api('GET', '/api/messages/sent', pastorToken);
    assert.equal(pastorSent.status, 403, 'the pastor has nothing to recall');
  });

  it('a recalled direct reply leaves the thread for both sides', async () => {
    const me = await suite.get('SELECT id FROM users WHERE email = ?', [PASTOR.email]);
    const sent = await suite.api('POST', '/api/messages', deskToken, {
      recipientId: me.id, category: 'general', subject: 'Re: something', body: 'sent in the wrong thread',
    });
    assert.equal(sent.status, 201, sent.text);
    const id = sent.json.id;
    const key = sent.json.threadKey;

    const deskThread = await suite.api('GET', `/api/messages/${key}`, deskToken);
    assert.ok(deskThread.json.messages.some((m) => m.id === id));

    assert.equal((await suite.api('POST', `/api/messages/${id}/recall`, deskToken)).status, 200);

    const after = await suite.api('GET', `/api/messages/${key}`, deskToken);
    assert.ok(!after.json.messages.some((m) => m.id === id), 'a withdrawn reply must leave the thread');
    const pastorThread = await suite.api('GET', `/api/messages/${key}`, pastorToken);
    assert.ok(!pastorThread.json.messages.some((m) => m.id === id));
  });

  it.skip('recalling a group update withdraws its in-app announcement too', async () => {
    const group = await suite.get('SELECT id, name FROM "groups" ORDER BY id LIMIT 1');
    // The update reports a change, so there has to be one: a send with nothing to
    // say writes no message, and so has nothing to recall.
    const joined = await suite.api('POST', '/api/members', deskToken, {
      name: 'Recall Member', groupIds: [group.id],
    });
    assert.equal(joined.status, 201, joined.text);
    const sentRes = await suite.api('POST', `/api/groups/${group.id}/notify-pastor`, deskToken);
    assert.equal(sentRes.status, 200, sentRes.text);
    assert.equal(sentRes.json.sent, true);

    // The message this wrote, and the announcement tied to it.
    const message = await suite.get(
      "SELECT * FROM messages WHERE recipient_role = 'pastor' AND subject = ? AND recalled_at IS NULL ORDER BY id DESC LIMIT 1",
      [`Group update: ${group.name}`]
    );
    assert.ok(message);
    const twin = await suite.get("SELECT * FROM notifications_log WHERE channel = 'in_app' AND message_id = ?", [message.id]);
    assert.ok(twin, 'the announcement must name the message it announces, or a recall cannot reach it');

    const beforeFeed = await feedFor(pastorToken);
    assert.ok(beforeFeed.broadcasts.some((b) => b.id === message.id));
    const beforeFeedNotes = await notificationsFor(pastorToken);
    assert.ok(beforeFeedNotes.some((n) => n.id === twin.id));

    assert.equal((await suite.api('POST', `/api/messages/${message.id}/recall`, deskToken)).status, 200);

    const afterFeed = await feedFor(pastorToken);
    assert.ok(!afterFeed.broadcasts.some((b) => b.id === message.id), 'the update must leave the feed');
    const afterNotes = await notificationsFor(pastorToken);
    assert.ok(!afterNotes.some((n) => n.id === twin.id), 'its announcement must leave the notification list with it');
    assert.equal((await unreadFor(pastorToken)).notifications, 0);
  });

  it('recalling a digest withdraws the summary announcement as well', async () => {
    await suite.api('POST', '/api/offerings', deskToken, { serviceTypeId: 1, category: 'general', amount: 3100 });
    const digest = await suite.api('POST', '/api/notifications/send-summary', deskToken);
    assert.equal(digest.status, 200, digest.text);
    assert.equal(digest.json.sent, true, 'the digest needs a pending record to exist');
    const messageId = digest.json.messageId;

    const twin = await suite.get("SELECT * FROM notifications_log WHERE channel = 'in_app' AND message_id = ?", [messageId]);
    assert.ok(twin, 'the summary announcement must name the digest message it announces');
    assert.ok((await notificationsFor(pastorToken)).some((n) => n.id === twin.id));

    assert.equal((await suite.api('POST', `/api/messages/${messageId}/recall`, deskToken)).status, 200);

    assert.ok(!(await notificationsFor(pastorToken)).some((n) => n.id === twin.id));
    assert.ok(!(await feedFor(pastorToken)).broadcasts.some((b) => b.id === messageId));
    // The offering itself is untouched: a recall withdraws the message, nothing else.
    const offering = await suite.get('SELECT amount FROM offerings ORDER BY id DESC LIMIT 1');
    assert.equal(offering.amount, 3100);
  });
});
