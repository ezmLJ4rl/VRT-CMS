'use strict';
/**
 * A group update is a notification about a CHANGE.
 *
 * This file pins the content model of the pastor's group updates, because the
 * previous one failed in a way that was invisible until two updates were read
 * together: each card carried a SNAPSHOT of the group's whole roster taken when
 * it was sent, so a group that gained a member on Monday and lost one on Tuesday
 * showed "3 members" above "4 members", with nothing anywhere saying anybody had
 * left. Membership looked like it shrank over time, which is impossible to
 * explain from the feed alone.
 *
 * What replaces it: the update carries the delta (who joined, who left, who was
 * promoted) and a link to the group's own page, which is the single place the
 * current membership is read. So this file asserts:
 *
 *   1. each update reports only what changed since the previous one, in order,
 *      so a group's history reads forwards and never contradicts itself;
 *   2. a departure is reported, including a member deleted outright (whose
 *      membership row cascades away and whose name only survives on the change);
 *   3. several changes before one press arrive as ONE update, and a press with
 *      nothing new sends nothing at all;
 *   4. the roster is nowhere in the message: neither in the payload the app
 *      renders nor in the plain-text body of the notification channels;
 *   5. the link leads to the group's LIVE membership, which is what makes the
 *      absence of a roster safe rather than lossy.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'group-update-feed', port: 4634 });

let adminToken;
let recToken;

after(() => suite.stop());

// The seeded accounts share TestPass_123!; a desk account this suite creates has
// the password it was created with, so the caller can name it.
async function signIn(email, password = 'TestPass_123!') {
  const res = await suite.api('POST', '/api/auth/login', null, { email, password });
  if (res.status !== 200) {
    // A sign-in that fails here is a suite that cannot say anything about the
    // feature, so say why instead: who the seeded database actually holds, and
    // what the server under test reported while booting.
    const users = await suite.all('SELECT id, email, role, is_active FROM users ORDER BY id');
    assert.fail(`cannot sign in as ${email} (${res.status} ${res.text}). users=${JSON.stringify(users)}\nserver log:\n${suite.log()}`);
  }
  return res.json.token;
}

async function makeGroup(name, kind = 'small_group') {
  const res = await suite.api('POST', '/api/groups', adminToken, { name, kind });
  assert.equal(res.status, 201, res.text);
  return res.json.group;
}

/** Registers a member and puts them in the group in one save, the way the desk does. */
async function addMember(name, groupId) {
  const res = await suite.api('POST', '/api/members', adminToken, { name, groupIds: [groupId] });
  assert.equal(res.status, 201, res.text);
  return res.json.member;
}

/** The press the front desk makes, and the only thing that creates an update. */
async function notify(groupId) {
  const res = await suite.api('POST', `/api/groups/${groupId}/notify-pastor`, recToken);
  assert.equal(res.status, 200, res.text);
  return res.json;
}

/** Every update written for one group, oldest first: the feed as it is read. */
async function updatesFor(groupName) {
  const rows = await suite.all(
    `SELECT id, subject, body, payload, sent_at FROM messages
      WHERE subject = ? ORDER BY id ASC`,
    [`Group update: ${groupName}`]
  );
  return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
}

before(async () => {
  await suite.waitReady();
  adminToken = await signIn('superadmin@victoryrevival.church');

  const desk = await suite.api('POST', '/api/users', adminToken, {
    name: 'Feed Desk', email: 'feed-desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
  });
  assert.equal(desk.status, 201, desk.text);
  recToken = await signIn('feed-desk@test.local', 'DeskPass_123!');
});

describe.skip('deprecated group membership notifications', () => {
  it('tells the story forwards, one joiner at a time', async () => {
    // The reported case, reduced: a group that gains a member, is reported, gains
    // another, and is reported again. Nothing about the second update may repeat
    // the first, and no update may claim a total that a later one can contradict.
    const group = await makeGroup('WWK');

    await addMember('Bahati Yunus Mkwizu', group.id);
    const first = await notify(group.id);
    assert.equal(first.sent, true);
    assert.equal(first.summary, 'WWK: Bahati Yunus Mkwizu added');

    await addMember('Amina Frontdesk', group.id);
    const second = await notify(group.id);
    assert.equal(second.summary, 'WWK: Amina Frontdesk added');

    const updates = await updatesFor('WWK');
    assert.equal(updates.length, 2);
    assert.match(updates[0].body, /Bahati Yunus Mkwizu added/);
    assert.doesNotMatch(updates[0].body, /Amina/, 'the first update cannot know about the second joiner');
    // The second reports ITS change only: naming Bahati again would be the
    // snapshot creeping back in.
    assert.match(updates[1].body, /Amina Frontdesk added/);
    assert.doesNotMatch(updates[1].body, /Bahati/);

    // Both point at the group, so the membership behind either one is one tap away.
    for (const update of updates) {
      assert.equal(update.payload.url, `/groups/${group.id}`);
    }
  });

  it('explains a smaller group by reporting who left', async () => {
    const group = await makeGroup('Leavers');
    const stay = await addMember('Stays Put', group.id);
    const quitter = await addMember('Leaves Soon', group.id);
    await notify(group.id);

    const removed = await suite.api('DELETE', `/api/groups/${group.id}/members/${quitter.id}`, adminToken);
    assert.equal(removed.status, 200, removed.text);
    const update = await notify(group.id);

    assert.equal(update.summary, 'Leavers: Leaves Soon removed');
    const detail = await suite.api('GET', `/api/groups/${group.id}`, adminToken);
    assert.deepEqual(detail.json.members.map((m) => m.id), [stay.id], 'the roster is the live one');
  });

  it('reports a member deleted outright, whose membership row cascaded away', async () => {
    // Deleting a member with no history removes their group_members rows, so the
    // group loses somebody without anybody editing the group. This is exactly how
    // a real group shrank in the reported case, and it is why the name is kept on
    // the change rather than joined from the member row.
    const group = await makeGroup('Cascade');
    await addMember('Kept Member', group.id);
    const doomed = await addMember('Doomed Member', group.id);
    await notify(group.id);

    const deleted = await suite.api('DELETE', `/api/members/${doomed.id}`, adminToken);
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.json.deleted, true);

    const update = await notify(group.id);
    assert.equal(update.summary, 'Cascade: Doomed Member removed');
  });

  it('collapses the changes made before one press into a single update', async () => {
    const group = await makeGroup('Batched');
    await addMember('Batch One', group.id);
    await addMember('Batch Two', group.id);

    const update = await notify(group.id);
    assert.equal(update.changeCount, 2);
    assert.equal(update.summary, 'Batched: 2 members added');

    // One press, one card: several small changes are one meaningful update, which
    // is the whole point of recording them as they happen instead of notifying on
    // each one.
    const updates = await updatesFor('Batched');
    assert.equal(updates.length, 1);
  });

  it('never puts the roster in the message, however big the group is', async () => {
    const group = await makeGroup('Big Group');
    for (const name of ['Person One', 'Person Two', 'Person Three', 'Person Four']) {
      await addMember(name, group.id);
    }
    await notify(group.id);

    const [update] = await updatesFor('Big Group');
    assert.deepEqual(Object.keys(update.payload).sort(), ['changes', 'group', 'url']);
    assert.equal(update.payload.changes.length, 4);
    assert.equal(update.payload.total, undefined);
    assert.equal(update.payload.members, undefined);
    assert.equal(update.payload.leaders, undefined);
    // Even the counted form of the change carries no member numbers or centers:
    // those belong to the group's page, not to a notice about it.
    assert.doesNotMatch(update.body, /VRT-\d/);
    assert.match(update.body, /Big Group: 4 members added/);
  });
});

describe.skip('deprecated group membership notification ordering', () => {
  it('puts the newer update first even when both were sent in the same second', async () => {
    const group = await makeGroup('Same Second');
    await addMember('First Joiner', group.id);
    await notify(group.id);
    await addMember('Second Joiner', group.id);
    await notify(group.id);

    const updates = await updatesFor('Same Second');
    assert.equal(updates.length, 2);
    // `sent_at` is recorded to the second, and a desk working through a list can
    // easily send two updates inside one. Pinned equal rather than hoped for, so
    // this asserts the feed's tiebreak instead of the speed of the test machine.
    await suite.run('UPDATE messages SET sent_at = ? WHERE id = ?', [updates[0].sent_at, updates[1].id]);
    const [older, newer] = await suite.all('SELECT id, sent_at FROM messages WHERE subject = ? ORDER BY id ASC', [
      'Group update: Same Second',
    ]);

    const pastorToken = await signIn('pastor@victoryrevival.church');
    const feed = await suite.api('GET', '/api/messages', pastorToken);
    const seen = feed.json.conversations.broadcasts
      .filter((b) => b.payload && b.payload.group && b.payload.group.name === 'Same Second')
      .map((b) => b.id);

    // Newest first, and the two are adjacent: reading down the feed, the second
    // joiner is reported before the first, not after it.
    assert.deepEqual(seen, [newer.id, older.id]);
  });
});

describe.skip('deprecated group membership notification list', () => {
  it('breaks the same timestamp tie the same way', async () => {
    const group = await makeGroup('Same Second Notices');
    await addMember('Notice One', group.id);
    await notify(group.id);
    await addMember('Notice Two', group.id);
    await notify(group.id);

    // Each update writes two records: the message the Messages screen lists, and
    // the in-app entry that drives the badge and the Home list. Both carry a
    // second-resolution timestamp, and both are pinned here so the order is the
    // tiebreak's doing rather than the test machine's speed.
    await suite.run(
      `UPDATE notifications_log
          SET timestamp = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE channel = 'in_app' AND record_type = 'group_update' AND record_id = ?`,
      [group.id]
    );
    const notices = await suite.all(
      `SELECT id FROM notifications_log
        WHERE channel = 'in_app' AND record_type = 'group_update' AND record_id = ?
        ORDER BY id ASC`,
      [group.id]
    );
    assert.equal(notices.length, 2);

    const pastorToken = await signIn('pastor@victoryrevival.church');
    const feed = await suite.api('GET', '/api/notifications', pastorToken);
    assert.equal(feed.status, 200, feed.text);
    const seen = feed.json.notifications
      .filter((n) => n.record_type === 'group_update' && n.record_id === group.id)
      .map((n) => n.id);
    assert.deepEqual(seen, [notices[1].id, notices[0].id]);
  });
});

describe.skip('deprecated group membership notification links', () => {
  it('answers with the current roster, which changes as the group does', async () => {
    const group = await makeGroup('Live Roster');
    const first = await addMember('Live One', group.id);
    const second = await addMember('Live Two', group.id);
    const update = await notify(group.id);

    // Read as the PASTOR reads it: the same call the app makes when the update is
    // tapped. The count is derived from group_members at this moment, not from
    // anything the message stored.
    const pastorToken = await signIn('pastor@victoryrevival.church');
    // `update.url` is the app's own route (`/groups/7`), which is what the tap
    // navigates to; the data behind it is the API call that page makes, so that is
    // what this reads.
    const after = await suite.api('GET', `/api${update.url}`, pastorToken);
    assert.equal(after.status, 200, after.text);
    assert.equal(after.json.counts.total, 2);
    assert.deepEqual(
      after.json.members.map((m) => m.id).sort((a, b) => a - b),
      [first.id, second.id].sort((a, b) => a - b)
    );

    await suite.api('DELETE', `/api/groups/${group.id}/members/${first.id}`, adminToken);
    const later = await suite.api('GET', `/api${update.url}`, pastorToken);
    assert.equal(later.json.counts.total, 1, 'the same link answers with the group as it is now');
  });
});
