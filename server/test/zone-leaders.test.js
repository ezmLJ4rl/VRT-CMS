'use strict';
/**
 * Zone leadership: who holds an office in a zone, and what that office is.
 *
 * A zone is a place people are filed, and it has bearers of office: a deacon, a
 * treasurer, a secretary, or whatever this church calls the job. Three rules
 * carry the whole feature, and all three are here:
 *
 *   1. a leader must be a member OF THAT ZONE. With several roles in play it is
 *      easy to hand a job to somebody from the wrong zone, and the app must not
 *      let that through;
 *   2. a member holds ONE role per zone: two roles for one person would need
 *      the pair key relaxed, and until somebody asks for that, the app refuses;
 *   3. whoever leads a zone leads its CENTER. That is derived from these rows on
 *      every read, never a second list for an admin to keep in step.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'zone-leaders', port: 4625 });

let adminToken;
let deskToken;
let centerId;
let zoneA;
let zoneB;

after(() => suite.stop());

/** Registers a member through the real endpoint and returns the row it made. */
async function addMember(name, phone, zoneId = null) {
  const res = await suite.api('POST', '/api/members', deskToken, {
    name,
    phone,
    revivalCenterId: centerId,
    zoneId,
  });
  assert.equal(res.status, 201, res.text);
  return res.json.member;
}

/** The center as the centers screen sees it. */
async function centerFrom(token = adminToken) {
  const res = await suite.api('GET', '/api/revival-centers', token);
  assert.equal(res.status, 200, res.text);
  return res.json.revivalCenters.find((c) => c.id === centerId);
}

/** Sets one zone's leaders to exactly these entries: { memberId, roleName }. */
function setLeaders(zoneId, leaders, token = adminToken) {
  return suite.api('PATCH', `/api/revival-centers/zones/${zoneId}`, token, { leaders });
}

describe('zone leadership', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    adminToken = admin.json.token;
    assert.ok(adminToken);

    await suite.api('POST', '/api/users', adminToken, {
      name: 'Zone Desk', email: 'zone-leaders-desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const desk = await suite.api('POST', '/api/auth/login', null, {
      email: 'zone-leaders-desk@test.local', password: 'DeskPass_123!',
    });
    deskToken = desk.json.token;
    assert.ok(deskToken);

    const center = await suite.api('POST', '/api/revival-centers', adminToken, { name: 'Kimara' });
    centerId = center.json.revivalCenter.id;
    zoneA = (await suite.api('POST', `/api/revival-centers/${centerId}/zones`, adminToken, { name: 'Zone A' })).json.zone;
    zoneB = (await suite.api('POST', `/api/revival-centers/${centerId}/zones`, adminToken, { name: 'Zone B' })).json.zone;
  });

  it('reports a zone with nobody in office as having no leaders, not as missing', async () => {
    const center = await centerFrom();
    assert.deepEqual(center.zones.find((z) => z.id === zoneA.id).leaders, []);
    assert.deepEqual(center.leaders, [], 'a center with no zone leaders has no leaders');
  });

  it('records the office each leader holds', async () => {
    const deacon = await addMember('Elisha Shemasi', '+255700400001', zoneA.id);
    const treasurer = await addMember('Bahati Mweka', '+255700400002', zoneA.id);

    const res = await setLeaders(zoneA.id, [
      { memberId: deacon.id, roleName: 'Deacon' },
      { memberId: treasurer.id, roleName: 'Treasurer' },
    ]);
    assert.equal(res.status, 200, res.text);

    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    assert.deepEqual(
      zone.leaders.map((l) => `${l.role_name}: ${l.name}`).sort(),
      ['Deacon: Elisha Shemasi', 'Treasurer: Bahati Mweka']
    );
    const deaconRow = zone.leaders.find((l) => l.member_id === deacon.id);
    assert.equal(deaconRow.member_no, deacon.member_no, 'the member number comes with the name');
    assert.equal(deaconRow.is_active, 1);
  });

  it('rolls every zone leader up to the center, naming the zone they lead', async () => {
    const secretary = await addMember('Neema Katibu', '+255700400003', zoneB.id);
    const setB = await setLeaders(zoneB.id, [{ memberId: secretary.id, roleName: 'Secretary' }]);
    assert.equal(setB.status, 200, setB.text);

    // Nobody assigned a center leader: the center's list is the zones' leaders.
    const center = await centerFrom();
    assert.deepEqual(
      center.leaders.map((l) => `${l.role_name}: ${l.name} (${l.zone_name})`).sort(),
      ['Deacon: Elisha Shemasi (Zone A)', 'Secretary: Neema Katibu (Zone B)', 'Treasurer: Bahati Mweka (Zone A)']
    );
  });

  it('drops a person out of the center roll-up when they leave their zone', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const treasurer = zone.leaders.find((l) => l.role_name === 'Treasurer');

    // The set is the whole truth, so leaving somebody out removes their office.
    const res = await setLeaders(zoneA.id, [{ memberId: zone.leaders.find((l) => l.role_name === 'Deacon').member_id, roleName: 'Deacon' }]);
    assert.equal(res.status, 200, res.text);

    const center = await centerFrom();
    assert.equal(center.leaders.some((l) => l.member_id === treasurer.member_id), false);
    assert.equal(center.zones.find((z) => z.id === zoneA.id).leaders.length, 1);
  });

  it('refuses a leader who is not a member of that zone', async () => {
    const outsider = await addMember('Elia WaZoneB', '+255700400004', zoneB.id);

    const res = await setLeaders(zoneA.id, [{ memberId: outsider.id, roleName: 'Deacon' }]);
    assert.equal(res.status, 400, res.text);
    // The locale middleware translates outgoing keys, so this is the sentence the
    // admin actually reads, not the key behind it.
    assert.match(res.json.error, /not filed in this zone/);

    // And nothing changed: the standing leader is still the only one.
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    assert.deepEqual(zone.leaders.map((l) => l.role_name), ['Deacon']);
  });

  it('leaves a leader recorded before the rule alone, so the zone stays editable', async () => {
    // An office handed out before "leaders must be members of their zone" existed
    // can be out of step with it. Refusing the whole set because of one such row
    // would leave an admin unable to touch the zone at all, so it is preserved
    // and REPORTED: the client flags it and the admin removes it deliberately.
    const { rows: before } = await suite.query('SELECT member_id FROM center_zone_leaders WHERE zone_id = ?', [zoneB.id]);
    const legacy = await addMember('Elia WaZoneA', '+255700400012', zoneA.id);
    await suite.query('INSERT INTO center_zone_leaders (zone_id, member_id, role_name) VALUES (?, ?, ?)', [zoneB.id, legacy.id, 'Deacon']);

    const kept = await setLeaders(zoneB.id, [
      ...before.map((r) => ({ memberId: r.member_id })),
      { memberId: legacy.id, roleName: 'Deacon' },
    ]);
    assert.equal(kept.status, 200, kept.text);

    // It is still there, and the API says which zone its bearer actually belongs
    // to, so the app can show the admin what is wrong.
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneB.id);
    const flagged = zone.leaders.find((l) => l.member_id === legacy.id);
    assert.equal(flagged.zone_id, zoneB.id, 'it still leads the zone it was given');
    assert.equal(flagged.member_zone_id, zoneA.id, 'but the API says where the bearer is filed');

    // Removing it is how the admin fixes it.
    const fixed = await setLeaders(zoneB.id, before.map((r) => ({ memberId: r.member_id })));
    assert.equal(fixed.status, 200, fixed.text);
    const after = (await centerFrom()).zones.find((z) => z.id === zoneB.id);
    assert.equal(after.leaders.some((l) => l.member_id === legacy.id), false);
  });

  it('refuses to move a member out of the zone they lead, naming the office', async () => {
    // The invariant has two doors. Assignment is guarded, but a member edit that
    // changes a filing would strand the office in a zone its bearer no longer
    // belongs to: the same bug arriving by the other door.
    const { rows: standing } = await suite.query('SELECT member_id, role_name FROM center_zone_leaders WHERE zone_id = ?', [zoneA.id]);
    const deacon = await addMember('Zoe Deacon', '+255700400013', zoneA.id);
    const set = await setLeaders(zoneA.id, [
      ...standing.map((r) => ({ memberId: r.member_id, roleName: r.role_name })),
      { memberId: deacon.id, roleName: 'Deacon' },
    ]);
    assert.equal(set.status, 200, set.text);
    try {
      const moved = await suite.api('PATCH', `/api/members/${deacon.id}`, adminToken, { zoneId: zoneB.id });
      assert.equal(moved.status, 400, moved.text);
      assert.match(moved.json.error, /Zone A/, 'the office is named so the admin knows what to remove');
      assert.match(moved.json.error, /Kimara/, 'and so is the center');
      assert.equal(moved.json.params, undefined, 'the placeholders were filled, not echoed back');
      // Every placeholder was substituted: a stray {zone} would read as a bug to
      // the admin, and this message is the only thing telling them what to undo.
      assert.equal(/\{[a-z]+\}/.test(moved.json.error), false, moved.json.error);

      // Nothing moved, and the office is intact.
      const { rows: after } = await suite.query('SELECT zone_id FROM members WHERE id = ?', [deacon.id]);
      assert.equal(after[0].zone_id, zoneA.id);
      const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
      assert.ok(zone.leaders.some((l) => l.member_id === deacon.id), 'the office survives the refused move');

      // Unfiling them is the same move: an office in a zone they are not in.
      const unfiled = await suite.api('PATCH', `/api/members/${deacon.id}`, adminToken, { zoneId: null });
      assert.equal(unfiled.status, 400, unfiled.text);

      // An unrelated edit: a new phone number: is not a move and goes through.
      const renamed = await suite.api('PATCH', `/api/members/${deacon.id}`, adminToken, { phone: '+255700400014' });
      assert.equal(renamed.status, 200, renamed.text);

      // Give up the office and the move goes through.
      assert.equal((await setLeaders(zoneA.id, standing.map((r) => ({ memberId: r.member_id, roleName: r.role_name })))).status, 200);
      const freed = await suite.api('PATCH', `/api/members/${deacon.id}`, adminToken, { zoneId: zoneB.id });
      assert.equal(freed.status, 200, freed.text);
      assert.equal(freed.json.member.zone_id, zoneB.id);
    } finally {
      await setLeaders(zoneA.id, standing.map((r) => ({ memberId: r.member_id, roleName: r.role_name })));
      await suite.api('PATCH', `/api/members/${deacon.id}`, adminToken, { zoneId: zoneA.id });
    }
  });

  it('refuses a member with no zone at all as a zone leader', async () => {
    const loose = await addMember('Baraka BilaEneo', '+255700400005');
    const res = await setLeaders(zoneB.id, [{ memberId: loose.id, roleName: 'Deacon' }]);
    assert.equal(res.status, 400, res.text);
  });

  it('refuses two roles for the same member in the same zone', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const deacon = zone.leaders[0];

    const res = await setLeaders(zoneA.id, [
      { memberId: deacon.member_id, roleName: 'Deacon' },
      { memberId: deacon.member_id, roleName: 'Treasurer' },
    ]);
    assert.equal(res.status, 400, res.text);
    assert.match(res.json.error, /already holds a role/);
  });

  it('lets the same person hold a role in the zone they are filed in', async () => {
    // One role per member PER ZONE. Moving somebody into a zone is a separate
    // screen; what matters here is that their own zone accepts them.
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const deacon = zone.leaders[0];
    const res = await suite.api('PATCH', `/api/revival-centers/zones/${zoneA.id}`, adminToken, {
      leaders: [{ memberId: deacon.member_id, roleName: 'Deacon' }],
    });
    assert.equal(res.status, 200, res.text);
  });

  it('keeps the roles already recorded when only the set moves', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const deacon = zone.leaders[0];
    const second = await addMember('Asha Msaidizi', '+255700400006', zoneA.id);
    await setLeaders(zoneA.id, [
      { memberId: deacon.member_id, roleName: 'Deacon' },
      { memberId: second.id, roleName: 'Secretary' },
    ]);

    // Now a caller that knows the members but not the roles: the roles survive.
    const res = await suite.api('PATCH', `/api/revival-centers/zones/${zoneA.id}`, adminToken, {
      leaders: [{ memberId: deacon.member_id }, { memberId: second.id }],
    });
    assert.equal(res.status, 200, res.text);

    const after = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    assert.deepEqual(after.leaders.map((l) => l.role_name).sort(), ['Deacon', 'Secretary']);
  });

  it('changes an office by naming the same person with a new role', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const deacon = zone.leaders.find((l) => l.role_name === 'Deacon');
    const others = zone.leaders.filter((l) => l.member_id !== deacon.member_id);

    const res = await setLeaders(zoneA.id, [
      ...others.map((l) => ({ memberId: l.member_id, roleName: l.role_name })),
      { memberId: deacon.member_id, roleName: 'Treasurer' },
    ]);
    assert.equal(res.status, 200, res.text);

    const after = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const moved = after.leaders.find((l) => l.member_id === deacon.member_id);
    assert.equal(moved.role_name, 'Treasurer');
    assert.equal(after.leaders.filter((l) => l.role_name === 'Deacon').length, 0);
  });

  it('takes a free-text role with no code change', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const person = await addMember('Ruth Mwangalizi', '+255700400007', zoneA.id);
    const res = await setLeaders(zoneA.id, [
      ...zone.leaders.map((l) => ({ memberId: l.member_id, roleName: l.role_name })),
      { memberId: person.id, roleName: 'Youth coordinator' },
    ]);
    assert.equal(res.status, 200, res.text);

    const after = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    assert.ok(after.leaders.some((l) => l.role_name === 'Youth coordinator'));
  });

  it('keeps a member who no longer holds an office named as a plain leader', async () => {
    // Rows written before roles existed carry ''. The app renders that as a plain
    // Leader instead of inventing a job for somebody.
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const person = await addMember('Zawadi WaAwali', '+255700400008', zoneA.id);
    await setLeaders(zoneA.id, [{ memberId: person.id }]);

    const after = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    assert.equal(after.leaders[0].role_name, '');
    assert.equal(after.leaders[0].name, 'Zawadi WaAwali');
  });

  it('refuses a role name long enough to be a note, and a payload that is not a list', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const person = zone.leaders[0];

    const tooLong = await setLeaders(zoneA.id, [{ memberId: person.member_id, roleName: 'x'.repeat(61) }]);
    assert.equal(tooLong.status, 400, tooLong.text);

    const notAList = await suite.api('PATCH', `/api/revival-centers/zones/${zoneA.id}`, adminToken, { leaders: 'Deacon' });
    assert.equal(notAList.status, 400, notAList.text);
    assert.equal(notAList.json.error, 'Invalid member id.');
  });

  it('ignores a member who does not exist, and changes nothing', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const standing = zone.leaders.map((l) => l.member_id);

    const res = await setLeaders(zoneA.id, [...standing.map((id) => ({ memberId: id })), { memberId: 999999, roleName: 'Deacon' }]);
    assert.equal(res.status, 404, res.text);
    assert.equal(res.json.error, 'Member not found.');

    const after = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    assert.deepEqual(after.leaders.map((l) => l.member_id), standing);
  });

  it('keeps the front desk out of the assignment', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const res = await setLeaders(zoneA.id, [], deskToken);
    assert.equal(res.status, 403, res.text);
    // The front desk can still READ who holds office: it is on the roster.
    assert.ok((await centerFrom(deskToken)).zones.find((z) => z.id === zoneA.id).leaders.length);
  });

  it('leaves the offices alone when the zone is only renamed', async () => {
    const before = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const res = await suite.api('PATCH', `/api/revival-centers/zones/${zoneA.id}`, adminToken, { name: 'Zone A (Mbezi)' });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.leaders, null, 'a rename says nothing about leaders');

    const after = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    assert.equal(after.name, 'Zone A (Mbezi)');
    assert.deepEqual(after.leaders.map((l) => `${l.member_id}:${l.role_name}`), before.leaders.map((l) => `${l.member_id}:${l.role_name}`));
  });

  it('renames a zone out of the center roll-up with it', async () => {
    const center = await centerFrom();
    assert.ok(center.leaders.some((l) => l.zone_name === 'Zone A (Mbezi)'));
    assert.equal(center.leaders.some((l) => l.zone_name === 'Zone A'), false);
  });

  it('keeps naming a leader who was deactivated rather than deleted', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const person = await addMember('Zawadi Aliyestaafu', '+255700400009', zoneA.id);
    await setLeaders(zoneA.id, [
      ...zone.leaders.map((l) => ({ memberId: l.member_id, roleName: l.role_name })),
      { memberId: person.id, roleName: 'Treasurer' },
    ]);

    // Deactivated: the row survives, so the zone keeps a real person in office,
    // the flag is what tells the roster to mark them as inactive.
    const { rowCount } = await suite.query('UPDATE members SET is_active = 0 WHERE id = ?', [person.id]);
    assert.equal(rowCount, 1);

    const after = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const listed = after.leaders.find((l) => l.member_id === person.id);
    assert.equal(listed.name, 'Zawadi Aliyestaafu');
    assert.equal(listed.role_name, 'Treasurer');
    assert.equal(listed.is_active, 0);
  });

  it('keeps the zone standing when a leader is deleted outright', async () => {
    const zone = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    const gone = await addMember('Elia Aliyefutwa', '+255700400010', zoneA.id);
    await setLeaders(zoneA.id, [
      ...zone.leaders.map((l) => ({ memberId: l.member_id, roleName: l.role_name })),
      { memberId: gone.id, roleName: 'Deacon' },
    ]);

    // No history at all, so this is a genuine delete rather than a deactivation.
    const removed = await suite.api('DELETE', `/api/members/${gone.id}`, adminToken);
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.json.deleted, true);

    const after = (await centerFrom()).zones.find((z) => z.id === zoneA.id);
    assert.ok(after, 'the zone is not collateral damage');
    assert.deepEqual(after.leaders.map((l) => l.member_id), zone.leaders.map((l) => l.member_id));
    assert.equal(after.name, 'Zone A (Mbezi)');
  });

  it('leaves nobody behind when the zone itself is deleted', async () => {
    const person = await addMember('Neema WaMwisho', '+255700400011', zoneB.id);
    const temp = (await suite.api('POST', `/api/revival-centers/${centerId}/zones`, adminToken, { name: 'Zone C' })).json.zone;
    // Filed in the temp zone, so the delete is allowed once the person moves out.
    await suite.api('PATCH', `/api/members/${person.id}`, deskToken, { zoneId: temp.id });
    await setLeaders(temp.id, [{ memberId: person.id, roleName: 'Deacon' }]);
    assert.equal((await suite.get('SELECT COUNT(*) AS c FROM center_zone_leaders WHERE zone_id = ?', [temp.id])).c, 1);

    const goneZone = await suite.api('DELETE', `/api/revival-centers/zones/${temp.id}`, adminToken);
    assert.equal(goneZone.status, 400, goneZone.text);
    assert.match(goneZone.json.error, /still has members assigned/i);

    // Moving the member out is refused while they hold an office in that zone
    // (an office outlives its bearer's filing otherwise), so the office goes
    // first, then the move, then the zone, taking its leader rows with it.
    const stranded = await suite.api('PATCH', `/api/members/${person.id}`, deskToken, { zoneId: null });
    assert.equal(stranded.status, 400, stranded.text);
    await setLeaders(temp.id, []);
    await suite.api('PATCH', `/api/members/${person.id}`, deskToken, { zoneId: null });
    const gone2 = await suite.api('DELETE', `/api/revival-centers/zones/${temp.id}`, adminToken);
    assert.equal(gone2.status, 200, gone2.text);
    assert.equal((await suite.get('SELECT COUNT(*) AS c FROM center_zone_leaders WHERE zone_id = ?', [temp.id])).c, 0);
  });
});
