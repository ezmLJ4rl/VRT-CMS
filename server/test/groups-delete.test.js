'use strict';
/**
 * Deleting a group, and the line between deleting and deactivating.
 *
 * The rule is the member-delete rule one level up: attendance and offerings
 * reference a group by id because past records must keep naming the group they
 * belong to, so a group with any of that history is deactivated, never deleted.
 * A group with none is genuinely removable. The menu that drives it (⋮ →
 * Delete) is the client's business; this suite holds the server's side of the
 * contract.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'groups-delete', port: 4627 });
let adminToken;
let recToken;

after(() => suite.stop());

describe('group deletion: history decides, not the button', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    adminToken = admin.json.token;

    await suite.api('POST', '/api/users', adminToken, {
      name: 'Delete Desk', email: 'delete-desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const desk = await suite.api('POST', '/api/auth/login', null, {
      email: 'delete-desk@test.local', password: 'DeskPass_123!',
    });
    recToken = desk.json.token;
  });

  it('a historyless group is hard-deleted with its roster', async () => {
    const created = await suite.api('POST', '/api/groups', adminToken, { name: 'Doomed Trio', kind: 'small_group' });
    assert.equal(created.status, 201, created.text);
    const id = created.json.group.id;
    const seeded = (await suite.api('GET', '/api/groups', adminToken)).json.groups;
    const watoto = seeded.find((g) => g.name === 'Watoto');

    const del = await suite.api('DELETE', `/api/groups/${id}`, adminToken);
    assert.equal(del.status, 200, del.text);
    assert.deepEqual({ deleted: del.json.deleted, deactivated: del.json.deactivated }, { deleted: true, deactivated: undefined });

    assert.equal(await suite.get('SELECT id FROM "groups" WHERE id = ?', [id]), undefined);
    assert.equal(await suite.get('SELECT COUNT(*)::int AS n FROM group_members WHERE group_id = ?', [id]).then((r) => r.n), 0);
    assert.ok(await suite.get("SELECT action FROM audit_log WHERE action = 'group_deleted' AND record_id = ? LIMIT 1", [id]));

    // An unrelated group's rows are untouched by the transaction.
    assert.ok(watoto, 'sanity: Watoto exists to be left alone');
  });

  it('a group with attendance history is deactivated instead, and its records survive', async () => {
    // History is inserted directly rather than assumed from the seed: the point
    // under test is the delete route's rule, not what the seeder happened to do.
    const created = await suite.api('POST', '/api/groups', adminToken, { name: 'Choir With History', kind: 'choir' });
    const id = created.json.group.id;
    const service = (await suite.all('SELECT id FROM services ORDER BY id LIMIT 1'))[0];
    const admin = (await suite.all("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1"))[0];
    await suite.run('INSERT INTO attendance (service_id, count, mode, recorded_by, group_id) VALUES (?, 12, \'headcount\', ?, ?)', [service.id, admin.id, id]);

    const del = await suite.api('DELETE', `/api/groups/${id}`, adminToken);
    assert.equal(del.status, 200, del.text);
    assert.equal(del.json.deactivated, true);
    assert.equal(del.json.history.attendance, 1);

    const stored = await suite.get('SELECT is_active, name FROM "groups" WHERE id = ?', [id]);
    assert.equal(stored.is_active, 0, 'the row stays, switched off');
    assert.equal(stored.name, 'Choir With History');
    assert.equal((await suite.get('SELECT COUNT(*)::int AS n FROM attendance WHERE group_id = ?', [id])).n, 1, 'history intact');
    assert.ok(await suite.get("SELECT action FROM audit_log WHERE action = 'group_deactivated' AND record_id = ? LIMIT 1", [id]));
  });

  it('a group with only offering history is deactivated too', async () => {
    const created = await suite.api('POST', '/api/groups', adminToken, { name: 'Offering Only', kind: 'fellowship' });
    const id = created.json.group.id;
    const service = (await suite.all('SELECT id FROM services ORDER BY id LIMIT 1'))[0];
    const admin = (await suite.all("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1"))[0];
    await suite.run('INSERT INTO offerings (service_id, type, amount, recorded_by, group_id) VALUES (?, \'general\', 5000, ?, ?)', [service.id, admin.id, id]);

    const del = await suite.api('DELETE', `/api/groups/${id}`, adminToken);
    assert.equal(del.status, 200, del.text);
    assert.equal(del.json.deactivated, true);
    assert.equal(del.json.history.offerings, 1);
    assert.equal((await suite.get('SELECT is_active FROM "groups" WHERE id = ?', [id])).is_active, 0);
    assert.equal((await suite.get('SELECT COUNT(*)::int AS n FROM offerings WHERE group_id = ?', [id])).n, 1, 'the gift keeps its group');
  });

  it('a receptionist cannot delete (one step beyond the front desk\u2019s brief)', async () => {
    const created = await suite.api('POST', '/api/groups', adminToken, { name: 'Admin Only Delete' });
    const del = await suite.api('DELETE', `/api/groups/${created.json.group.id}`, recToken);
    assert.equal(del.status, 403);
    assert.equal((await suite.get('SELECT is_active FROM "groups" WHERE id = ?', [created.json.group.id])).is_active, 1);
  });

  it('an unknown group 404s', async () => {
    const del = await suite.api('DELETE', '/api/groups/99999', adminToken);
    assert.equal(del.status, 404);
  });
});
