const express = require('express');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

const ATTENDANCE_MODES = ['headcount', 'named', 'both'];
// 'service' = a church service (ibada), which may record attendance and offerings.
// 'rehearsal' = a practice session, attendance only, reported separately.
const KINDS = ['service', 'rehearsal'];

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'service';
}

// GET /api/service-types: full list with sub-sessions, ordered.
router.get('/', async (req, res) => {
  try {
    const { rows: types } = await pool.query('SELECT * FROM service_types ORDER BY sort_order, id');
    const { rows: sessions } = await pool.query('SELECT * FROM service_type_sessions ORDER BY sort_order, id');
    const sessionsByType = sessions.reduce((acc, s) => {
      (acc[s.service_type_id] = acc[s.service_type_id] || []).push(s);
      return acc;
    }, {});
    res.json({
      serviceTypes: types.map((t) => ({ ...t, subSessions: sessionsByType[t.id] || [] })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadServiceTypes' });
  }
});

// POST /api/service-types: create a new service type with optional sub-sessions.
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { name, attendanceMode, subSessions, kind: rawKind } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'errors.serviceTypeNameRequired' });
    }
    if (rawKind !== undefined && !KINDS.includes(rawKind)) {
      return res.status(400).json({ error: 'errors.invalidServiceTypeKind' });
    }
    const kind = KINDS.includes(rawKind) ? rawKind : 'service';
    // A rehearsal is a headcount AND names by default (the names may be
    // handwritten for people who are not registered yet, or picked from the
    // member list); a service keeps the existing headcount default.
    const mode = ATTENDANCE_MODES.includes(attendanceMode)
      ? attendanceMode
      : kind === 'rehearsal'
      ? 'both'
      : 'headcount';
    const key = slugify(name);
    const { rows: existingRows } = await pool.query('SELECT id FROM service_types WHERE key = $1', [key]);
    if (existingRows[0]) {
      return res.status(409).json({ error: 'errors.serviceTypeNameAlreadyExists' });
    }
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM service_types');
    const maxOrder = maxRows[0].m;

    // Real transaction: the type and its sub-sessions must be created together.
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        'INSERT INTO service_types (name, key, kind, attendance_mode, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [name.trim(), key, kind, mode, maxOrder + 1]
      );
      id = inserted.rows[0].id;
      const subNames = (Array.isArray(subSessions) ? subSessions : [])
        .map((s) => (typeof s === 'string' ? s : s && s.name))
        .filter(Boolean);
      let i = 0;
      for (const sName of subNames) {
        await client.query(
          'INSERT INTO service_type_sessions (service_type_id, name, sort_order) VALUES ($1, $2, $3)',
          [id, String(sName).trim(), i]
        );
        i += 1;
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit({
      userId: req.user.id,
      action: 'service_type_created',
      table: 'service_types',
      recordId: id,
      details: { kind, attendance_mode: mode },
      ip: req.ip,
    });
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreateServiceType' });
  }
});

// PATCH /api/service-types/:id: rename, reorder, disable, change mode, manage sub-sessions.
router.patch('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM service_types WHERE id = $1', [req.params.id]);
    const type = rows[0];
    if (!type) return res.status(404).json({ error: 'errors.serviceTypeNotFound' });

    const { name, attendanceMode, sortOrder, isActive, subSessions, kind } = req.body || {};

    if (kind !== undefined && !KINDS.includes(kind)) {
      return res.status(400).json({ error: 'errors.invalidServiceTypeKind' });
    }
    // A rehearsal records attendance only. Turning a type that already collected
    // offerings into one would leave that money attached to a rehearsal, so the
    // change is refused until those records are dealt with.
    if (kind === 'rehearsal' && type.kind !== 'rehearsal') {
      const { rows: money } = await pool.query(
        `SELECT COUNT(*)::int AS count FROM offerings o
           JOIN services s ON s.id = o.service_id
          WHERE s.service_type_id = $1`,
        [type.id]
      );
      if (money[0].count > 0) {
        return res.status(409).json({
          error: 'errors.rehearsalCannotHaveOfferings',
          params: { count: money[0].count },
        });
      }
    }

    // Runs on the transaction client so renames/inserts/deactivations all commit together.
    async function reconcileSubSessions(client, typeId, incoming) {
      const { rows: existing } = await client.query('SELECT * FROM service_type_sessions WHERE service_type_id = $1', [typeId]);

      const seen = new Set();
      // sort_order is the position in the incoming array (empty/skipped entries
      // still consume an index), matching the original .forEach((s, i) => ...) behavior.
      for (let i = 0; i < incoming.length; i++) {
        const s = incoming[i];
        const name = typeof s === 'string' ? s : s && s.name;
        if (!name || !String(name).trim()) continue;
        const cleanName = String(name).trim();
        const id = typeof s === 'object' && s ? Number(s.id) : null;
        if (id && Number.isInteger(id)) {
          const row = existing.find((e) => e.id === id);
          if (row) {
            seen.add(id);
            await client.query('UPDATE service_type_sessions SET is_active = 1, name = $1, sort_order = $2 WHERE id = $3', [cleanName, i, id]);
          }
        } else {
          await client.query('INSERT INTO service_type_sessions (service_type_id, name, sort_order) VALUES ($1, $2, $3)', [typeId, cleanName, i]);
        }
      }
      for (const row of existing) {
        if (seen.has(row.id)) continue;
        // Never hard-delete a sub-session that history references; deactivate instead.
        const referenced =
          (await client.query('SELECT 1 FROM services WHERE sub_session_id = $1 LIMIT 1', [row.id])).rows[0] ||
          (await client.query('SELECT 1 FROM attendance WHERE sub_session_id = $1 LIMIT 1', [row.id])).rows[0] ||
          (await client.query('SELECT 1 FROM offerings WHERE sub_session_id = $1 LIMIT 1', [row.id])).rows[0];
        if (referenced) await client.query('UPDATE service_type_sessions SET is_active = 0 WHERE id = $1', [row.id]);
        else await client.query('DELETE FROM service_type_sessions WHERE id = $1', [row.id]);
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (name && typeof name === 'string' && name.trim()) {
        await client.query('UPDATE service_types SET name = $1 WHERE id = $2', [name.trim(), type.id]);
      }
      if (ATTENDANCE_MODES.includes(attendanceMode)) {
        await client.query('UPDATE service_types SET attendance_mode = $1 WHERE id = $2', [attendanceMode, type.id]);
      }
      if (KINDS.includes(kind)) {
        await client.query('UPDATE service_types SET kind = $1 WHERE id = $2', [kind, type.id]);
      }
      if (Number.isInteger(sortOrder)) {
        await client.query('UPDATE service_types SET sort_order = $1 WHERE id = $2', [sortOrder, type.id]);
      }
      if (typeof isActive === 'boolean') {
        await client.query('UPDATE service_types SET is_active = $1 WHERE id = $2', [isActive ? 1 : 0, type.id]);
      }
      if (Array.isArray(subSessions)) {
        await reconcileSubSessions(client, type.id, subSessions);
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit({ userId: req.user.id, action: 'service_type_updated', table: 'service_types', recordId: type.id, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateServiceType' });
  }
});

module.exports = router;
