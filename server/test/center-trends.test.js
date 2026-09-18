'use strict';
/**
 * How each revival center is moving (GET /api/reports/center-trends).
 *
 * The centers page shows every center's own line, so the things worth pinning
 * are the properties that make those lines trustworthy:
 *
 *   1. the window is the last COMPLETE months: the month in progress is absent,
 *      because a center in its first week has not declined;
 *   2. every center is named, even one with nothing recorded, and its series is
 *      zero-filled: a center that stopped meeting must read as a fall to zero
 *      rather than as a gap;
 *   3. the figures mean what the Reports page means by them: service attendance
 *      only (a rehearsal can never inflate a center), and giving attributed
 *      through the member who gave, with anonymous gifts in no center at all;
 *   4. the response is for leadership: admins yes, the front desk no.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'center-trends', port: 4623 });

let adminToken;
let deskToken;
let serviceTypeId;
let rehearsalTypeId;

after(() => suite.stop());

/**
 * The last `count` complete months, oldest first: computed here independently of
 * the endpoint so the test states the rule rather than agreeing with the code.
 */
function lastCompleteMonths(count, today) {
  const [year, month] = today.split('-').map(Number);
  const keys = [];
  for (let back = 1; back <= count; back += 1) {
    const d = new Date(Date.UTC(year, month - 1 - back, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return keys.reverse();
}

describe('center trends', () => {
  let today;
  let months; // the six complete months this suite writes records into
  let centerA;
  let centerB;

  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    assert.equal(admin.status, 200, admin.text);
    adminToken = admin.json.token;

    await suite.api('POST', '/api/users', adminToken, {
      name: 'Trends Desk', email: 'center-trends-desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const desk = await suite.api('POST', '/api/auth/login', null, {
      email: 'center-trends-desk@test.local', password: 'DeskPass_123!',
    });
    deskToken = desk.json.token;
    assert.ok(deskToken);

    const service = await suite.api('POST', '/api/service-types', adminToken, {
      name: 'Trend Service', kind: 'service', attendanceMode: 'count',
    });
    assert.equal(service.status, 201, service.text);
    serviceTypeId = service.json.id;

    // A rehearsal, to prove it can never be counted as a center's attendance.
    const rehearsal = await suite.api('POST', '/api/service-types', adminToken, {
      name: 'Trend Rehearsal', kind: 'rehearsal', attendanceMode: 'count',
    });
    assert.equal(rehearsal.status, 201, rehearsal.text);
    rehearsalTypeId = rehearsal.json.id;

    today = (await suite.api('GET', '/api/time', adminToken)).json.date;
    months = lastCompleteMonths(6, today);

    centerA = (await suite.api('POST', '/api/revival-centers', adminToken, { name: 'Trend Center A' })).json.revivalCenter;
    centerB = (await suite.api('POST', '/api/revival-centers', adminToken, { name: 'Trend Center B' })).json.revivalCenter;
  });

  async function recordAttendance({ centerId, typeId = serviceTypeId, date, count }) {
    const res = await suite.api('POST', '/api/attendance', adminToken, {
      serviceTypeId: typeId, centerId, date, count,
    });
    assert.equal(res.status, 201, res.text);
  }

  it('counts service attendance and giving per center per month, with the current month excluded', async () => {
    // Two months of service attendance at center A, and a rehearsal in between
    // that must not be counted as one of them.
    await recordAttendance({ centerId: centerA.id, date: `${months[0]}-15`, count: 100 });
    await recordAttendance({ centerId: centerA.id, typeId: rehearsalTypeId, date: `${months[1]}-05`, count: 999 });
    await recordAttendance({ centerId: centerA.id, date: `${months[2]}-20`, count: 140 });

    // Giving reaches a center through the member who gave it.
    const member = (await suite.api('POST', '/api/members', adminToken, {
      name: 'Trend Giver', revivalCenterId: centerA.id,
    })).json.member;
    const gift = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId, date: `${months[3]}-10`, category: 'special', amount: 50000, currency: 'TZS',
      memberId: member.id, offererName: member.name,
    });
    assert.equal(gift.status, 201, gift.text);

    // A gift with no member belongs to no center, so it must not appear under an
    // unnamed bucket that no row on the centers page could show.
    const anonymous = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId, date: `${months[4]}-10`, category: 'special', amount: 7777, currency: 'TZS',
    });
    assert.equal(anonymous.status, 201, anonymous.text);

    const res = await suite.api('GET', '/api/reports/center-trends?months=6', adminToken);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.months, months, 'the window is the last six complete months, oldest first');
    assert.ok(!res.json.months.includes(today.slice(0, 7)), 'the month in progress has no bucket');
    assert.equal(res.json.months[res.json.months.length - 1], months[5], 'the newest bucket is the last complete month');

    const a = res.json.centers.find((c) => c.key === centerA.id);
    assert.deepEqual(a.attendance, [100, 0, 140, 0, 0, 0], 'a rehearsal is not service attendance');
    assert.deepEqual(a.offering, [0, 0, 0, 50000, 0, 0]);
    assert.equal(typeof a.attendance[0], 'number', 'the client does arithmetic on these');

    // Every center is named, including one that has recorded nothing at all.
    const b = res.json.centers.find((c) => c.key === centerB.id);
    assert.deepEqual(b.attendance, [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(b.offering, [0, 0, 0, 0, 0, 0]);

    const centers = await suite.api('GET', '/api/revival-centers', adminToken);
    assert.deepEqual(
      res.json.centers.map((c) => c.key).sort((x, y) => x - y),
      centers.json.revivalCenters.map((c) => c.id).sort((x, y) => x - y),
      'one series per center the page will render'
    );
    assert.ok(res.json.centers.every((c) => c.key !== null), 'no unnamed bucket');
  });

  it('honours the requested window, within limits', async () => {
    const two = await suite.api('GET', '/api/reports/center-trends?months=2', adminToken);
    assert.deepEqual(two.json.months, months.slice(-2));
    assert.ok(two.json.centers.every((c) => c.attendance.length === 2 && c.offering.length === 2));

    // A nonsense window must not become an unbounded query, and one month can
    // never be a trend.
    const capped = await suite.api('GET', '/api/reports/center-trends?months=999', adminToken);
    assert.equal(capped.json.months.length, 24);
    const floor = await suite.api('GET', '/api/reports/center-trends?months=1', adminToken);
    assert.equal(floor.json.months.length, 2);
    const defaulted = await suite.api('GET', '/api/reports/center-trends', adminToken);
    assert.equal(defaulted.json.months.length, 6);
  });

  it('keeps the front desk out of the leadership view', async () => {
    const res = await suite.api('GET', '/api/reports/center-trends', deskToken);
    assert.equal(res.status, 403, res.text);
  });
});
