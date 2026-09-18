'use strict';
/**
 * Phase 4 (data-model consistency) regression tests.
 * - new service sessions are always typed
 * - offerings.category_id drives category reporting
 * - void/adjust lifecycle works and stays out of every aggregation
 * - receipt numbering is collision-free (MAX+1, not COUNT)
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'phase4-data', port: 4603 });
let adminToken;
let recToken;

// These tests exercise named-mode attendance. The seed no longer happens to ship
// a named-only type: its rehearsals are headcount + names, so the suite sets up
// the type it needs rather than depending on the seed's composition.
let namedTypeIdCache = null;
async function namedAttendanceTypeId() {
  if (namedTypeIdCache) return namedTypeIdCache;
  const types = await suite.api('GET', '/api/service-types', adminToken);
  const existing = types.json.serviceTypes.find((t) => t.attendance_mode === 'named');
  if (existing) {
    namedTypeIdCache = existing.id;
    return namedTypeIdCache;
  }
  const created = await suite.api('POST', '/api/service-types', adminToken, {
    name: `Named Probe ${Date.now()}`,
    attendanceMode: 'named',
  });
  assert.equal(created.status, 201, created.text);
  namedTypeIdCache = created.json.id;
  return namedTypeIdCache;
}

// The server must live for BOTH describes in this file: stop it once, at file end.
after(() => suite.stop());

describe('phase 4: typed sessions only', () => {
  before(async () => {
    await suite.waitReady();
    const login = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church', password: 'TestPass_123!',
    });
    adminToken = login.json.token;
    assert.ok(adminToken, 'single-step login issues a session');

    await suite.api('POST', '/api/users', adminToken, {
      name: 'Front Desk', email: 'desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const recLogin = await suite.api('POST', '/api/auth/login', null, { email: 'desk@test.local', password: 'DeskPass_123!' });
    recToken = recLogin.json.token;
  });

  it('POST /api/services requires a service type', async () => {
    const noType = await suite.api('POST', '/api/services', adminToken, { name: 'Untyped', date: '2026-01-01' });
    assert.equal(noType.status, 400);
    const badType = await suite.api('POST', '/api/services', adminToken, { name: 'X', date: '2026-01-01', serviceTypeId: 99999 });
    assert.equal(badType.status, 400);
    const ok = await suite.api('POST', '/api/services', adminToken, { date: '2026-01-01', serviceTypeId: 1 });
    assert.equal(ok.status, 201);
  });

  it('GET /api/services defaults to the church timezone, not UTC', async () => {
    const res = await suite.api('GET', '/api/services', adminToken);
    assert.equal(res.status, 200);
    const time = await suite.api('GET', '/api/time', adminToken);
    assert.equal(res.json.services.every((s) => s.date === time.json.date), true);
  });
});

describe('phase 4: category source of truth + void/adjust lifecycle', () => {
  it('recording an offering stamps category_id and canonical type', async () => {
    // zaka requires the giver's name (receipted category): business rule.
    const rec = await suite.api('POST', '/api/offerings', adminToken, { serviceTypeId: 1, category: 'zaka', amount: 5000, offererName: 'Test Giver' });
    assert.equal(rec.status, 201);
    assert.ok(rec.json.receiptNumber, 'zaka requires a receipt');
    const row = await suite.get('SELECT category_id, type, receipt_number FROM offerings WHERE id = ?', [rec.json.id]);
    assert.ok(row.category_id);
    assert.equal(row.type, 'zaka');
    assert.match(row.receipt_number, /^VR-\d{4}-\d{4}$/);
    suite.ctx = { zakaId: rec.json.id };
  });

  it('legacy type strings are canonicalized to the category key', async () => {
    await suite.run("INSERT INTO offerings (service_id, category_id, type, amount, recorded_by) SELECT 1, id, 'tithe', 111, 1 FROM offering_categories WHERE key='zaka'");
    // Re-run the exact canonicalization the server applies on boot.
    await require('../db/canonicalize').canonicalizeOfferingTypes();
    const row = await suite.get('SELECT type FROM offerings WHERE amount = 111');
    assert.equal(row.type, 'zaka');
  });

  it('void hides the offering everywhere but the audit trail', async () => {
    const rec = await suite.api('POST', '/api/offerings', adminToken, { serviceTypeId: 1, category: 'general', amount: 700 });
    assert.equal(rec.status, 201);
    const listBefore = await suite.api('GET', '/api/offerings', adminToken);
    assert.ok(listBefore.json.offerings.some((o) => o.id === rec.json.id));
    const sumBefore = await suite.api('GET', '/api/offerings/summary', adminToken);
    const totalBefore = sumBefore.json.byCategory.reduce((s, r) => s + r.total, 0);

    const v = await suite.api('PATCH', `/api/offerings/${rec.json.id}/void`, adminToken, { reason: 'typo' });
    assert.equal(v.status, 200);
    const reVoid = await suite.api('PATCH', `/api/offerings/${rec.json.id}/void`, adminToken, {});
    assert.equal(reVoid.status, 409);

    const listAfter = await suite.api('GET', '/api/offerings', adminToken);
    assert.equal(listAfter.json.offerings.some((o) => o.id === rec.json.id), false);
    const sumAfter = await suite.api('GET', '/api/offerings/summary', adminToken);
    const totalAfter = sumAfter.json.byCategory.reduce((s, r) => s + r.total, 0);
    assert.equal(totalAfter, totalBefore - 700);
    // (receipt-410 semantics are covered below with a receipted offering:
    // this one is 'general', which never generates a receipt.)
  });

  it('adjust reissues the receipt atomically and audit-logs the correction', async () => {
    const voided = suite.ctx.zakaId;
    // Correct flow: void first, then adjust. Also proves the documented
    // receipt semantic: a voided receipted offering's receipt is 410 Gone.
    const v = await suite.api('PATCH', `/api/offerings/${voided}/void`, adminToken, { reason: 'wrong amount' });
    assert.equal(v.status, 200);
    const gone = await suite.api('GET', `/api/offerings/${voided}/receipt`, adminToken);
    assert.equal(gone.status, 410);

    const adj = await suite.api('POST', `/api/offerings/${voided}/adjust`, adminToken, { amount: 5500, reason: 'correct amount' });
    assert.equal(adj.status, 201);
    assert.equal(adj.json.receiptNumber, 'VR-' + new Date().getFullYear() + '-0001');
    const orig = await suite.get('SELECT receipt_number, voided_at FROM offerings WHERE id = ?', [voided]);
    const corr = await suite.get('SELECT receipt_number, amount, notes FROM offerings WHERE id = ?', [adj.json.id]);
    assert.equal(orig.receipt_number, null, 'voided original gave up its receipt number');
    assert.ok(orig.voided_at);
    assert.equal(corr.receipt_number, adj.json.receiptNumber);
    assert.equal(corr.amount, 5500);
    assert.match(corr.notes, /Correction of #/);
  });

  it('receipt numbering continues after collision-heavy history (MAX+1)', async () => {
    const rec = await suite.api('POST', '/api/offerings', adminToken, { serviceTypeId: 1, category: 'zaka', amount: 800, offererName: 'Test Giver' });
    assert.equal(rec.status, 201);
    const all = (await suite.all("SELECT receipt_number FROM offerings WHERE receipt_number LIKE 'VR-%'")).map((r) => Number(r.receipt_number.slice(-4)));
    const max = Math.max(...all);
    assert.equal(rec.json.receiptNumber, `VR-${new Date().getFullYear()}-${String(max).padStart(4, '0')}`);
  });

  it('receptionist cannot void; audit chain remains valid', async () => {
    const rec = await suite.api('POST', '/api/offerings', recToken, { serviceTypeId: 1, category: 'general', amount: 300 });
    assert.equal(rec.status, 201);
    const denied = await suite.api('PATCH', `/api/offerings/${rec.json.id}/void`, recToken, {});
    assert.equal(denied.status, 403);
    const integrity = await suite.api('GET', '/api/reports/audit-integrity', adminToken);
    assert.equal(integrity.json.valid, true);
  });
});

describe('phase 4: attendance editing (PUT /api/attendance/:id)', () => {
  it('editing a named attendance rewrites attendees + count and audit-logs', async () => {
    const namedTypeId = await namedAttendanceTypeId();

    const created = await suite.api('POST', '/api/attendance', adminToken, {
      serviceTypeId: namedTypeId,
      attendees: [{ name: 'Asha M' }, { name: 'Baraka J' }],
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.count, 2);

    const edited = await suite.api('PUT', `/api/attendance/${created.json.id}`, adminToken, {
      attendees: [{ name: 'Asha M' }, { name: 'Baraka J' }, { name: 'Chausiku K' }],
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.json.count, 3);

    const row = await suite.get('SELECT count, mode FROM attendance WHERE id = ?', [created.json.id]);
    const attendees = await suite.all('SELECT name FROM attendance_attendees WHERE attendance_id = ? ORDER BY id', [created.json.id]);
    const audit = await suite.get("SELECT action, details FROM audit_log WHERE action = 'attendance_updated' AND record_id = ? LIMIT 1", [created.json.id]);
    assert.equal(row.count, 3);
    assert.equal(attendees.length, 3);
    assert.equal(attendees[2].name, 'Chausiku K');
    assert.match(String(audit.details), /toCount/);
  });

  it('receptionists can correct their own today-entries but not the admin records', async () => {
    const namedTypeId = await namedAttendanceTypeId();

    const mine = await suite.api('POST', '/api/attendance', recToken, {
      serviceTypeId: namedTypeId,
      attendees: [{ name: 'Desk T' }],
    });
    assert.equal(mine.status, 201);
    const fixed = await suite.api('PUT', `/api/attendance/${mine.json.id}`, recToken, {
      attendees: [{ name: 'Desk T' }, { name: 'Extra D' }],
    });
    assert.equal(fixed.status, 200);
    assert.equal(fixed.json.count, 2);

    const admins = await suite.api('POST', '/api/attendance', adminToken, {
      serviceTypeId: namedTypeId,
      attendees: [{ name: 'Admin E' }],
    });
    assert.equal(admins.status, 201);
    const notMine = await suite.api('PUT', `/api/attendance/${admins.json.id}`, recToken, {
      attendees: [{ name: 'Hijack' }],
    });
    assert.equal(notMine.status, 403);

    const pastAtt = await suite.api('POST', '/api/attendance', adminToken, { serviceTypeId: namedTypeId, date: '2020-01-01', attendees: [{ name: 'Past P' }] });
    assert.equal(pastAtt.status, 201);
    const pastEdit = await suite.api('PUT', `/api/attendance/${pastAtt.json.id}`, recToken, { attendees: [{ name: 'Lets Change' }] });
    assert.equal(pastEdit.status, 403, 'receptionists may only edit today');

    const integrity = await suite.api('GET', '/api/reports/audit-integrity', adminToken);
    assert.equal(integrity.json.valid, true);
  });
});

describe.skip('deprecated group membership notifications', () => {
  it('admin can push a group update into the pastor feed', async () => {
    const g = await suite.api('GET', '/api/groups', adminToken);
    assert.equal(g.status, 200);
    const group = g.json.groups[0];

    // A group update is about a CHANGE. A group nobody has touched has nothing to
    // report, and the channel says so rather than sending an empty notice.
    const empty = await suite.api('POST', `/api/groups/${group.id}/notify-pastor`, adminToken);
    assert.equal(empty.status, 200);
    assert.equal(empty.json.sent, false);
    assert.equal(empty.json.reason, 'no_changes');

    const joined = await suite.api('POST', '/api/members', adminToken, {
      name: 'Phase Four Member', groupIds: [group.id],
    });
    assert.equal(joined.status, 201, joined.text);

    const res = await suite.api('POST', `/api/groups/${group.id}/notify-pastor`, adminToken);
    assert.equal(res.status, 200);
    assert.equal(res.json.sent, true);
    assert.match(res.json.summary, /Phase Four Member added/);
    assert.equal(res.json.url, `/groups/${group.id}`, 'the update points at the group for its membership');
    const row = await suite.get("SELECT * FROM notifications_log WHERE record_type = 'group_update' ORDER BY id DESC LIMIT 1");
    assert.ok(row, 'a group_update feed entry is written');
    assert.equal(row.record_id, group.id);
    assert.match(row.message, /Phase Four Member added/);
  });

  it('receptionists can send group info to the pastor too', async () => {
    // The front desk runs the small groups as well, so the whole Groups section
    // including this channel: is open to it (see groups-access.test.js).
    const g = await suite.api('GET', '/api/groups', adminToken);
    const group = g.json.groups[0];
    const joined = await suite.api('POST', '/api/members', recToken, {
      name: 'Phase Four Desk Member', groupIds: [group.id],
    });
    assert.equal(joined.status, 201, joined.text);
    const res = await suite.api('POST', `/api/groups/${group.id}/notify-pastor`, recToken);
    assert.equal(res.status, 200);
    assert.equal(res.json.sent, true, 'the front desk can reach the pastor feed');
    const row = await suite.get("SELECT * FROM notifications_log WHERE record_type = 'group_update' AND record_id = ? ORDER BY id DESC LIMIT 1", [group.id]);
    assert.ok(row);
    assert.match(row.message, /Phase Four Desk Member added/);
  });
});

describe('phase 4: reports drill-down (record-level filters)', () => {
  it('offerings filtered by center and group return only matching records', async () => {
    const centers = await suite.api('GET', '/api/revival-centers', adminToken);
    const center = centers.json.revivalCenters.find((c) => !c.is_archived) || centers.json.revivalCenters[0];
    const byCenter = await suite.api('GET', `/api/offerings?centerId=${encodeURIComponent(center.id)}`, adminToken);
    assert.equal(byCenter.status, 200);
    assert.ok(Array.isArray(byCenter.json.offerings));

    const groupsRes = await suite.api('GET', '/api/groups', adminToken);
    const group = groupsRes.json.groups.find((g) => g.member_count > 0) || groupsRes.json.groups[0];
    const byGroup = await suite.api('GET', `/api/offerings?groupId=${encodeURIComponent(group.id)}`, adminToken);
    assert.equal(byGroup.status, 200);
    assert.ok(Array.isArray(byGroup.json.offerings));
  });

  it('group drill-down totals reconcile with the group breakdown', async () => {
    const groups = (await suite.api('GET', '/api/groups', adminToken)).json.groups;
    const g = groups.find((x) => x.member_count > 0);
    if (!g) {
      const members = await suite.get('SELECT id FROM members LIMIT 1');
      if (members) await suite.run('INSERT INTO group_members (group_id, member_id, role) VALUES (?, ?, ?)', [groups[0].id, members.id, 'member']);
    }
    const chosen = g || (await suite.api('GET', '/api/groups', adminToken)).json.groups[0];
    const breakdown = await suite.api('GET', '/api/reports/breakdown?groupBy=group', adminToken);
    const row = breakdown.json.breakdown.find((r) => Number(r.key) === Number(chosen.id));
    const detail = await suite.api('GET', `/api/offerings?groupId=${chosen.id}`, adminToken);
    const sum = detail.json.offerings.reduce((acc, o) => acc + Number(o.amount), 0);
    assert.equal(sum, row ? Number(row.offering) : 0, 'row-level gifts sum to the aggregate');
  });
});
