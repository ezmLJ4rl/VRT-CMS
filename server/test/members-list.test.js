'use strict';
/**
 * The members list contract: how it orders, how it counts, and what it searches.
 *
 * The header (title count, sort control, filter panel) is built on these three
 * answers, so they are pinned here rather than discovered through the UI: an
 * unknown sort key must fall back rather than error, the count must describe
 * what the filters match (not what the limit returned), and a phone number must
 * be findable even though it is only stored encrypted.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'members-list', port: 4628 });
let adminToken;
let centerId;
const created = [];

after(() => suite.stop());

async function addMember(body) {
  const res = await suite.api('POST', '/api/members', adminToken, { confirmNameDuplicate: true, ...body });
  assert.equal(res.status, 201, res.text);
  created.push(res.json.member.id);
  return res.json.member;
}

describe('members list: order, count, search', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    adminToken = admin.json.token;
    const centers = (await suite.api('GET', '/api/revival-centers', adminToken)).json.revivalCenters;
    centerId = centers[0].id;

    // Deliberately out of alphabetical order so a sort test can tell them apart,
    // and in a known order for "recently added" (created last = first).
    await addMember({ name: 'Zawadi Msort', phone: '+255700111222', email: 'zawadi.sort@test.local', revivalCenterId: centerId });
    await addMember({ name: 'Amani Asort', phone: '+255700333444', email: 'amani.sort@test.local', revivalCenterId: centerId });
    await addMember({ name: 'Bahati Bsort', phone: '+255700555666', email: 'bahati.sort@test.local' });
  });

  it('defaults to recently added, and offers name order', async () => {
    const recent = (await suite.api('GET', '/api/members', adminToken)).json;
    assert.equal(recent.sort, 'recent');
    const recentNames = recent.members.map((m) => m.name);
    const mine = recentNames.filter((n) => /sort$/.test(n));
    assert.deepEqual(mine, ['Bahati Bsort', 'Amani Asort', 'Zawadi Msort'], 'newest first');

    const byName = (await suite.api('GET', '/api/members?sort=name', adminToken)).json;
    assert.deepEqual(byName.members.map((m) => m.name).filter((n) => /sort$/.test(n)), ['Amani Asort', 'Bahati Bsort', 'Zawadi Msort']);

    const desc = (await suite.api('GET', '/api/members?sort=name_desc', adminToken)).json;
    assert.deepEqual(desc.members.map((m) => m.name).filter((n) => /sort$/.test(n)), ['Zawadi Msort', 'Bahati Bsort', 'Amani Asort']);
  });

  it('falls back to the default order for an unknown sort key', async () => {
    const res = await suite.api('GET', '/api/members?sort=; DROP TABLE members', adminToken);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.sort, 'recent');
    assert.ok(res.json.members.length > 0, 'the table is intact and still listed');
  });

  it('counts what the filters match, not what the limit returned', async () => {
    const all = (await suite.api('GET', '/api/members', adminToken)).json;
    assert.equal(all.total, all.grandTotal, 'unfiltered: the two counts agree');
    assert.equal(all.total, (await suite.get('SELECT COUNT(*)::int AS n FROM members')).n);

    const limited = (await suite.api('GET', '/api/members?limit=2', adminToken)).json;
    assert.equal(limited.members.length, 2, 'the limit still truncates the list');
    assert.equal(limited.total, all.total, 'but the count is the full match, not the page size');

    const filtered = (await suite.api('GET', `/api/members?centerId=${centerId}`, adminToken)).json;
    assert.equal(filtered.total, 2, 'two of the new members are filed at this center');
    assert.equal(filtered.grandTotal, all.total, 'the directory total is unaffected by the filter');
    assert.ok(filtered.total < filtered.grandTotal, 'the header can tell the two apart');
  });

  it('search and a filter combine rather than override each other', async () => {
    const res = (await suite.api('GET', `/api/members?search=Msort&centerId=${centerId}`, adminToken)).json;
    assert.deepEqual(res.members.map((m) => m.name), ['Zawadi Msort']);
    assert.equal(res.total, 1);

    // The same term without the filter still finds the member who is filed
    // elsewhere: the filter narrows, it does not replace the search.
    const wide = (await suite.api('GET', '/api/members?search=sort', adminToken)).json;
    assert.equal(wide.total, 3);
  });

  it('a phone number finds its member even though it is stored encrypted', async () => {
    // Three digits of the middle of Bahati's number.
    const res = (await suite.api('GET', '/api/members?search=0555666', adminToken)).json;
    assert.deepEqual(res.members.map((m) => m.name), ['Bahati Bsort']);

    // A shorter run than the scan threshold does not match a phone at all.
    const tooShort = (await suite.api('GET', '/api/members?search=66', adminToken)).json;
    assert.equal(tooShort.members.some((m) => /sort$/.test(m.name)), false);
  });

  it('filters by gender, zone and active status as well', async () => {
    await suite.run("UPDATE members SET gender = 'female' WHERE id = ?", [created[0]]);
    await suite.run("UPDATE members SET gender = 'male' WHERE id = ?", [created[1]]);
    const female = (await suite.api('GET', '/api/members?gender=female', adminToken)).json;
    assert.ok(female.members.length > 0);
    assert.ok(female.members.every((m) => m.gender === 'female'));
    const male = (await suite.api('GET', '/api/members?gender=male', adminToken)).json;
    assert.ok(male.members.length > 0);
    assert.ok(male.members.every((m) => m.gender === 'male'));
  });

  it('filters by zone and by active status as well', async () => {
    const centers = (await suite.api('GET', '/api/revival-centers', adminToken)).json.revivalCenters;
    const zone = (centers.find((c) => c.id === centerId)?.zones || [])[0];
    if (zone) {
      const byZone = (await suite.api('GET', `/api/members?zoneId=${zone.id}`, adminToken)).json;
      for (const m of byZone.members) assert.equal(m.zone_id, zone.id);
    }

    const target = created[created.length - 1];
    await suite.run('UPDATE members SET is_active = 0 WHERE id = ?', [target]);
    const inactive = (await suite.api('GET', '/api/members?active=0', adminToken)).json;
    assert.ok(inactive.members.some((m) => m.id === target), 'the deactivated member is listed under Inactive only');
    const active = (await suite.api('GET', '/api/members?active=1', adminToken)).json;
    assert.equal(active.members.some((m) => m.id === target), false);
  });
});
