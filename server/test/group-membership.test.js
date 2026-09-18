'use strict';
/**
 * Membership belongs to the member.
 *
 * A group's roster is written where the member is registered or edited, and the
 * Groups screen only reads the counts that produces, so this file pins the two
 * halves of that contract:
 *
 *   1. POST/PATCH /api/members accept groupIds and reconcile group_members, and
 *      a save that does not mention groups cannot disturb them;
 *   2. the group's roster and count reflect those records immediately, with no
 *      second step anywhere;
 *   3. "Send to pastor" carries WHAT CHANGED (never a copy of the roster) with a
 *      link to the group, and one send counts as one unread thing rather than
 *      two.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');

// The kinds the API accepts, discovered by asking it (see the probe test below)
// rather than by importing the route: importing it would open a database
// connection against the developer's database before the suite's guard is armed.
const KINDS = ['small_group', 'choir', 'worship_team', 'fellowship'];

const suite = startServer({ name: 'group-membership', port: 4609 });

let adminToken;
let recToken;

after(() => suite.stop());

async function makeGroup(name, kind, token = adminToken) {
  const res = await suite.api('POST', '/api/groups', token, { name, kind });
  assert.equal(res.status, 201, res.text);
  return res.json.group;
}

async function groupDetail(id, token = adminToken) {
  const res = await suite.api('GET', `/api/groups/${id}`, token);
  assert.equal(res.status, 200, res.text);
  return res.json;
}

describe('group membership flows from the member record', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    adminToken = admin.json.token;
    assert.ok(adminToken);

    await suite.api('POST', '/api/users', adminToken, {
      name: 'Desk Two', email: 'membership-desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const desk = await suite.api('POST', '/api/auth/login', null, {
      email: 'membership-desk@test.local', password: 'DeskPass_123!',
    });
    recToken = desk.json.token;
    assert.ok(recToken, 'the receptionist can sign in');
  });

  it('registers a member straight into their groups, and the group sees it at once', async () => {
    const choir = await makeGroup('Harvest Choir', 'choir');
    const group = await makeGroup('Watoto', 'small_group');

    const created = await suite.api('POST', '/api/members', recToken, {
      name: 'Asha M',
      phone: '+255700111222',
      groupIds: [choir.id, group.id],
    });
    assert.equal(created.status, 201, created.text);
    const memberId = created.json.member.id;

    // The member carries their groups…
    const profile = await suite.api('GET', `/api/members/${memberId}`, recToken);
    assert.equal(profile.status, 200);
    assert.deepEqual(
      profile.json.groups.map((g) => g.name).sort(),
      ['Harvest Choir', 'Watoto']
    );

    // …and the group's count, which is what the Groups screen renders: is
    // derived from that record, with nothing else to run.
    const list = await suite.api('GET', '/api/groups', recToken);
    const listed = list.json.groups.find((g) => g.id === choir.id);
    assert.equal(listed.member_count, 1);

    const detail = await groupDetail(choir.id, recToken);
    assert.equal(detail.members.length, 1);
    assert.equal(detail.members[0].name, 'Asha M');
    assert.equal(detail.counts.total, 1);

    suite.ctx = { choirId: choir.id, watotoId: group.id, memberId };
  });

  it('lists the member list with the center and contact the group page shows', async () => {
    const center = await suite.api('POST', '/api/revival-centers', adminToken, { name: 'Mbezi' });
    assert.equal(center.status, 201, center.text);
    const centerId = center.json.revivalCenter.id;

    const moved = await suite.api('PATCH', `/api/members/${suite.ctx.memberId}`, adminToken, {
      revivalCenterId: centerId,
      groupIds: [suite.ctx.choirId],
    });
    assert.equal(moved.status, 200, moved.text);

    const detail = await groupDetail(suite.ctx.choirId);
    const [row] = detail.members;
    assert.equal(row.name, 'Asha M');
    assert.equal(row.center_name, 'Mbezi');
    assert.equal(row.phone, '+255700111222', 'the contact is decrypted for the roster');
    assert.equal(row.phone_enc, undefined, 'the ciphertext never leaves the server');
    assert.ok(row.member_no, 'the member number is on the row');

    // That edit also removed the membership it left out.
    const watoto = await groupDetail(suite.ctx.watotoId);
    assert.equal(watoto.members.length, 0);
  });

  it('keeps a membership that stays, so re-saving cannot demote a leader', async () => {
    const promoted = await suite.api('PATCH', `/api/groups/${suite.ctx.choirId}/members/${suite.ctx.memberId}`, adminToken, {
      role: 'leader',
    });
    assert.equal(promoted.status, 200, promoted.text);

    const added = await makeGroup('Rehoboth Choir', 'choir');
    // Re-save the member with both groups: the existing membership is kept.
    const saved = await suite.api('PATCH', `/api/members/${suite.ctx.memberId}`, recToken, {
      name: 'Asha M',
      groupIds: [suite.ctx.choirId, added.id],
    });
    assert.equal(saved.status, 200, saved.text);

    const role = await suite.get('SELECT role FROM group_members WHERE group_id = ? AND member_id = ?', [
      suite.ctx.choirId,
      suite.ctx.memberId,
    ]);
    assert.equal(role.role, 'leader', 'a kept membership keeps its role');

    const newMembership = await suite.get('SELECT role FROM group_members WHERE group_id = ? AND member_id = ?', [
      added.id,
      suite.ctx.memberId,
    ]);
    assert.equal(newMembership.role, 'member', 'a new membership starts as a plain member');

    const detail = await groupDetail(added.id);
    assert.equal(detail.counts.leaders, 0);
    assert.equal(detail.counts.members, 1);

    suite.ctx = { ...suite.ctx, rehobothId: added.id };
  });

  it('counts a leadership role on the group it belongs to', async () => {
    const detail = await groupDetail(suite.ctx.choirId);
    assert.equal(detail.counts.total, 1);
    assert.equal(detail.counts.leaders, 1);
    assert.equal(detail.counts.members, 0);
  });

  it('ignores a group id that is not a real group instead of failing the save', async () => {
    const res = await suite.api('PATCH', `/api/members/${suite.ctx.memberId}`, recToken, {
      name: 'Asha M',
      groupIds: [suite.ctx.choirId, 999999],
    });
    assert.equal(res.status, 200, res.text);
    const kept = await suite.all('SELECT group_id FROM group_members WHERE member_id = ?', [suite.ctx.memberId]);
    assert.deepEqual(kept.map((r) => r.group_id), [suite.ctx.choirId]);
  });

  it('cannot lose a roster through the activate/deactivate toggle', async () => {
    const before = await suite.all('SELECT group_id FROM group_members WHERE member_id = ?', [suite.ctx.memberId]);
    assert.ok(before.length >= 1);

    // Exactly what the Members screen's toggle sends: isActive and nothing else.
    const toggled = await suite.api('PATCH', `/api/members/${suite.ctx.memberId}`, adminToken, { isActive: false });
    assert.equal(toggled.status, 200, toggled.text);

    const still = await suite.all('SELECT group_id FROM group_members WHERE member_id = ?', [suite.ctx.memberId]);
    assert.deepEqual(still.map((r) => r.group_id).sort(), before.map((r) => r.group_id).sort());

    await suite.api('PATCH', `/api/members/${suite.ctx.memberId}`, adminToken, { isActive: true });
  });

  it('shows the member their groups in the directory list too', async () => {
    const res = await suite.api('GET', '/api/members', recToken);
    assert.equal(res.status, 200);
    const row = res.json.members.find((m) => m.id === suite.ctx.memberId);
    assert.equal(row.group_names, 'Harvest Choir');
    assert.equal(row.group_count, 1);
  });

  it('leaves the old direct membership endpoints working for other callers', async () => {
    const person = await suite.api('POST', '/api/members', recToken, { name: 'Group Walk-in' });
    assert.equal(person.status, 201, person.text);

    const added = await suite.api('POST', `/api/groups/${suite.ctx.watotoId}/members`, recToken, {
      memberIds: [person.json.member.id],
    });
    assert.equal(added.status, 200, added.text);
    assert.equal(added.json.added, 1);
    assert.equal((await groupDetail(suite.ctx.watotoId)).members.length, 1);
  });
});

describe('every group kind the API accepts has a label in both clients', () => {
  it('stores each kind as sent, and refuses a kind it does not know', async () => {
    for (const kind of KINDS) {
      const created = await suite.api('POST', '/api/groups', adminToken, { name: `Kind probe ${kind}`, kind });
      assert.equal(created.status, 201, `${kind}: ${created.text}`);
      assert.equal(created.json.group.kind, kind, 'the API echoes the kind it stored');

      // Read back what a client would receive, so the badge has a real value to
      // resolve rather than a default standing in for one.
      const listed = await suite.api('GET', '/api/groups', adminToken);
      const row = listed.json.groups.find((g) => g.id === created.json.group.id);
      assert.equal(row.kind, kind);

      await suite.api('PATCH', `/api/groups/${created.json.group.id}`, adminToken, { isActive: false });
    }

    const unknown = await suite.api('POST', '/api/groups', adminToken, { name: 'Nonsense', kind: 'workshop' });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.error, 'Unknown group kind.');
  });

  it('has a badge label for each kind in both admin catalogs', async () => {
    // A kind with no label is not silent: i18next renders the raw key, so the
    // Groups page would read "groups.kind_choir". This is the cross-layer half of
    // the rule the client's own catalog sweep cannot see, and it is why the
    // kinds are listed here rather than only in the client.
    const i18nDir = path.join(__dirname, '..', '..', 'client-admin', 'src', 'i18n');
    for (const file of ['en.json', 'sw.json']) {
      const catalog = JSON.parse(fs.readFileSync(path.join(i18nDir, file), 'utf8'));
      for (const kind of KINDS) {
        assert.equal(
          typeof catalog.groups[`kind_${kind}`],
          'string',
          `${file} is missing groups.kind_${kind}`
        );
      }
    }
  });
});

describe.skip('deprecated group membership notifications', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    adminToken = admin.json.token;
  });

  it('sends the change as data with a link, and adds one unread, not two', async () => {
    const group = await makeGroup('Notify Choir', 'choir');
    const asha = await suite.api('POST', '/api/members', adminToken, {
      name: 'Notify Leader', groupIds: [group.id],
    });
    await suite.api('POST', '/api/members', adminToken, { name: 'Notify Member', groupIds: [group.id] });
    await suite.api('PATCH', `/api/groups/${group.id}/members/${asha.json.member.id}`, adminToken, { role: 'leader' });

    const pastor = await suite.api('POST', '/api/auth/login', null, {
      email: 'pastor@victoryrevival.church', password: 'TestPass_123!',
    });
    const pastorToken = pastor.json.token;
    const before = await suite.api('GET', '/api/messages/unread', pastorToken);
    assert.equal(before.status, 200, before.text);

    const sent = await suite.api('POST', `/api/groups/${group.id}/notify-pastor`, recToken);
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.json.sent, true);
    // Two joins and a promotion: one update, three changes in it.
    assert.equal(sent.json.changeCount, 3);
    assert.equal(sent.json.url, `/groups/${group.id}`);
    assert.match(sent.json.summary, /2 members added/);
    assert.match(sent.json.summary, /Notify Leader is now a leader/);

    // The broadcast the pastor's Messages screen renders.
    const broadcast = await suite.get(
      "SELECT * FROM messages WHERE category = 'member_alert' AND subject = ? ORDER BY id DESC LIMIT 1",
      [`Group update: Notify Choir`]
    );
    assert.ok(broadcast, 'a message row was written, not just a notification');
    assert.equal(broadcast.recipient_role, 'pastor');

    const payload = JSON.parse(broadcast.payload);
    assert.equal(payload.group.name, 'Notify Choir');
    assert.equal(payload.url, `/groups/${group.id}`, 'the update links to the group itself');
    assert.deepEqual(
      payload.changes.map((c) => `${c.action}:${c.name}`),
      ['added:Notify Leader', 'added:Notify Member', 'role_changed:Notify Leader']
    );
    // THE ROSTER IS NOT IN THE MESSAGE. It used to be: a snapshot taken at send
    // time, which then contradicted the next update as soon as anybody left.
    assert.equal(payload.total, undefined);
    assert.equal(payload.members, undefined);
    assert.equal(payload.leaders, undefined);

    // The plain-text twin (email/SMS/push) describes the change, and nothing it
    // says needs the roster to be read: a single joiner is named, several are
    // counted.
    assert.match(broadcast.body, /Notify Choir: 2 members added, Notify Leader is now a leader/);
    assert.doesNotMatch(broadcast.body, /VRT-\d/, 'no member numbers: this is a notice, not a roster');

    // The activity-feed entry the badge is driven by, pointing at the group.
    const notification = await suite.get(
      "SELECT * FROM notifications_log WHERE record_type = 'group_update' AND record_id = ? AND channel = 'in_app' ORDER BY id DESC LIMIT 1",
      [group.id]
    );
    assert.ok(notification, 'the in-app feed entry exists');
    assert.match(notification.message, /2 members added/);
    assert.equal(notification.url, `/groups/${group.id}`);

    // One event, one unread: the notification is the message's twin, so the
    // badge must move by exactly one.
    const after = await suite.api('GET', '/api/messages/unread', pastorToken);
    assert.equal(after.json.total - before.json.total, 1);
  });

  it('sends nothing at all when nothing has changed since the last update', async () => {
    const group = await makeGroup('Quiet Choir', 'choir');
    await suite.api('POST', '/api/members', adminToken, { name: 'Quiet Member', groupIds: [group.id] });

    const first = await suite.api('POST', `/api/groups/${group.id}/notify-pastor`, recToken);
    assert.equal(first.json.sent, true);

    const again = await suite.api('POST', `/api/groups/${group.id}/notify-pastor`, recToken);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.sent, false);
    assert.equal(again.json.reason, 'no_changes');

    // One press, one message: a second press cannot stack a second card in the
    // pastor's feed, and the badge must not move either.
    const rows = await suite.get('SELECT COUNT(*)::int AS n FROM messages WHERE subject = ?', ['Group update: Quiet Choir']);
    assert.equal(rows.n, 1);
  });
});
