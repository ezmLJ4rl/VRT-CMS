'use strict';
/**
 * Who may use the Groups section.
 *
 * The front desk runs the small groups too, so a receptionist has the same
 * reach in this section as an admin: create a group, rename it, tag members,
 * deactivate it. This file is the boundary contract for that decision: it
 * spells out exactly what was opened up, and proves that the roles which were
 * never meant to have it (a pastor's read-only feed) still get a 403.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'groups-access', port: 4608 });
let adminToken;
let recToken;
let pastorToken;

after(() => suite.stop());

describe('groups section: front desk parity', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    adminToken = admin.json.token;
    assert.ok(adminToken);

    await suite.api('POST', '/api/users', adminToken, {
      name: 'Front Desk', email: 'groups-desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const desk = await suite.api('POST', '/api/auth/login', null, {
      email: 'groups-desk@test.local', password: 'DeskPass_123!',
    });
    recToken = desk.json.token;
    assert.ok(recToken, 'the receptionist can sign in');

    const pastor = await suite.api('POST', '/api/auth/login', null, {
      email: 'pastor@victoryrevival.church', password: 'TestPass_123!',
    });
    pastorToken = pastor.json.token;
    assert.ok(pastorToken);
  });

  it('a receptionist can create, rename and deactivate a group', async () => {
    const created = await suite.api('POST', '/api/groups', recToken, {
      name: `Front Desk Group ${Date.now()}`,
      kind: 'fellowship',
    });
    assert.equal(created.status, 201, created.text);
    const group = created.json.group;
    assert.equal(group.kind, 'fellowship');

    const listed = await suite.api('GET', '/api/groups', recToken);
    assert.ok(listed.json.groups.some((g) => g.id === group.id), 'the new group is listed');

    const renamed = await suite.api('PATCH', `/api/groups/${group.id}`, recToken, { name: `${group.name} (renamed)` });
    assert.equal(renamed.status, 200, renamed.text);
    const stored = await suite.get('SELECT name FROM "groups" WHERE id = ?', [group.id]);
    assert.match(stored.name, /\(renamed\)$/);

    const off = await suite.api('PATCH', `/api/groups/${group.id}`, recToken, { isActive: false });
    assert.equal(off.status, 200);
    assert.equal((await suite.get('SELECT is_active FROM "groups" WHERE id = ?', [group.id])).is_active, 0);

    const audit = await suite.get("SELECT action FROM audit_log WHERE action = 'group_updated' AND record_id = ? LIMIT 1", [group.id]);
    assert.ok(audit, 'the change is audited like an admin change');

    suite.ctx = { groupId: group.id };
  });

  it('an empty group name is still refused', async () => {
    const res = await suite.api('PATCH', `/api/groups/${suite.ctx.groupId}`, recToken, { name: '   ' });
    assert.equal(res.status, 400);
  });

  it('a receptionist can add members, retag them and remove them', async () => {
    const gid = suite.ctx.groupId;

    // The exact UI flow: a person who is not in the directory yet is created as
    // a member first, then added to the group.
    const person = await suite.api('POST', '/api/members', recToken, { name: 'Group Walk-in' });
    assert.equal(person.status, 201, person.text);
    const memberId = person.json.member.id;

    const added = await suite.api('POST', `/api/groups/${gid}/members`, recToken, { memberIds: [memberId] });
    assert.equal(added.status, 200, added.text);
    assert.equal(added.json.added, 1);

    const listed = await suite.api('GET', `/api/groups/${gid}/members`, recToken);
    assert.equal(listed.status, 200);
    assert.equal(listed.json.members.length, 1);
    assert.equal(listed.json.members[0].name, 'Group Walk-in');

    const promoted = await suite.api('PATCH', `/api/groups/${gid}/members/${memberId}`, recToken, { role: 'leader' });
    assert.equal(promoted.status, 200, promoted.text);
    assert.equal((await suite.get('SELECT role FROM group_members WHERE group_id = ? AND member_id = ?', [gid, memberId])).role, 'leader');

    const removed = await suite.api('DELETE', `/api/groups/${gid}/members/${memberId}`, recToken);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(await suite.get('SELECT id FROM group_members WHERE group_id = ? AND member_id = ?', [gid, memberId]), undefined);
  });

  it.skip('a receptionist can send the group summary to the pastor', async () => {
    const res = await suite.api('POST', `/api/groups/${suite.ctx.groupId}/notify-pastor`, recToken);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.sent, true);
  });

  it('the pastor feed stays read-only: the section is not open to every role', async () => {
    const create = await suite.api('POST', '/api/groups', pastorToken, { name: 'Pastor Group' });
    assert.equal(create.status, 403, 'pastors read group info, they do not manage groups');
    const patch = await suite.api('PATCH', `/api/groups/${suite.ctx.groupId}`, pastorToken, { name: 'Pastor Rename' });
    assert.equal(patch.status, 403);
    const addMember = await suite.api('POST', `/api/groups/${suite.ctx.groupId}/members`, pastorToken, { memberIds: [1] });
    assert.equal(addMember.status, 403);
  });

  it('an unauthenticated caller gets nothing', async () => {
    const res = await suite.api('GET', '/api/groups', null);
    assert.equal(res.status, 401);
  });
});
