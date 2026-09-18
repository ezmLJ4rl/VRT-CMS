'use strict';
/**
 * Special projects.
 *
 * The point of these tests is that the numbers cannot lie to a congregation:
 *   - raised is the offering ledger, not a parallel tally (link a gift, watch it
 *     move), and only money actually received counts;
 *   - pledged-but-unpaid money is reported apart from raised, and a pledge's
 *     fulfilment is tracked per pledge;
 *   - debts split into already spent and still owed, so net position can be
 *     stated rather than gross raised;
 *   - the arrangement is coarse-grained: admin/superadmin write, the pastor
 *     reads, and the front desk sees only the list it needs to file a gift.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'projects', port: 4611 });

const ADMIN = { email: 'superadmin@victoryrevival.church', password: 'TestPass_123!' };
const PASTOR = { email: 'pastor@victoryrevival.church', password: 'TestPass_123!' };

let adminToken;
let pastorToken;
let deskToken;
let sundayId;
let today;

async function newProject(body = {}) {
  const res = await suite.api('POST', '/api/projects', adminToken, {
    name: 'Ujenzi wa Ukuta',
    description: 'Perimeter wall for the Mbezi Juu plot',
    status: 'active',
    startedOn: '2026-01-05',
    targetOn: '2026-12-20',
    goalAmount: 10000000,
    currency: 'TZS',
    ...body,
  });
  assert.equal(res.status, 201, res.text);
  return res.json.id;
}

async function detail(id, token = adminToken) {
  const res = await suite.api('GET', `/api/projects/${id}`, token);
  assert.equal(res.status, 200, res.text);
  return res.json;
}

describe('special projects', () => {
  before(async () => {
    await suite.waitReady();
    adminToken = (await suite.api('POST', '/api/auth/login', null, ADMIN)).json.token;
    pastorToken = (await suite.api('POST', '/api/auth/login', null, PASTOR)).json.token;

    const created = await suite.api('POST', '/api/users', adminToken, {
      name: 'Projects Desk', email: 'projects.desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    assert.equal(created.status, 201, created.text);
    deskToken = (await suite.api('POST', '/api/auth/login', null, { email: 'projects.desk@test.local', password: 'DeskPass_123!' })).json.token;

    const { json: types } = await suite.api('GET', '/api/service-types', adminToken);
    sundayId = types.serviceTypes.find((s) => s.key === 'sunday_1').id;
    today = (await suite.api('GET', '/api/time', adminToken)).json.date;
  });

  after(() => suite.stop());

  it('requires a name, a valid status, a currency and a non-negative goal', async () => {
    const noName = await suite.api('POST', '/api/projects', adminToken, { name: '  ', goalAmount: 100 });
    assert.equal(noName.status, 400);
    // The API answers in prose, not keys (middleware/locale.js translates the
    // key the route returns), so these assert what a client actually reads.
    assert.equal(noName.json.error, 'A project name is required.');

    const badStatus = await suite.api('POST', '/api/projects', adminToken, { name: 'X', status: 'paused', goalAmount: 100 });
    assert.equal(badStatus.status, 400);
    assert.equal(badStatus.json.error, 'Status must be active, on hold or completed.');

    const negative = await suite.api('POST', '/api/projects', adminToken, { name: 'X', goalAmount: -5 });
    assert.equal(negative.status, 400);
    assert.equal(negative.json.error, 'The funding goal must be zero or a positive number.');

    const backwards = await suite.api('POST', '/api/projects', adminToken, {
      name: 'X', goalAmount: 100, startedOn: '2026-05-01', targetOn: '2026-04-01',
    });
    assert.equal(backwards.status, 400);
    assert.equal(backwards.json.error, 'The target date cannot be before the start date.');
  });

  it('starts at zero and reports the goal, so an empty project reads honestly', async () => {
    const id = await newProject({ name: 'Empty Project' });
    const { summary, timeline } = await detail(id);

    assert.equal(summary.raised, 0);
    assert.equal(summary.goalAmount, 10000000);
    assert.equal(summary.remainingToGoal, 10000000);
    assert.equal(summary.fundedPct, 0);
    assert.equal(summary.pledged, 0);
    assert.equal(summary.pledgePct, null, 'no pledges means no percentage to state, not 0%');
    assert.equal(summary.netPosition, 0);
    assert.equal(timeline.startedOn, '2026-01-05');
    assert.ok(timeline.elapsedDays > 0);
    assert.equal(typeof timeline.remainingDays, 'number');
  });

  it('raised is the offering ledger: a linked gift moves the figure', async () => {
    const id = await newProject({ name: 'Ledger Project' });

    const gift = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: sundayId, date: today, category: 'special', amount: 400000, currency: 'TZS',
      projectId: id, offererName: 'Elia Makala',
    });
    assert.equal(gift.status, 201, gift.text);

    const after = await detail(id);
    assert.equal(after.summary.raised, 400000);
    assert.equal(after.giftCount, 1);
    assert.equal(after.contributions[0].giverName, 'Elia Makala', 'the project ledger names the giver');
    assert.equal(after.contributions[0].amount, 400000);

    // The gift is the same row as the offering ledger, not a copy.
    const row = await suite.get('SELECT project_id, project_name FROM offerings WHERE id = ?', [gift.json.id]);
    assert.equal(row.project_id, id);
    assert.equal(row.project_name, 'Ledger Project', 'the receipt prints the project name, not free text');

    // …and voiding it takes the money back off the project.
    const voided = await suite.api('PATCH', `/api/offerings/${gift.json.id}/void`, adminToken, { reason: 'test' });
    assert.equal(voided.status, 200, voided.text);
    assert.equal((await detail(id)).summary.raised, 0, 'a voided gift must not fund a project');
  });

  it('adopts special offerings that were filed under the same name before projects existed', async () => {
    const legacy = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: sundayId, date: today, category: 'special', amount: 250000, currency: 'TZS',
      projectName: 'Legacy Roof Fund',
    });
    assert.equal(legacy.status, 201, legacy.text);
    assert.equal((await suite.get('SELECT project_id FROM offerings WHERE id = ?', [legacy.json.id])).project_id, null);

    const id = await newProject({ name: 'Legacy Roof Fund', goalAmount: 2000000 });
    const after = await detail(id);
    assert.equal(after.summary.raised, 250000, 'the project starts with its real history, not zero');
  });

  it('rejects a gift pointed at a project that does not exist', async () => {
    const res = await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: sundayId, date: today, category: 'special', amount: 1000, projectId: 999999,
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, 'Project not found.');
  });

  it('a pledge is promised money and never counts as raised', async () => {
    const id = await newProject({ name: 'Pledge Project', goalAmount: 1000000 });

    const pledge = await suite.api('POST', `/api/projects/${id}/pledges`, adminToken, {
      name: 'Neema Joseph', amount: 300000, pledgedOn: today,
    });
    assert.equal(pledge.status, 201, pledge.text);

    const after = await detail(id);
    assert.equal(after.summary.raised, 0, 'a promise is not money in hand');
    assert.equal(after.summary.pledged, 300000);
    assert.equal(after.summary.pledgeFulfilled, 0);
    assert.equal(after.summary.pledgeOutstanding, 300000);
    assert.equal(after.summary.pledgePct, 0);
    assert.equal(after.summary.fundedPct, 0, '…and it must not move the funding bar');

    // A payment against the pledge moves fulfilment, not raised.
    const paid = await suite.api('PATCH', `/api/projects/${id}/pledges/${pledge.json.id}`, adminToken, { addFulfilled: 120000 });
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.json.fulfilledAmount, 120000);
    assert.equal(paid.json.status, 'open');

    const midway = await detail(id);
    assert.equal(midway.summary.pledgeFulfilled, 120000);
    assert.equal(midway.summary.pledgePct, 40);
    assert.equal(midway.pledges[0].outstanding, 180000);
    assert.equal(midway.summary.raised, 0);

    // Paying it off closes the pledge by itself.
    const rest = await suite.api('PATCH', `/api/projects/${id}/pledges/${pledge.json.id}`, adminToken, { addFulfilled: 180000 });
    assert.equal(rest.json.status, 'fulfilled');
    assert.equal((await detail(id)).summary.pledgePct, 100);

    const overpay = await suite.api('PATCH', `/api/projects/${id}/pledges/${pledge.json.id}`, adminToken, { addFulfilled: 1 });
    assert.equal(overpay.status, 400);
    assert.equal(overpay.json.error, 'A pledge cannot be fulfilled by more than the amount pledged.');
  });

  it('debts separate what is spent from what is still owed, and net position follows', async () => {
    const id = await newProject({ name: 'Debt Project', goalAmount: 1000000 });
    await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: sundayId, date: today, category: 'special', amount: 600000, currency: 'TZS', projectId: id,
    });

    const cement = await suite.api('POST', `/api/projects/${id}/debts`, adminToken, {
      description: 'Cement supplier, final batch', amount: 200000,
    });
    assert.equal(cement.status, 201, cement.text);
    const labour = await suite.api('POST', `/api/projects/${id}/debts`, adminToken, {
      description: 'Mason labour', amount: 150000, status: 'paid',
    });
    assert.equal(labour.status, 201, labour.text);

    const after = await detail(id);
    assert.equal(after.summary.raised, 600000);
    assert.equal(after.summary.spent, 150000);
    assert.equal(after.summary.owed, 200000);
    assert.equal(after.summary.netPosition, 250000, 'raised − spent − owed');
    assert.equal(after.summary.remainingToGoal, 400000);
    assert.equal(after.summary.netRemainingNeed, 600000, 'the gap to the goal plus the debts to clear');

    // Settling the debt moves it from owed to spent without changing either.
    await suite.api('PATCH', `/api/projects/${id}/debts/${cement.json.id}`, adminToken, { status: 'paid' });
    const settled = await detail(id);
    assert.equal(settled.summary.owed, 0);
    assert.equal(settled.summary.spent, 350000);
    assert.equal(settled.summary.netPosition, 250000);
  });

  it('rolls repeat givers up by person, not by ciphertext', async () => {
    const id = await newProject({ name: 'Rollup Project' });
    for (const amount of [100000, 50000, 25000]) {
      const res = await suite.api('POST', '/api/offerings', adminToken, {
        serviceTypeId: sundayId, date: today, category: 'special', amount, currency: 'TZS',
        projectId: id, offererName: 'Elisha Makala',
      });
      assert.equal(res.status, 201, res.text);
    }
    // A second, differently named giver must stay a separate line.
    await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: sundayId, date: today, category: 'special', amount: 70000, currency: 'TZS',
      projectId: id, offererName: 'Elizabeth Makala',
    });

    const { contributors, summary } = await detail(id);
    assert.equal(summary.raised, 245000);
    const elisha = contributors.find((c) => c.name === 'Elisha Makala');
    assert.equal(elisha.times, 3, 'three gifts from one person is one contributor, not three');
    assert.equal(elisha.total, 175000);
    assert.equal(contributors.length, 2);
    assert.equal(contributors[0].name, 'Elisha Makala', 'biggest total first');
  });

  it('buckets contributions per month for the funding chart', async () => {
    const id = await newProject({ name: 'Trend Project' });
    await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: sundayId, date: today, category: 'special', amount: 90000, currency: 'TZS', projectId: id,
    });
    const { monthly } = await detail(id);
    assert.equal(monthly.length, 1);
    assert.equal(monthly[0].label, today.slice(0, 7));
    assert.equal(monthly[0].value, 90000);
  });

  it('never adds a second currency into the project total', async () => {
    const id = await newProject({ name: 'Currency Project', goalAmount: 1000000, currency: 'TZS' });
    await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: sundayId, date: today, category: 'special', amount: 500000, currency: 'TZS', projectId: id,
    });
    await suite.api('POST', '/api/offerings', adminToken, {
      serviceTypeId: sundayId, date: today, category: 'special', amount: 200, currency: 'USD', projectId: id,
    });

    const after = await detail(id);
    assert.equal(after.summary.raised, 500000, '200 USD is not 200 shillings');
    assert.deepEqual(after.otherCurrencies, [{ currency: 'USD', raised: 200, pledged: 0, spent: 0, owed: 0 }]);
  });

  it('lists projects with progress, active first', async () => {
    const { status, json } = await suite.api('GET', '/api/projects', adminToken);
    assert.equal(status, 200, json && json.error);
    assert.ok(json.projects.length >= 6);
    // Active work first, then on hold, then finished, never interleaved.
    const rank = { active: 0, on_hold: 1, completed: 2 };
    const ranks = json.projects.map((p) => rank[p.status]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    const active = json.projects.find((p) => p.name === 'Rollup Project');
    assert.equal(active.raised, 245000);

    // A project with no goal has nothing to be a percentage of, and the list
    // must say so rather than divide by zero.
    await newProject({ name: 'No Goal Project', goalAmount: 0 });
    const noGoal = (await suite.api('GET', '/api/projects', adminToken)).json.projects.find((p) => p.name === 'No Goal Project');
    assert.equal(noGoal.fundedPct, null);
    assert.equal(noGoal.remainingToGoal, 0);
  });

  it('the pastor reads progress but cannot change it', async () => {
    const id = await newProject({ name: 'Pastor View Project', goalAmount: 5000000 });
    const view = await suite.api('GET', `/api/projects/${id}`, pastorToken);
    assert.equal(view.status, 200, view.text);
    assert.equal(view.json.canEdit, false);
    assert.equal(view.json.summary.goalAmount, 5000000);

    const write = await suite.api('POST', `/api/projects/${id}/pledges`, pastorToken, { name: 'X', amount: 1000 });
    assert.equal(write.status, 403, write.text);
    const edit = await suite.api('PATCH', `/api/projects/${id}`, pastorToken, { name: 'Renamed' });
    assert.equal(edit.status, 403, edit.text);
  });

  it('the front desk sees the list it needs to file a gift, and nothing more', async () => {
    const list = await suite.api('GET', '/api/projects', deskToken);
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.projects.some((p) => p.name === 'Pastor View Project'));

    const id = list.json.projects[0].id;
    const detailRes = await suite.api('GET', `/api/projects/${id}`, deskToken);
    assert.equal(detailRes.status, 403, 'the ledger and pledges are not the front desk\'s to read');

    const write = await suite.api('POST', '/api/projects', deskToken, { name: 'Front Desk Project', goalAmount: 1 });
    assert.equal(write.status, 403);
  });

  it('editing the record changes what the page states', async () => {
    const id = await newProject({ name: 'Editable Project', goalAmount: 1000000 });
    const res = await suite.api('PATCH', `/api/projects/${id}`, adminToken, {
      name: 'Editable Project (renamed)', goalAmount: 2000000, status: 'on_hold', targetOn: '2027-03-01',
    });
    assert.equal(res.status, 200, res.text);

    const after = await detail(id);
    assert.equal(after.project.name, 'Editable Project (renamed)');
    assert.equal(after.project.status, 'on_hold');
    assert.equal(after.summary.goalAmount, 2000000);
    assert.equal(after.project.targetOn, '2027-03-01');
  });

  it('every write lands in the audit trail', async () => {
    const rows = await suite.all("SELECT action FROM audit_log WHERE table_affected IN ('projects','project_pledges','project_debts') ORDER BY id");
    const actions = new Set(rows.map((r) => r.action));
    for (const expected of ['project_created', 'project_updated', 'project_pledge_recorded', 'project_pledge_updated', 'project_debt_recorded', 'project_debt_updated']) {
      assert.ok(actions.has(expected), `${expected} must be audit-logged`);
    }
  });
});
