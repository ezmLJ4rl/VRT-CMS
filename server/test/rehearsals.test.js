'use strict';
/**
 * Rehearsals vs services (ibada).
 *
 * A rehearsal is a practice session, not a church service: it records attendance
 * only, a headcount plus names, where the names may be handwritten for people
 * who are not registered yet or picked from the member list, and it is reported
 * separately so practice numbers never inflate the church's service figures.
 *
 * The invariant worth protecting above all others: money is never filed against
 * a rehearsal, in either direction (an offering cannot be recorded at one, and a
 * type that already collected offerings cannot become one).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'rehearsals', port: 4607 });

let adminToken;

after(() => suite.stop());

async function typeByKey(key) {
  return suite.get('SELECT * FROM service_types WHERE key = ?', [key]);
}

async function recordAttendance(serviceTypeId, body, token = adminToken) {
  return suite.api('POST', '/api/attendance', token, { serviceTypeId, ...body });
}

describe('rehearsals: the split exists in the data', () => {
  before(async () => {
    await suite.waitReady();
    const login = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    assert.equal(login.status, 200, login.text);
    adminToken = login.json.token;
  });

  it('marks the seeded rehearsals as rehearsals and the services as services', async () => {
    for (const key of ['choir_rehearsal_1', 'choir_rehearsal_2', 'pw_rehearsal']) {
      const type = await typeByKey(key);
      assert.equal(type.kind, 'rehearsal', `${key} must be a rehearsal`);
      // A rehearsal is a headcount AND names, which is what 'both' means.
      assert.equal(type.attendance_mode, 'both', `${key} must record a headcount and names`);
    }
    for (const key of ['sunday_1', 'sunday_2', 'wednesday', 'friday']) {
      assert.equal((await typeByKey(key)).kind, 'service', `${key} must stay a service`);
    }
  });

  it('serves kind to clients so a picker can separate the two', async () => {
    const res = await suite.api('GET', '/api/service-types', adminToken);
    assert.equal(res.status, 200);
    const rehearsal = res.json.serviceTypes.find((t) => t.key === 'choir_rehearsal_1');
    assert.equal(rehearsal.kind, 'rehearsal');
    assert.ok(res.json.serviceTypes.every((t) => t.kind === 'service' || t.kind === 'rehearsal'));
  });
});

describe('rehearsals: creating and editing', () => {
  it('defaults a new rehearsal to a headcount and names, and a new service to a headcount', async () => {
    const rehearsal = await suite.api('POST', '/api/service-types', adminToken, {
      name: 'Youth Rehearsal', kind: 'rehearsal',
    });
    assert.equal(rehearsal.status, 201, rehearsal.text);
    const created = await suite.get('SELECT * FROM service_types WHERE id = ?', [rehearsal.json.id]);
    assert.equal(created.kind, 'rehearsal');
    assert.equal(created.attendance_mode, 'both');

    const service = await suite.api('POST', '/api/service-types', adminToken, { name: 'Saturday Vigil' });
    const plain = await suite.get('SELECT * FROM service_types WHERE id = ?', [service.json.id]);
    assert.equal(plain.kind, 'service', 'kind defaults to a church service');
    assert.equal(plain.attendance_mode, 'headcount');
  });

  it('rejects an unknown kind', async () => {
    const res = await suite.api('POST', '/api/service-types', adminToken, {
      name: 'Nonsense', kind: 'workshop',
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Unknown service type kind.');
  });

  it('refuses to turn a type that already collected offerings into a rehearsal', async () => {
    // sunday_1 is a real service with money against it.
    const recorded = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: (await typeByKey('sunday_1')).id, category: 'general', amount: 5000,
    });
    assert.equal(recorded.status, 201, recorded.text);

    const refused = await suite.api('PATCH', `/api/service-types/${(await typeByKey('sunday_1')).id}`, adminToken, {
      kind: 'rehearsal',
    });
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.json.error, /records attendance only/);
    // Still a service: the refusal is not a partial write.
    assert.equal((await typeByKey('sunday_1')).kind, 'service');
  });

  it('allows it when the type never collected anything', async () => {
    const type = await typeByKey('friday');
    const ok = await suite.api('PATCH', `/api/service-types/${type.id}`, adminToken, { kind: 'rehearsal' });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await typeByKey('friday')).kind, 'rehearsal');
    // Put it back: other suites share the seeded shape per-database, but this
    // keeps the file order-independent.
    await suite.api('PATCH', `/api/service-types/${type.id}`, adminToken, { kind: 'service' });
  });
});

describe('rehearsals: attendance is a headcount and names', () => {
  it('accepts a headcount, names, or both on one rehearsal', async () => {
    const id = (await typeByKey('choir_rehearsal_1')).id;

    const both = await recordAttendance(id, { count: 12, attendees: [{ name: 'Asha M' }, { name: 'Baraka J' }] });
    assert.equal(both.status, 201, both.text);
    assert.equal(both.json.count, 12, 'the headcount is authoritative when both are given');
    assert.equal(both.json.mode, 'both');

    const namesOnly = await recordAttendance(id, { attendees: [{ name: 'Chausiku K' }] });
    assert.equal(namesOnly.status, 201, namesOnly.text);
    assert.equal(namesOnly.json.count, 1, 'names alone give the count');

    const headcountOnly = await recordAttendance(id, { count: 9 });
    assert.equal(headcountOnly.status, 201, headcountOnly.text);
    assert.equal(headcountOnly.json.count, 9);

    const nothing = await recordAttendance(id, {});
    assert.equal(nothing.status, 400, 'a rehearsal still needs something to record');
    assert.equal(nothing.json.error, 'Enter a headcount, attendee names, or both.');
  });

  it('keeps unregistered attendees as handwritten names alongside linked members', async () => {
    const id = (await typeByKey('choir_rehearsal_1')).id;
    // The seed creates no members, so register one to recall from the database.
    const created1 = await suite.api('POST', '/api/members', adminToken, {
      name: 'Recall Chorister', phone: '+255700000901',
    });
    assert.equal(created1.status, 201, created1.text);
    const member = await suite.get('SELECT id, name FROM members WHERE name = ?', ['Recall Chorister']);
    assert.ok(member, 'the member was registered');

    const created = await recordAttendance(id, {
      count: 3,
      attendees: [
        { memberId: member.id, name: member.name }, // recalled from the database
        { name: 'Guest Singer' }, // handwritten: not registered yet
      ],
    });
    assert.equal(created.status, 201, created.text);

    const attendees = await suite.all(
      'SELECT member_id, name FROM attendance_attendees WHERE attendance_id = ? ORDER BY id',
      [created.json.id]
    );
    assert.equal(attendees.length, 2);
    assert.equal(attendees[0].member_id, member.id, 'a recalled person stays linked to their member record');
    assert.equal(attendees[1].member_id, null, 'someone not registered yet is stored as a name only');
    assert.equal(attendees[1].name, 'Guest Singer');
  });

  it('refuses to file an offering at a rehearsal', async () => {
    const rehearsal = await typeByKey('choir_rehearsal_1');
    const refused = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: rehearsal.id, category: 'general', amount: 1000,
    });
    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json.error, `${rehearsal.name} is a rehearsal, so it records attendance only and takes no offering.`);

    // A service still takes one.
    const service = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: (await typeByKey('wednesday')).id, category: 'general', amount: 1000,
    });
    assert.equal(service.status, 201, service.text);

    // And the refusal is localized like everything else.
    const inSwahili = await suite.api(
      'POST', '/api/offerings', adminToken,
      { serviceTypeId: rehearsal.id, category: 'general', amount: 1000 },
      { 'X-Language': 'sw' }
    );
    assert.equal(inSwahili.status, 400);
    assert.match(inSwahili.json.error, /ni mazoezi/);
  });
});

describe('rehearsals: reported separately from services', () => {
  it('keeps rehearsal attendance out of the service totals, and shows it on its own', async () => {
    const rehearsalId = (await typeByKey('choir_rehearsal_2')).id;
    const serviceId = (await typeByKey('sunday_2')).id;

    // Measured as a delta, so the assertion is exact: the service figure moves by
    // the service headcount only, and the rehearsal figure by the rehearsal only.
    const before = await suite.api('GET', '/api/reports/summary', adminToken);
    assert.equal((await recordAttendance(rehearsalId, { count: 25 })).status, 201);
    assert.equal((await recordAttendance(serviceId, { count: 100 })).status, 201);
    const after = await suite.api('GET', '/api/reports/summary', adminToken);
    assert.equal(after.status, 200);

    assert.equal(
      Number(after.json.attendance.people) - Number(before.json.attendance.people),
      100,
      'the service total moves by the service headcount alone'
    );
    assert.equal(
      Number(after.json.rehearsals.people) - Number(before.json.rehearsals.people),
      25,
      'the rehearsal total is reported on its own'
    );
  });

  it('splits the per-type breakdown into services and rehearsals', async () => {
    const res = await suite.api('GET', '/api/reports/breakdown?groupBy=service', adminToken);
    assert.equal(res.status, 200);

    assert.ok(res.json.breakdown.length >= 1, 'services are listed');
    assert.ok(res.json.breakdown.every((r) => r.kind === 'service'), 'breakdown holds services only');
    assert.ok(res.json.rehearsals.length >= 1, 'rehearsals are listed separately');
    assert.ok(res.json.rehearsals.every((r) => r.kind === 'rehearsal'));
    // A rehearsal never has money against it, so it carries no money columns.
    for (const r of res.json.rehearsals) {
      assert.equal(r.offering, undefined, 'a rehearsal row must not report an offering total');
      assert.equal(r.gifts, undefined);
    }
    for (const r of res.json.breakdown) {
      assert.ok(r.offering !== undefined, 'a service row reports its offering total');
    }
  });

  it('has a rehearsal-specific breakdown, in attendance terms only', async () => {
    const res = await suite.api('GET', '/api/reports/breakdown?groupBy=rehearsal', adminToken);
    assert.equal(res.status, 200);
    assert.ok(res.json.breakdown.length >= 1);
    assert.ok(res.json.breakdown.every((r) => r.kind === 'rehearsal'));
    assert.ok(res.json.breakdown.some((r) => Number(r.sessions) > 0), 'rehearsal sessions are counted');
    assert.equal(res.json.breakdown[0].offering, undefined);
  });

  it('tells a client which rows are rehearsals, so a list can keep them apart', async () => {
    const rehearsalId = (await typeByKey('choir_rehearsal_1')).id;
    const serviceId = (await typeByKey('sunday_1')).id;
    // Recorded here rather than assumed from the seed, so the two sides of the
    // split are both present in the list this assertion reads.
    assert.equal((await recordAttendance(rehearsalId, { count: 4 })).status, 201);
    assert.equal((await recordAttendance(serviceId, { count: 60 })).status, 201);

    const res = await suite.api('GET', '/api/attendance', adminToken);
    assert.equal(res.status, 200);

    // Every row is classifiable: either explicitly one kind or the other, or
    // null for an untyped session (which a client must read as a service, the
    // schema default). Checked against the service type's own kind, so a row
    // can never come back saying "rehearsal" for a service type, that is what
    // would silently misfile service attendance on a client.
    const kindByKey = new Map((await suite.all('SELECT key, kind FROM service_types')).map((t) => [t.key, t.kind]));
    for (const row of res.json.attendance) {
      assert.ok(
        row.service_type_kind === null || row.service_type_kind === kindByKey.get(row.service_type_key),
        `attendance ${row.id} (${row.service_type_key}) reports kind ${JSON.stringify(row.service_type_kind)}`
      );
    }

    // The rehearsal rows this suite just recorded are identifiable as such.
    const rehearsalRows = res.json.attendance.filter((r) => r.service_type_key === 'choir_rehearsal_1');
    assert.ok(rehearsalRows.length >= 1, 'the rehearsal is in the list');
    assert.ok(rehearsalRows.every((r) => r.service_type_kind === 'rehearsal'));

    // And a service row is not.
    const serviceRows = res.json.attendance.filter((r) => r.service_type_key === 'sunday_1');
    assert.ok(serviceRows.length >= 1, 'a service is in the list');
    assert.ok(serviceRows.every((r) => r.service_type_kind === 'service'));
  });

  it('keeps rehearsals out of the attendance trend line', async () => {
    // Record a rehearsal on a date no service uses, so it would show up as a
    // spike if the trend were not service-scoped.
    const rehearsalId = (await typeByKey('pw_rehearsal')).id;
    const oddDay = await recordAttendance(rehearsalId, { count: 777, date: '2026-03-04' });
    assert.equal(oddDay.status, 201, oddDay.text);

    const trends = await suite.api('GET', '/api/attendance/trends?granularity=monthly', adminToken);
    assert.equal(trends.status, 200);
    const march = trends.json.trends.find((t) => t.period === '2026-03');
    assert.ok(!march || Number(march.total) !== 777, 'a rehearsal must not appear in service trends');
    assert.ok(!trends.json.byType.some((t) => t.key === 'pw_rehearsal'), 'no rehearsal series in the trend');
  });

  it('exports service attendance by default and rehearsals on request', async () => {
    const services = await suite.api('GET', '/api/reports/attendance.csv', adminToken);
    assert.equal(services.status, 200);
    assert.ok(!services.text.includes('Choir Rehearsal'), 'the default export is services only');

    const rehearsals = await suite.api('GET', '/api/reports/attendance.csv?kind=rehearsal', adminToken);
    assert.equal(rehearsals.status, 200);
    assert.ok(rehearsals.text.includes('Choir Rehearsal'), 'rehearsals export separately');
    assert.ok(!rehearsals.text.includes('Sunday Service'), 'and the two exports do not mix');
  });
});
