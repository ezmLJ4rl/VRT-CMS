const express = require('express');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { encryptField } = require('../utils/crypto');
const { readDonorField, canViewDonorData } = require('../utils/donorFields');
const { logAudit } = require('../utils/audit');
const { todayISO } = require('../utils/date');

const router = express.Router();
router.use(authenticate);

const PROJECT_STATUSES = new Set(['active', 'on_hold', 'completed']);
const PLEDGE_STATUSES = new Set(['open', 'fulfilled', 'cancelled']);
const DEBT_STATUSES = new Set(['outstanding', 'paid']);

/*
 * Special projects.
 *
 * A project's raised figure is NOT a separate tally: it is the sum of the
 * offerings linked to it (offerings.project_id), so the number here is the same
 * money that appears in the offering ledger, on the receipts and in the
 * reports. Pledges and debts are tracked beside it and never folded into it:
 * promised money is not money in hand, which is why the API returns them as
 * separate totals and the client draws them as separate indicators.
 *
 * Money is summed per currency and reported in the project's own currency (the
 * one its goal is denominated in); anything in another currency is returned
 * under `otherCurrencies` rather than being silently added to it.
 */

function num(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function daysBetween(fromISO, toISO) {
  if (!fromISO || !toISO) return null;
  const from = Date.parse(`${String(fromISO).slice(0, 10)}T12:00:00Z`);
  const to = Date.parse(`${String(toISO).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86400000);
}

function pct(part, whole) {
  if (!whole || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * The health block: everything a glance needs, all of it derived from the three
 * ledgers rather than stored, so it can never drift from them.
 */
function summarise({ currency, goalAmount, raised, pledged, pledgeFulfilled, spent, owed }) {
  const remainingToGoal = Math.max(0, goalAmount - raised);
  return {
    currency,
    goalAmount,
    raised,
    remainingToGoal,
    fundedPct: pct(raised, goalAmount),
    // Promised but not yet received.
    pledged,
    pledgeFulfilled,
    pledgeOutstanding: Math.max(0, pledged - pledgeFulfilled),
    pledgePct: pct(pledgeFulfilled, pledged),
    spent,
    owed,
    // Money actually in hand once what has been spent and what is owed is taken
    // out: the number gross "raised" hides.
    netPosition: raised - spent - owed,
    // What still has to be found: the gap to the goal plus the debts to clear.
    netRemainingNeed: remainingToGoal + owed,
  };
}

function timeline(project) {
  const today = todayISO();
  const started = project.started_on || null;
  const target = project.target_on || null;
  const totalDays = started && target ? daysBetween(started, target) : null;
  const elapsedDays = started ? daysBetween(started, today) : null;
  const remainingDays = target ? daysBetween(today, target) : null;
  let elapsedPct = null;
  if (totalDays && totalDays > 0 && elapsedDays !== null) {
    elapsedPct = Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 1000) / 10));
  }
  return {
    today,
    startedOn: started,
    targetOn: target,
    totalDays,
    elapsedDays,
    remainingDays,
    elapsedPct,
    overdue: !!(target && remainingDays !== null && remainingDays < 0 && project.status !== 'completed'),
  };
}

// ---------------------------------------------------------------- list

// GET /api/projects: every project with its progress, newest activity first.
// Readable by the pastor (progress) and by the front desk (they file a special
// offering against a project, so they need the names); writes are admin-only.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*,
              (SELECT COALESCE(SUM(o.amount), 0) FROM offerings o
                WHERE o.project_id = p.id AND o.voided_at IS NULL AND o.currency = p.currency) AS raised,
              (SELECT COUNT(*) FROM offerings o
                WHERE o.project_id = p.id AND o.voided_at IS NULL AND o.currency = p.currency) AS gifts,
              (SELECT COALESCE(SUM(pl.amount), 0) FROM project_pledges pl
                WHERE pl.project_id = p.id AND pl.status <> 'cancelled' AND pl.currency = p.currency) AS pledged,
              (SELECT COALESCE(SUM(pl.fulfilled_amount), 0) FROM project_pledges pl
                WHERE pl.project_id = p.id AND pl.status <> 'cancelled' AND pl.currency = p.currency) AS pledge_fulfilled,
              (SELECT COALESCE(SUM(d.amount), 0) FROM project_debts d
                WHERE d.project_id = p.id AND d.status = 'outstanding' AND d.currency = p.currency) AS owed,
              (SELECT COALESCE(SUM(d.amount), 0) FROM project_debts d
                WHERE d.project_id = p.id AND d.status = 'paid' AND d.currency = p.currency) AS spent
         FROM projects p
        ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END,
                 COALESCE(p.started_on, p.created_at) DESC, p.id DESC`
    );

    const projects = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      status: r.status,
      startedOn: r.started_on,
      targetOn: r.target_on,
      currency: r.currency,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      gifts: Number(r.gifts || 0),
      timeline: timeline(r),
      ...summarise({
        currency: r.currency,
        goalAmount: num(r.goal_amount),
        raised: num(r.raised),
        pledged: num(r.pledged),
        pledgeFulfilled: num(r.pledge_fulfilled),
        spent: num(r.spent),
        owed: num(r.owed),
      }),
    }));

    res.json({ projects });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadProjects' });
  }
});

// ---------------------------------------------------------------- detail

async function loadProject(id) {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  return rows[0] || null;
}

// GET /api/projects/:id, the project page: health, timeline, ledger,
// contributor rollup, pledges and debts.
// Deliberately narrower than the list: the front desk gets the names it needs to
// file a gift, not the named giving records, pledges and debts. Aggregates are
// safe to show; who gave what is not. Editing is narrower still (`canEdit`).
router.get('/:id', requireRole('admin', 'superadmin', 'pastor'), async (req, res) => {
  try {
    const project = await loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'errors.projectNotFound' });

    const [contributions, pledges, debts] = await Promise.all([
      pool.query(
        `SELECT o.id, o.amount, o.currency, o.member_id, o.offerer_name_enc, o.project_name,
                o.receipt_number, o.notes, s.name AS service_name, s.date AS service_date,
                st.name AS service_type_name, u.name AS recorded_by_name
           FROM offerings o
           JOIN services s ON s.id = o.service_id
           LEFT JOIN service_types st ON st.id = s.service_type_id
           LEFT JOIN users u ON u.id = o.recorded_by
          WHERE o.project_id = $1 AND o.voided_at IS NULL
          ORDER BY s.date DESC, o.id DESC`,
        [project.id]
      ),
      pool.query(
        `SELECT pl.*, m.name AS member_name, m.member_no
           FROM project_pledges pl
           LEFT JOIN members m ON m.id = pl.member_id
          WHERE pl.project_id = $1
          ORDER BY CASE pl.status WHEN 'open' THEN 0 WHEN 'fulfilled' THEN 1 ELSE 2 END, pl.id DESC`,
        [project.id]
      ),
      pool.query('SELECT * FROM project_debts WHERE project_id = $1 ORDER BY status, id DESC', [project.id]),
    ]);

    const canSeeGivers = ['admin', 'pastor', 'superadmin'].includes(req.user.role);

    const ledger = contributions.rows.map((r) => {
      const readable = canViewDonorData(req.user, r) && canSeeGivers;
      const name = readable
        ? readDonorField(r.offerer_name_enc, { table: 'offerings', id: r.id, field: 'offerer_name_enc' })
        : { value: null, unreadable: false };
      return {
        id: r.id,
        amount: num(r.amount),
        currency: r.currency,
        date: r.service_date,
        service: r.service_name,
        serviceType: r.service_type_name,
        receiptNumber: r.receipt_number,
        notes: r.notes,
        memberId: r.member_id,
        memberName: readable ? r.member_name || null : null,
        giverName: name.value,
        giverNameUnavailable: name.unreadable,
      };
    });

    // Repeat givers, counted by identity rather than by ciphertext: every
    // encryption of a name uses a fresh IV, so grouping on the stored value
    // would treat each gift as a new person.
    const rollupMap = new Map();
    for (const c of ledger) {
      if (c.currency !== project.currency) continue;
      const key = c.memberId ? `m:${c.memberId}` : c.giverName ? `n:${c.giverName.trim().toLowerCase()}` : 'anonymous';
      const entry = rollupMap.get(key) || {
        key,
        name: c.giverName || c.memberName || null,
        member: !!c.memberId,
        times: 0,
        total: 0,
        lastDate: null,
      };
      entry.times += 1;
      entry.total += c.amount;
      if (!entry.lastDate || (c.date && c.date > entry.lastDate)) entry.lastDate = c.date;
      if (!entry.name && (c.giverName || c.memberName)) entry.name = c.giverName || c.memberName;
      rollupMap.set(key, entry);
    }
    const contributors = [...rollupMap.values()]
      .filter((c) => c.key !== 'anonymous')
      .sort((a, b) => b.total - a.total);

    const pledgeRows = pledges.rows.map((p) => {
      const stored = canSeeGivers
        ? readDonorField(p.pledge_name_enc, { table: 'project_pledges', id: p.id, field: 'pledge_name_enc' })
        : { value: null, unreadable: false };
      return {
        id: p.id,
        memberId: p.member_id,
        memberName: p.member_name || null,
        pledgeName: stored.value,
        pledgeNameUnavailable: stored.unreadable,
        amount: num(p.amount),
        fulfilledAmount: num(p.fulfilled_amount),
        outstanding: Math.max(0, num(p.amount) - num(p.fulfilled_amount)),
        fulfilmentPct: pct(num(p.fulfilled_amount), num(p.amount)),
        currency: p.currency,
        pledgedOn: p.pledged_on,
        status: p.status,
        notes: p.notes,
      };
    });

    const debtRows = debts.rows.map((d) => ({
      id: d.id,
      description: d.description,
      amount: num(d.amount),
      currency: d.currency,
      status: d.status,
      incurredOn: d.incurred_on,
      paidOn: d.paid_on,
      notes: d.notes,
    }));

    const inProjectCurrency = (rows) => rows.filter((r) => (r.currency || 'TZS') === project.currency);
    const currencies = new Set([
      ...ledger.map((c) => c.currency),
      ...pledgeRows.map((p) => p.currency),
      ...debtRows.map((d) => d.currency),
    ]);
    currencies.delete(project.currency);
    const otherCurrencies = [...currencies].map((currency) => ({
      currency,
      raised: ledger.filter((c) => c.currency === currency).reduce((s, c) => s + c.amount, 0),
      pledged: pledgeRows
        .filter((p) => p.currency === currency && p.status !== 'cancelled')
        .reduce((s, p) => s + p.amount, 0),
      spent: debtRows.filter((d) => d.currency === currency && d.status === 'paid').reduce((s, d) => s + d.amount, 0),
      owed: debtRows.filter((d) => d.currency === currency && d.status === 'outstanding').reduce((s, d) => s + d.amount, 0),
    }));

    // Contributions per month, in the project currency: the funding trend.
    const monthBuckets = new Map();
    for (const c of inProjectCurrency(ledger)) {
      const label = String(c.date || '').slice(0, 7);
      if (!label) continue;
      monthBuckets.set(label, (monthBuckets.get(label) || 0) + c.amount);
    }
    const monthly = [...monthBuckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, value]) => ({ label, value }));

    const raised = inProjectCurrency(ledger).reduce((s, c) => s + c.amount, 0);
    const activePledges = pledgeRows.filter((p) => p.status !== 'cancelled');
    const pledgesActive = activePledges.filter((p) => p.currency === project.currency);
    const debtsInCurrency = debtRows.filter((d) => d.currency === project.currency);

    res.json({
      project: {
        id: project.id,
        name: project.name,
        description: project.description,
        status: project.status,
        startedOn: project.started_on,
        targetOn: project.target_on,
        currency: project.currency,
        goalAmount: num(project.goal_amount),
        createdAt: project.created_at,
        updatedAt: project.updated_at,
      },
      canEdit: ['admin', 'superadmin'].includes(req.user.role),
      summary: summarise({
        currency: project.currency,
        goalAmount: num(project.goal_amount),
        raised,
        pledged: pledgesActive.reduce((s, p) => s + p.amount, 0),
        pledgeFulfilled: pledgesActive.reduce((s, p) => s + p.fulfilledAmount, 0),
        spent: debtsInCurrency.filter((d) => d.status === 'paid').reduce((s, d) => s + d.amount, 0),
        owed: debtsInCurrency.filter((d) => d.status === 'outstanding').reduce((s, d) => s + d.amount, 0),
      }),
      giftCount: inProjectCurrency(ledger).length,
      timeline: timeline(project),
      contributors,
      contributions: ledger,
      monthly,
      otherCurrencies,
      pledges: pledgeRows,
      debts: debtRows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadProject' });
  }
});

// ---------------------------------------------------------------- create/update

function readProjectBody(body) {
  const name = String(body?.name || '').trim();
  const status = String(body?.status || 'active');
  const currency = String(body?.currency || 'TZS').toUpperCase();
  const goal = num(body?.goalAmount, NaN);
  return {
    name,
    description: String(body?.description || '').trim() || null,
    status,
    currency,
    goalAmount: goal,
    startedOn: body?.startedOn || null,
    targetOn: body?.targetOn || null,
  };
}

function validateProject(p, { requireGoal }) {
  if (!p.name) return 'errors.projectNameRequired';
  if (!PROJECT_STATUSES.has(p.status)) return 'errors.invalidProjectStatus';
  if (!/^[A-Z]{3}$/.test(p.currency)) return 'errors.invalidCurrency';
  if (Number.isNaN(p.goalAmount) || p.goalAmount < 0) return 'errors.goalMustBePositiveNumber';
  if (requireGoal && !(p.goalAmount > 0)) return 'errors.goalMustBePositiveNumber';
  if (p.startedOn && p.targetOn && p.targetOn < p.startedOn) return 'errors.targetBeforeStartDate';
  return null;
}

// POST /api/projects: create. Admin/superadmin only.
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const p = readProjectBody(req.body);
  const invalid = validateProject(p, { requireGoal: false });
  if (invalid) return res.status(400).json({ error: invalid });

  const client = await pool.connect();
  let id;
  let adopted = 0;
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO projects (name, description, status, started_on, target_on, goal_amount, currency, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [p.name, p.description, p.status, p.startedOn, p.targetOn, p.goalAmount, p.currency, req.user.id]
    );
    id = inserted.rows[0].id;

    // Adopt special offerings that were filed under this name before projects
    // existed, so a project starts with its real history instead of zero.
    const adopt = await client.query(
      `UPDATE offerings SET project_id = $1
        WHERE project_id IS NULL AND type = 'special'
          AND lower(btrim(COALESCE(project_name, ''))) = lower(btrim($2))
        RETURNING id`,
      [id, p.name]
    );
    adopted = adopt.rowCount;
    await client.query('COMMIT');
  } catch (txErr) {
    await client.query('ROLLBACK');
    console.error(txErr);
    return res.status(500).json({ error: 'errors.failedCreateProject' });
  } finally {
    client.release();
  }

  await logAudit({
    userId: req.user.id,
    action: 'project_created',
    table: 'projects',
    recordId: id,
    details: { name: p.name, goalAmount: p.goalAmount, currency: p.currency, adoptedOfferings: adopted },
    ip: req.ip,
  });
  res.status(201).json({ id, adoptedOfferings: adopted });
});

// PATCH /api/projects/:id: edit the record (goal, dates, status, wording).
router.patch('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const existing = await loadProject(req.params.id);
    if (!existing) return res.status(404).json({ error: 'errors.projectNotFound' });

    const p = readProjectBody({
      name: req.body?.name ?? existing.name,
      description: req.body?.description ?? existing.description,
      status: req.body?.status ?? existing.status,
      currency: req.body?.currency ?? existing.currency,
      goalAmount: req.body?.goalAmount ?? existing.goal_amount,
      startedOn: req.body?.startedOn ?? existing.started_on,
      targetOn: req.body?.targetOn ?? existing.target_on,
    });
    const invalid = validateProject(p, { requireGoal: false });
    if (invalid) return res.status(400).json({ error: invalid });

    await pool.query(
      `UPDATE projects SET name = $1, description = $2, status = $3, started_on = $4, target_on = $5,
              goal_amount = $6, currency = $7, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE id = $8`,
      [p.name, p.description, p.status, p.startedOn, p.targetOn, p.goalAmount, p.currency, existing.id]
    );

    await logAudit({
      userId: req.user.id,
      action: 'project_updated',
      table: 'projects',
      recordId: existing.id,
      details: { name: p.name, status: p.status, goalAmount: p.goalAmount },
      ip: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateProject' });
  }
});

// ---------------------------------------------------------------- pledges

// POST /api/projects/:id/pledges: a promise of money, tracked apart from gifts.
router.post('/:id/pledges', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const project = await loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'errors.projectNotFound' });

    const amount = num(req.body?.amount, NaN);
    if (Number.isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'errors.pledgeAmountRequired' });
    const memberId = req.body?.memberId ? Number(req.body.memberId) : null;
    const name = String(req.body?.name || '').trim();
    if (!memberId && !name) return res.status(400).json({ error: 'errors.pledgerNameRequired' });

    if (memberId) {
      const { rows } = await pool.query('SELECT id FROM members WHERE id = $1', [memberId]);
      if (!rows[0]) return res.status(400).json({ error: 'errors.memberNotFound' });
    }

    const status = PLEDGE_STATUSES.has(req.body?.status) ? req.body.status : 'open';
    const fulfilled = Math.max(0, num(req.body?.fulfilledAmount, 0));

    const { rows } = await pool.query(
      `INSERT INTO project_pledges
         (project_id, member_id, pledge_name_enc, amount, fulfilled_amount, currency, pledged_on, status, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        project.id, memberId, name ? encryptField(name) : null, amount, fulfilled,
        String(req.body?.currency || project.currency).toUpperCase(),
        req.body?.pledgedOn || todayISO(), status, String(req.body?.notes || '').trim() || null, req.user.id,
      ]
    );

    await logAudit({
      userId: req.user.id,
      action: 'project_pledge_recorded',
      table: 'project_pledges',
      recordId: rows[0].id,
      details: { projectId: project.id, amount, memberId },
      ip: req.ip,
    });
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRecordPledge' });
  }
});

// PATCH /api/projects/:id/pledges/:pledgeId: record a payment against a pledge.
router.patch('/:id/pledges/:pledgeId', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM project_pledges WHERE id = $1 AND project_id = $2', [
      req.params.pledgeId,
      req.params.id,
    ]);
    const pledge = rows[0];
    if (!pledge) return res.status(404).json({ error: 'errors.pledgeNotFound' });

    // A payment can be added to what has already come in, or set outright.
    const nextFulfilled =
      req.body?.addFulfilled !== undefined
        ? num(pledge.fulfilled_amount) + num(req.body.addFulfilled)
        : req.body?.fulfilledAmount !== undefined
          ? num(req.body.fulfilledAmount)
          : num(pledge.fulfilled_amount);
    if (nextFulfilled < 0) return res.status(400).json({ error: 'errors.negativeAmountNotAllowed' });
    if (nextFulfilled > num(pledge.amount)) return res.status(400).json({ error: 'errors.fulfilledExceedsPledge' });

    let status = PLEDGE_STATUSES.has(req.body?.status) ? req.body.status : pledge.status;
    if (req.body?.status === undefined && status !== 'cancelled') {
      // Fully paid pledges close themselves; the flag is derived, not maintained.
      status = nextFulfilled >= num(pledge.amount) ? 'fulfilled' : 'open';
    }

    await pool.query(
      'UPDATE project_pledges SET fulfilled_amount = $1, status = $2, notes = $3 WHERE id = $4',
      [nextFulfilled, status, req.body?.notes ?? pledge.notes, pledge.id]
    );
    await logAudit({
      userId: req.user.id,
      action: 'project_pledge_updated',
      table: 'project_pledges',
      recordId: pledge.id,
      details: { projectId: pledge.project_id, fulfilledAmount: nextFulfilled, status },
      ip: req.ip,
    });
    res.json({ success: true, fulfilledAmount: nextFulfilled, status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdatePledge' });
  }
});

router.delete('/:id/pledges/:pledgeId', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM project_pledges WHERE id = $1 AND project_id = $2', [
      req.params.pledgeId,
      req.params.id,
    ]);
    if (!rowCount) return res.status(404).json({ error: 'errors.pledgeNotFound' });
    await logAudit({
      userId: req.user.id,
      action: 'project_pledge_removed',
      table: 'project_pledges',
      recordId: Number(req.params.pledgeId),
      details: { projectId: Number(req.params.id) },
      ip: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRemovePledge' });
  }
});

// ---------------------------------------------------------------- debts

router.post('/:id/debts', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const project = await loadProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'errors.projectNotFound' });

    const description = String(req.body?.description || '').trim();
    if (!description) return res.status(400).json({ error: 'errors.debtDescriptionRequired' });
    const amount = num(req.body?.amount, NaN);
    if (Number.isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'errors.debtAmountRequired' });
    const status = DEBT_STATUSES.has(req.body?.status) ? req.body.status : 'outstanding';
    const paidOn = status === 'paid' ? req.body?.paidOn || todayISO() : null;

    const { rows } = await pool.query(
      `INSERT INTO project_debts (project_id, description, amount, currency, status, incurred_on, paid_on, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        project.id, description, amount, String(req.body?.currency || project.currency).toUpperCase(), status,
        req.body?.incurredOn || todayISO(), paidOn, String(req.body?.notes || '').trim() || null, req.user.id,
      ]
    );
    await logAudit({
      userId: req.user.id,
      action: 'project_debt_recorded',
      table: 'project_debts',
      recordId: rows[0].id,
      details: { projectId: project.id, amount, description },
      ip: req.ip,
    });
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRecordDebt' });
  }
});

router.patch('/:id/debts/:debtId', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM project_debts WHERE id = $1 AND project_id = $2', [
      req.params.debtId,
      req.params.id,
    ]);
    const debt = rows[0];
    if (!debt) return res.status(404).json({ error: 'errors.debtNotFound' });

    const status = DEBT_STATUSES.has(req.body?.status) ? req.body.status : debt.status;
    const description = req.body?.description !== undefined ? String(req.body.description).trim() : debt.description;
    if (!description) return res.status(400).json({ error: 'errors.debtDescriptionRequired' });
    const amount = req.body?.amount !== undefined ? num(req.body.amount, debt.amount) : num(debt.amount);
    if (amount <= 0) return res.status(400).json({ error: 'errors.debtAmountRequired' });
    const paidOn = status === 'paid' ? debt.paid_on || req.body?.paidOn || todayISO() : null;

    await pool.query(
      'UPDATE project_debts SET description = $1, amount = $2, status = $3, paid_on = $4, notes = $5 WHERE id = $6',
      [description, amount, status, paidOn, req.body?.notes ?? debt.notes, debt.id]
    );
    await logAudit({
      userId: req.user.id,
      action: 'project_debt_updated',
      table: 'project_debts',
      recordId: debt.id,
      details: { projectId: debt.project_id, status, amount },
      ip: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateDebt' });
  }
});

router.delete('/:id/debts/:debtId', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM project_debts WHERE id = $1 AND project_id = $2', [
      req.params.debtId,
      req.params.id,
    ]);
    if (!rowCount) return res.status(404).json({ error: 'errors.debtNotFound' });
    await logAudit({
      userId: req.user.id,
      action: 'project_debt_removed',
      table: 'project_debts',
      recordId: Number(req.params.debtId),
      details: { projectId: Number(req.params.id) },
      ip: req.ip,
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRemoveDebt' });
  }
});

module.exports = router;
