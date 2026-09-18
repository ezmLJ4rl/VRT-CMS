const express = require('express');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// GET /api/revival-centers: reference list including zones.
//
// A zone travels with the members who lead it, because that is the one fact
// about a zone that is not the zone itself: a roster's zone section says who is
// responsible for the people inside it, and it must not need a second request
// per zone, or per member, to find out.
router.get('/', async (req, res) => {
  try {
    const { rows: centers } = await pool.query('SELECT * FROM revival_centers ORDER BY sort_order, id');
    const { rows: zones } = await pool.query('SELECT * FROM center_zones ORDER BY id');
    // Two queries for the whole page rather than one per zone: the leaders are
    // fetched in a single pass and grouped by zone below.
    const { rows: leaderRows } = await pool.query(
      `SELECT l.zone_id, l.member_id, l.role_name, m.name, m.member_no, m.zone_id AS member_zone_id, m.is_active
         FROM center_zone_leaders l
         JOIN members m ON m.id = l.member_id
        ORDER BY m.name, m.id`
    );
    const leadersByZone = leaderRows.reduce((acc, l) => {
      (acc[l.zone_id] = acc[l.zone_id] || []).push(l);
      return acc;
    }, {});
    const zonesByCenter = zones.reduce((acc, z) => {
      (acc[z.revival_center_id] = acc[z.revival_center_id] || []).push({ ...z, leaders: leadersByZone[z.id] || [] });
      return acc;
    }, {});
    const withCounts = [];
    for (const c of centers) {
      const { rows: countRows } = await pool.query('SELECT COUNT(*) AS c FROM members WHERE revival_center_id = $1', [c.id]);
      const zones = zonesByCenter[c.id] || [];
      // The center's leaders ARE its zones' leaders: the union, derived on every
      // read. A separate roster of center leaders would be the same fact typed
      // twice, and the two copies would drift the first time somebody left a
      // zone. Each entry says which zone the person leads, because that is what
      // makes the roll-up readable.
      const leaders = zones.flatMap((z) =>
        z.leaders.map((l) => ({ ...l, zone_name: z.name }))
      );
      withCounts.push({ ...c, zones, leaders, member_count: countRows[0].c });
    }
    res.json({ revivalCenters: withCounts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadRevivalCenters' });
  }
});

// POST /api/revival-centers: create a center. Admin/superadmin only.
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { name, sortOrder, isActive } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'errors.nameRequired' });
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM revival_centers');
    const nextOrder = maxRows[0].n;
    const { rows } = await pool.query(
      'INSERT INTO revival_centers (name, sort_order, is_active) VALUES ($1, $2, $3) RETURNING *',
      [String(name).trim(), sortOrder !== undefined ? Number(sortOrder) : nextOrder, isActive === false ? 0 : 1]
    );
    await logAudit({ userId: req.user.id, action: 'center_created', table: 'revival_centers', recordId: rows[0].id, details: { name }, ip: req.ip });
    res.status(201).json({ revivalCenter: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreateRevivalCenter' });
  }
});

// PATCH /api/revival-centers/zones/:id: update a zone. (Before /:id so it wins.)
router.patch('/zones/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM center_zones WHERE id = $1', [req.params.id]);
    const existing = rows[0];
    if (!existing) return res.status(404).json({ error: 'errors.zoneNotFound' });
    const { name, isActive, leaders: leaderInput } = req.body;
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'errors.nameCannotEmpty' });

    // The leaders are the WHOLE set: empty to leave the zone with nobody.
    // A set rather than add/remove commands, because that is what the caller
    // already knows and it makes a double-click harmless. Each entry carries the
    // role that person holds: { memberId, roleName }.
    let leaders = null;
    if (leaderInput !== undefined) {
      if (!Array.isArray(leaderInput)) return res.status(400).json({ error: 'errors.invalidMemberId' });
      const entries = [];
      for (const entry of leaderInput) {
        const memberId = Number(entry && entry.memberId);
        if (!Number.isInteger(memberId) || memberId <= 0) return res.status(400).json({ error: 'errors.invalidMemberId' });
        if (entries.some((e) => e.memberId === memberId)) {
          // One role per member per zone: the same person twice is not two jobs.
          return res.status(400).json({ error: 'errors.memberAlreadyHasRoleInZone' });
        }
        const roleName = entry.roleName === undefined || entry.roleName === null ? '' : String(entry.roleName).trim();
        if (roleName.length > 60) return res.status(400).json({ error: 'errors.roleNameTooLong' });
        entries.push({ memberId, roleName });
      }

      // Every NEW leader must be a member OF THIS ZONE. A zone is a place, and
      // the person who carries an office in it is answerable for the people
      // filed there, so somebody filed in another zone is not the right person
      // for the job, and with several roles in play, a mis-assignment is easy
      // to make and hard to notice. The zone membership is the check, not the
      // center.
      //
      // Somebody who ALREADY holds office in this zone is left alone: rows
      // written before this rule existed can be out of step with it, and refusing
      // the whole set because of one of them would leave an admin unable to touch
      // the zone at all. Those rows are reported to the client (member_zone_id)
      // so the app can flag them and the admin can remove them deliberately: the
      // app never rewrites somebody's assignment behind their back.
      if (entries.length) {
        const { rows: found } = await pool.query('SELECT id, zone_id FROM members WHERE id = ANY($1::int[])', [entries.map((e) => e.memberId)]);
        if (found.length !== entries.length) return res.status(404).json({ error: 'errors.memberNotFound' });
        const { rows: standing } = await pool.query('SELECT member_id FROM center_zone_leaders WHERE zone_id = $1', [existing.id]);
        const already = new Set(standing.map((r) => Number(r.member_id)));
        const outsider = found.find((m) => !already.has(Number(m.id)) && Number(m.zone_id) !== Number(existing.id));
        if (outsider) return res.status(400).json({ error: 'errors.leaderNotInThisZone' });
      }
      leaders = entries;
    }

    const client = await pool.connect();
    let updated;
    try {
      await client.query('BEGIN');
      ({ rows: updated } = await client.query(
        'UPDATE center_zones SET name = $1, is_active = $2 WHERE id = $3 RETURNING *',
        [
          name !== undefined ? String(name).trim() : existing.name,
          isActive !== undefined ? (isActive === false ? 0 : 1) : existing.is_active,
          existing.id,
        ]
      ));
      if (leaders !== null) {
        // Replace, in one unit of work: nobody should see a zone with its old
        // leaders already gone and its new ones not yet in.
        const keep = leaders.map((l) => l.memberId);
        await client.query('DELETE FROM center_zone_leaders WHERE zone_id = $1 AND member_id <> ALL($2::int[])', [existing.id, keep]);
        for (const l of leaders) {
          // An entry with no role keeps whatever role that person already holds,
          // that is how a rename of the set (say, removing somebody else) leaves
          // the others' roles intact. A genuinely new entry stores the role it
          // came with, which the assign form always fills in.
          await client.query(
            `INSERT INTO center_zone_leaders (zone_id, member_id, role_name) VALUES ($1, $2, $3)
               ON CONFLICT (zone_id, member_id)
               DO UPDATE SET role_name = CASE
                 WHEN EXCLUDED.role_name = '' THEN center_zone_leaders.role_name
                 ELSE EXCLUDED.role_name END`,
            [existing.id, l.memberId, l.roleName]
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    // Audited once the write is committed, not before: an audit entry for a
    // change that rolled back would be a lie in the record.
    const details = leaders !== null ? { leaders } : undefined;
    await logAudit({ userId: req.user.id, action: 'zone_updated', table: 'center_zones', recordId: existing.id, details, ip: req.ip });
    res.json({ zone: updated[0], leaders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateZone' });
  }
});

// DELETE /api/revival-centers/zones/:id: remove a zone if no members reference it.
router.delete('/zones/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM center_zones WHERE id = $1', [req.params.id]);
    const zone = rows[0];
    if (!zone) return res.status(404).json({ error: 'errors.zoneNotFound' });
    const { rows: memberRows } = await pool.query('SELECT COUNT(*) AS c FROM members WHERE zone_id = $1', [zone.id]);
    if (memberRows[0].c > 0) return res.status(400).json({ error: 'errors.zoneStillMembersAssignedMoveThemFirst' });
    await pool.query('DELETE FROM center_zones WHERE id = $1', [zone.id]);
    await logAudit({ userId: req.user.id, action: 'zone_deleted', table: 'center_zones', recordId: zone.id, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedDeleteZone' });
  }
});

// PATCH /api/revival-centers/:id: update a center.
router.patch('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM revival_centers WHERE id = $1', [req.params.id]);
    const existing = rows[0];
    if (!existing) return res.status(404).json({ error: 'errors.revivalCenterNotFound' });
    const { name, sortOrder, isActive } = req.body;
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'errors.nameCannotEmpty' });
    const { rows: updated } = await pool.query(
      'UPDATE revival_centers SET name = $1, sort_order = $2, is_active = $3 WHERE id = $4 RETURNING *',
      [
        name !== undefined ? String(name).trim() : existing.name,
        sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
        isActive !== undefined ? (isActive === false ? 0 : 1) : existing.is_active,
        existing.id,
      ]
    );
    await logAudit({ userId: req.user.id, action: 'center_updated', table: 'revival_centers', recordId: existing.id, ip: req.ip });
    res.json({ revivalCenter: updated[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateRevivalCenter' });
  }
});

// POST /api/revival-centers/:id/zones: add a zone to a center.
router.post('/:id/zones', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM revival_centers WHERE id = $1', [req.params.id]);
    const center = rows[0];
    if (!center) return res.status(404).json({ error: 'errors.revivalCenterNotFound' });
    const { name } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'errors.nameRequired' });
    const { rows: inserted } = await pool.query(
      'INSERT INTO center_zones (revival_center_id, name) VALUES ($1, $2) RETURNING *',
      [center.id, String(name).trim()]
    );
    await logAudit({ userId: req.user.id, action: 'zone_created', table: 'center_zones', recordId: inserted[0].id, details: { name, centerId: center.id }, ip: req.ip });
    res.status(201).json({ zone: inserted[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreateZone' });
  }
});

module.exports = router;
