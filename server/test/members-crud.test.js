'use strict';
/**
 * The member record, whole.
 *
 * Registration, duplicate detection and deletion are one story about one row, so
 * they are pinned together here:
 *
 *   1. a member is registered in ONE call: center, zone and groups included,
 *      which is what lets the Members screen be the only place registration
 *      happens;
 *   2. an email or a phone number that already exists is refused (identifying the
 *      record it belongs to), while a NAME that already exists is only a
 *      question the caller must answer: two real people can share a name;
 *   3. deleting a member with history deactivates them instead, keeping every
 *      attendance, offering and pledge row attributed to a real person.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'members-crud', port: 4621 });

let adminToken;
let recToken;
let serviceTypeId;
let today;

after(() => suite.stop());

/** A one-shot member registration against the API. */
function register(token, body) {
  return suite.api('POST', '/api/members', token, { name: 'Member', ...body });
}

/** Records this member as present at one service: real attendance history. */
async function recordAttendance(member, token = recToken) {
  const res = await suite.api('POST', '/api/attendance', token, {
    serviceTypeId,
    date: today,
    attendees: [{ memberId: member.id, name: member.name }],
  });
  assert.equal(res.status, 201, res.text);
  return res.json;
}

describe('member registration and deletion', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    adminToken = admin.json.token;
    assert.ok(adminToken);

    await suite.api('POST', '/api/users', adminToken, {
      name: 'Front Desk', email: 'members-crud-desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const desk = await suite.api('POST', '/api/auth/login', null, {
      email: 'members-crud-desk@test.local', password: 'DeskPass_123!',
    });
    recToken = desk.json.token;
    assert.ok(recToken);

    // A service type of its own, in 'both' mode: the suite needs to name a
    // member (that is what creates the attendance row that references them), and
    // it must not depend on which seeded type happens to allow names today.
    const named = await suite.api('POST', '/api/service-types', adminToken, {
      name: 'Named Attendance Service', kind: 'service', attendanceMode: 'both',
    });
    assert.equal(named.status, 201, named.text);
    serviceTypeId = named.json.id;
    const time = await suite.api('GET', '/api/time', recToken);
    today = time.json.date;
  });

  it('registers a member into their center, zone and groups in one request', async () => {
    const center = (await suite.api('POST', '/api/revival-centers', adminToken, { name: 'Mbezi' })).json.revivalCenter;
    const zone = (await suite.api('POST', `/api/revival-centers/${center.id}/zones`, adminToken, { name: 'Zone A' })).json.zone;
    const group = (await suite.api('POST', '/api/groups', recToken, { name: 'Choir One', kind: 'choir' })).json.group;

    const res = await register(recToken, {
      name: 'Asha One',
      phone: '+255700900111',
      revivalCenterId: center.id,
      zoneId: zone.id,
      groupIds: [group.id],
    });
    assert.equal(res.status, 201, res.text);
    const member = res.json.member;
    assert.equal(member.revival_center_id, center.id);
    assert.equal(member.zone_id, zone.id);
    assert.equal(member.group_names, 'Choir One', 'the group is applied as part of the same registration');

    // …and the roster the group screen reads agrees, with no second step.
    const roster = await suite.api('GET', `/api/groups/${group.id}`, recToken);
    assert.deepEqual(roster.json.members.map((m) => m.name), ['Asha One']);
  });

  it('refuses an email that already exists and names the member holding it', async () => {
    const first = await register(recToken, { name: 'Email Holder', email: 'holder@test.local' });
    assert.equal(first.status, 201, first.text);

    const second = await register(recToken, { name: 'Someone Else', email: 'holder@test.local' });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.json.code, 'duplicate_email');
    // The message identifies the existing record, so the desk can open it.
    assert.match(second.json.error, /Email Holder/);
    assert.match(second.json.error, /VRT-\d+/);
  });

  it('refuses a phone number that already exists, in either spelling of the number', async () => {
    const first = await register(recToken, { name: 'Phone Holder', phone: '+255712345678' });
    assert.equal(first.status, 201, first.text);

    // The same person's number is stored encrypted, so this is a real comparison
    // of numbers rather than a string match: '0712 345 678' is the same phone.
    const second = await register(recToken, { name: 'Another One', phone: '0712 345 678' });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.json.code, 'duplicate_phone');
    assert.match(second.json.error, /Phone Holder/);
  });

  it('treats a matching email AND phone as one known person', async () => {
    const first = await register(recToken, { name: 'Twin Holder', email: 'twin@test.local', phone: '+255700123123' });
    assert.equal(first.status, 201, first.text);

    const second = await register(recToken, { name: 'Twin Copy', email: 'twin@test.local', phone: '+255700123123' });
    assert.equal(second.status, 409, second.text);
    // The strongest signal gets the most specific message.
    assert.equal(second.json.code, 'duplicate_member');
    assert.match(second.json.error, /Twin Holder/);
  });

  it('asks about a shared NAME instead of blocking a genuinely different person', async () => {
    const first = await register(recToken, { name: 'Neema K', email: 'neema.k@test.local', phone: '+255700555001' });
    assert.equal(first.status, 201, first.text);

    // Different email, different phone, same name: a question, not a refusal.
    const questioned = await register(recToken, { name: 'neema  k', email: 'neema.k2@test.local', phone: '+255700555002' });
    assert.equal(questioned.status, 409, questioned.text);
    assert.equal(questioned.json.code, 'duplicate_name');
    assert.equal(questioned.json.duplicates[0].name, 'Neema K');

    // The desk says "a different person" and the second member is registered.
    const confirmed = await register(recToken, {
      name: 'neema  k',
      email: 'neema.k2@test.local',
      phone: '+255700555002',
      confirmNameDuplicate: true,
    });
    assert.equal(confirmed.status, 201, confirmed.text);
    assert.notEqual(confirmed.json.member.id, first.json.member.id);
  });

  it('does not block a name that merely shares a word with another member', async () => {
    await register(recToken, { name: 'Baraka Joseph', email: 'baraka1@test.local' });
    const other = await register(recToken, { name: 'Baraka Mwita', email: 'baraka2@test.local' });
    assert.equal(other.status, 201, other.text);
  });

  it('cannot be used to move an existing member onto another member’s phone number', async () => {
    const holder = await register(recToken, { name: 'Number Owner', phone: '+255700777888' });
    assert.equal(holder.status, 201, holder.text);
    const mover = await register(recToken, { name: 'Number Mover', phone: '+255700777999' });
    assert.equal(mover.status, 201, mover.text);

    const res = await suite.api('PATCH', `/api/members/${mover.json.member.id}`, recToken, { phone: '+255700777888' });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.code, 'duplicate_phone');
  });

  it('deletes a member who has no history at all', async () => {
    const created = await register(recToken, { name: 'No History', phone: '+255700888111' });
    const id = created.json.member.id;

    const res = await suite.api('DELETE', `/api/members/${id}`, adminToken);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.deleted, true);
    assert.equal(res.json.deactivated, undefined);

    const gone = await suite.api('GET', `/api/members/${id}`, adminToken);
    assert.equal(gone.status, 404);
  });

  it('deactivates, never deletes: a member whose attendance history names them', async () => {
    const created = await register(recToken, { name: 'Has History', phone: '+255700888222' });
    const member = created.json.member;
    await recordAttendance(member);

    const res = await suite.api('DELETE', `/api/members/${member.id}`, adminToken);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.deactivated, true, 'history means deactivation, not deletion');
    assert.equal(res.json.deleted, undefined);
    assert.ok(res.json.history.attendance > 0);

    // The row survives, inactive, and the attendance that references it still
    // resolves to a real member with a real name.
    const after = await suite.api('GET', `/api/members/${member.id}`, adminToken);
    assert.equal(after.status, 200);
    assert.equal(after.json.member.is_active, 0);
    const linked = await suite.get(
      'SELECT name FROM attendance_attendees WHERE member_id = ?',
      [member.id]
    );
    assert.equal(linked.name, 'Has History');
  });

  it('deactivates a member whose giving history names them, too', async () => {
    const created = await register(recToken, { name: 'Has Given', phone: '+255700888333' });
    const member = created.json.member;
    const offering = await suite.api('POST', '/api/offerings', recToken, {
      serviceTypeId,
      date: today,
      category: 'special',
      amount: 5000,
      currency: 'TZS',
      memberId: member.id,
      offererName: member.name,
    });
    assert.equal(offering.status, 201, offering.text);

    const res = await suite.api('DELETE', `/api/members/${member.id}`, adminToken);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.deactivated, true);
    assert.ok(res.json.history.offerings > 0);
  });

  it('keeps the front desk out of the delete path entirely', async () => {
    const created = await register(recToken, { name: 'Desk Cannot Delete', phone: '+255700888444' });
    const res = await suite.api('DELETE', `/api/members/${created.json.member.id}`, recToken);
    assert.equal(res.status, 403, res.text);
  });

  it('refuses a status change from the front desk, while letting it correct a member', async () => {
    const created = await register(recToken, { name: 'Desk May Correct', phone: '+255700888555' });
    const id = created.json.member.id;

    // Activating and deactivating a member is an administrator's decision. The
    // Members screen hides that button for a receptionist, so the refusal it is
    // stood down in favour of is the thing to pin, in both directions.
    for (const isActive of [0, 1, 0]) {
      const refused = await suite.api('PATCH', `/api/members/${id}`, recToken, { isActive });
      assert.equal(refused.status, 403, refused.text);
    }

    // The refusal is a refusal, not a half-applied write: the record is where it
    // was. (Asserted on the record rather than on the message text, which is a
    // translated string and changes with the catalog.)
    const after = await suite.api('GET', `/api/members/${id}`, recToken);
    assert.ok(after.json.member.is_active, 'a refused status change leaves the member as they were');

    // Correcting a detail is the front desk's own work, and the edit that the
    // screen does offer must still go through: with no status field in it.
    const edited = await suite.api('PATCH', `/api/members/${id}`, recToken, { notes: 'Corrected at the desk' });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json.member.notes, 'Corrected at the desk');
  });

  it('never lets a listing be served from a cache', async () => {
    // The front desk reads service types, groups and centers from this API and
    // must always see current state: a cached list is the bug this prevents.
    const res = await suite.api('GET', '/api/service-types', recToken);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});
