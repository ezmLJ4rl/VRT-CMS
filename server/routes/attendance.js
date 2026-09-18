const express = require('express');
const pool = require('../db/pg');
const { toParams } = require('../utils/sqlParams');
const { authenticate, requireRole, restrictReceptionistToToday } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { todayISO } = require('../utils/date');
const { sendBatchDigest } = require('../utils/digest');

const router = express.Router();
router.use(authenticate);

// Shared attendees parsing/validation so POST and PUT stay in lock-step.
function parseAttendees(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((x) => (typeof x === 'string' ? { name: x } : x))
    .map((x) => ({
      memberId: x && Number.isInteger(Number(x.memberId)) ? Number(x.memberId) : null,
      name: x && typeof x.name === 'string' ? x.name.trim() : '',
    }))
    .filter((x) => x.name && !x.name.includes(','));
}

function validateAttendancePayload(mode, cleanAttendees, count) {
  const hasCount = Number.isInteger(count) && count >= 0;
  if (mode === 'named') {
    if (cleanAttendees.length === 0) return 'errors.serviceTypeRecordsByName';
  } else if (mode === 'headcount') {
    if (!hasCount && cleanAttendees.length === 0) return 'errors.headcountRequiredForServiceType';
    if (cleanAttendees.length > 0) return 'errors.serviceTypeRecordsHeadcountOnly';
  } else if (!hasCount && cleanAttendees.length === 0) {
    return 'errors.enterHeadcountOrNames';
  }
  return null;
}

function attendanceFinalCount(mode, cleanAttendees, count) {
  const hasCount = Number.isInteger(count) && count >= 0;
  if (mode === 'named') return cleanAttendees.length;
  if (hasCount && count > 0) return count;
  return cleanAttendees.length;
}

// Now async: each existence check is a real network round-trip to Postgres.
async function validateScopes({ groupId, centerId, zoneId }) {
  if (groupId) {
    const { rows } = await pool.query('SELECT id FROM "groups" WHERE id = $1', [groupId]);
    if (!rows[0]) return 'errors.selectedGroupNotFound';
  }
  if (centerId) {
    const { rows } = await pool.query('SELECT id FROM revival_centers WHERE id = $1', [centerId]);
    if (!rows[0]) return 'errors.selectedRevivalCenterNotFound';
  }
  if (zoneId) {
    const { rows: zoneRows } = await pool.query('SELECT id FROM center_zones WHERE id = $1', [zoneId]);
    if (!zoneRows[0]) return 'errors.selectedZoneNotFound';
    if (centerId) {
      const { rows: matchRows } = await pool.query(
        'SELECT id FROM center_zones WHERE id = $1 AND revival_center_id = $2',
        [zoneId, centerId]
      );
      if (!matchRows[0]) return 'errors.selectedZoneNotInRevivalCenter';
    }
  }
  return null;
}

const SELECT_BASE = `
  SELECT a.id, a.count, a.mode, a.timestamp, a.notified_at, a.voided_at,
         s.id AS service_id, s.name AS session_name, s.date AS service_date, s.service_type_id,
         s.is_temporary, s.event_title, s.event_description,
         st.name AS service_type_name, st.key AS service_type_key, st.kind AS service_type_kind,
         st.attendance_mode,
         ss.name AS sub_session_name,
         g.name AS group_name,
         rc.name AS center_name,
         cz.name AS zone_name,
         u.name AS recorded_by_name
  FROM attendance a
  JOIN services s ON s.id = a.service_id
  LEFT JOIN service_types st ON st.id = s.service_type_id
  LEFT JOIN service_type_sessions ss ON ss.id = a.sub_session_id
  LEFT JOIN "groups" g ON g.id = a.group_id
  LEFT JOIN revival_centers rc ON rc.id = a.revival_center_id
  LEFT JOIN center_zones cz ON cz.id = a.zone_id
  JOIN users u ON u.id = a.recorded_by
`;

// Voided rows are corrections, not activity: excluded from lists, trends, and
// summaries (they remain in the DB for the audit trail).
const NOT_VOIDED = 'a.voided_at IS NULL';

// Rehearsals record attendance too, but they are not services: trend lines and
// service summaries count ibada only. Rehearsal attendance is reported on its own
// (GET /api/reports/breakdown?groupBy=rehearsal).
const SERVICE_KIND = `s.service_type_id IN (SELECT id FROM service_types WHERE kind = 'service')`;

// GET /api/attendance?from=&to=&serviceId=&serviceTypeId=&subSessionId=&groupId=&centerId=
router.get('/', async (req, res) => {
  try {
    const { from, to, serviceId, serviceTypeId, subSessionId, groupId, centerId } = req.query;
    const clauses = [];
    const params = [];

    if (req.user.role === 'receptionist') {
      clauses.push('s.date = ?', 'a.recorded_by = ?', NOT_VOIDED);
      params.push(todayISO(), req.user.id);
    } else {
      clauses.push(NOT_VOIDED);
      if (from) { clauses.push('s.date >= ?'); params.push(from); }
      if (to) { clauses.push('s.date <= ?'); params.push(to); }
    }
    if (serviceId) { clauses.push('a.service_id = ?'); params.push(serviceId); }
    if (serviceTypeId) { clauses.push('st.id = ?'); params.push(serviceTypeId); }
    if (subSessionId) { clauses.push('a.sub_session_id = ?'); params.push(subSessionId); }
    if (groupId) { clauses.push('a.group_id = ?'); params.push(groupId); }
    if (centerId) { clauses.push('a.revival_center_id = ?'); params.push(centerId); }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = toParams(`${SELECT_BASE} ${where} ORDER BY s.date DESC, a.timestamp DESC`);
    const { rows } = await pool.query(sql, params);

    if (rows.length) {
      const ids = rows.map((r) => r.id);
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows: attendees } = await pool.query(
        `SELECT aa.attendance_id, aa.name, m.member_no
         FROM attendance_attendees aa
         LEFT JOIN members m ON m.id = aa.member_id
         WHERE aa.attendance_id IN (${ph}) ORDER BY aa.id`,
        ids
      );
      const byAttendance = attendees.reduce((acc, x) => {
        (acc[x.attendance_id] = acc[x.attendance_id] || []).push(x.name);
        return acc;
      }, {});
      rows.forEach((r) => {
        r.attendees = byAttendance[r.id] || [];
        r.total = r.count ?? r.attendees.length;
      });
    }

    res.json({ attendance: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadAttendanceRecords' });
  }
});

// POST /api/attendance: record attendance against a service type (+date,
// optional sub-session) with a headcount and/or a named attendee list.
router.post('/', restrictReceptionistToToday, async (req, res) => {
  const { serviceTypeId, date, subSessionId, groupId, centerId, zoneId, count, attendees } = req.body || {};

  try {
    if (!serviceTypeId) return res.status(400).json({ error: 'errors.serviceTypeRequired' });
    const { rows: typeRows } = await pool.query('SELECT * FROM service_types WHERE id = $1 AND is_active = 1', [serviceTypeId]);
    const type = typeRows[0];
    if (!type) return res.status(400).json({ error: 'errors.selectedServiceTypeNotAvailable' });

    if (subSessionId) {
      const { rows: subRows } = await pool.query(
        'SELECT id FROM service_type_sessions WHERE id = $1 AND service_type_id = $2 AND is_active = 1',
        [subSessionId, type.id]
      );
      if (!subRows[0]) return res.status(400).json({ error: 'errors.selectedSubSessionNotBelongServiceType' });
    }

    const targetDate = date || todayISO();

    const scopeErr = await validateScopes({ groupId, centerId, zoneId });
    if (scopeErr) return res.status(400).json({ error: scopeErr });

    const cleanAttendees = parseAttendees(attendees);

    const payloadErr = validateAttendancePayload(type.attendance_mode, cleanAttendees, count);
    if (payloadErr) return res.status(400).json({ error: payloadErr });

    const finalCount = attendanceFinalCount(type.attendance_mode, cleanAttendees, count);

    // Resolve (or create) the dated service session for this type + sub-session.
    // IS NOT DISTINCT FROM is Postgres's null-safe equality: SQLite's `IS ?`
    // treated a NULL parameter as matching a NULL column; Postgres's plain `IS`
    // operator can't take a bound parameter at all, so this is the equivalent.
    const { rows: sessionRows } = await pool.query(
      'SELECT * FROM services WHERE date = $1 AND service_type_id = $2 AND sub_session_id IS NOT DISTINCT FROM $3',
      [targetDate, type.id, subSessionId || null]
    );
    let session = sessionRows[0];
    if (!session) {
      const result = await pool.query(
        'INSERT INTO services (name, date, time, service_type_id, sub_session_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [type.name, targetDate, null, type.id, subSessionId || null]
      );
      session = result.rows[0];
    }

    // Real transaction: check out one client from the pool so BEGIN/COMMIT/
    // ROLLBACK apply to the same connection for every statement inside it.
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      const attResult = await client.query(
        `INSERT INTO attendance (service_id, sub_session_id, group_id, revival_center_id, zone_id, count, mode, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [session.id, subSessionId || null, groupId || null, centerId || null, zoneId || null, finalCount, type.attendance_mode, req.user.id]
      );
      id = attResult.rows[0].id;
      for (const att of cleanAttendees) {
        await client.query(
          'INSERT INTO attendance_attendees (attendance_id, member_id, name) VALUES ($1, $2, $3)',
          [id, att.memberId, att.name]
        );
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
      action: 'attendance_recorded',
      table: 'attendance',
      recordId: id,
      details: { serviceTypeId: type.id, date: targetDate, mode: type.attendance_mode, count: finalCount, subSessionId: subSessionId || null },
      ip: req.ip,
    });

    res.status(201).json({ id, sessionId: session.id, count: finalCount, mode: type.attendance_mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRecordAttendance' });
  }
});

// GET /api/attendance/trends?granularity=weekly|monthly|yearly: overall series
// plus a per-service-type breakdown so charts keep one color per category.
router.get('/trends', requireRole('admin', 'pastor', 'superadmin'), async (req, res) => {
  try {
    const granularity = req.query.granularity || 'weekly';
    // strftime() is SQLite-only. to_char() with an ISO-week format code
    // ('IYYY-IW') is the closest Postgres equivalent to SQLite's '%Y-%W'.
    const groupExpr =
      granularity === 'monthly'
        ? "to_char(s.date::date, 'YYYY-MM')"
        : granularity === 'yearly'
        ? "to_char(s.date::date, 'YYYY')"
        : "to_char(s.date::date, 'IYYY-IW')";

    // Service attendance only: rehearsals are tracked separately (see
    // routes/reports.js), so a trend line stays comparable over time.
    const { from, to } = req.query;
    const clauses = [NOT_VOIDED, SERVICE_KIND];
    const params = [];
    if (from) { clauses.push('s.date >= ?'); params.push(from); }
    if (to) { clauses.push('s.date <= ?'); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const overallSql = toParams(
      `SELECT ${groupExpr} AS period, SUM(COALESCE(a.count, 0)) AS total, COUNT(*) AS entries
       FROM attendance a
       JOIN services s ON s.id = a.service_id
       ${where}
       GROUP BY period ORDER BY period ASC`
    );
    const { rows } = await pool.query(overallSql, params);
    const overall = rows.map((r) => ({ period: r.period, total: r.total }));

    const byTypeSql = toParams(
      `SELECT st.key AS key, st.name AS name, ${groupExpr} AS period, SUM(COALESCE(a.count, 0)) AS total
       FROM attendance a
       JOIN services s ON s.id = a.service_id
       LEFT JOIN service_types st ON st.id = s.service_type_id
       ${where}
       GROUP BY st.id, st.key, st.name, period ORDER BY st.name, period ASC`
    );
    const { rows: byTypeRows } = await pool.query(byTypeSql, params);

    const byType = [];
    const map = new Map();
    for (const r of byTypeRows) {
      if (!map.has(r.key)) {
        map.set(r.key, { key: r.key, name: r.name, points: [] });
        byType.push(map.get(r.key));
      }
      map.get(r.key).points.push({ period: r.period, total: r.total });
    }

    res.json({ trends: overall, byType });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadAttendanceTrends' });
  }
});

// PUT /api/attendance/:id: edit an attendance record (headcount + named list,
// plus the group/revival-center scope). Session, sub-session, and author stay
// fixed; corrections that change those belong in void + re-record. Admins can
// edit anything; receptionists may only correct their own records for today.
router.put('/:id', restrictReceptionistToToday, async (req, res) => {
  try {
    const { rows: rowResults } = await pool.query('SELECT * FROM attendance WHERE id = $1', [req.params.id]);
    const row = rowResults[0];
    if (!row) return res.status(404).json({ error: 'errors.attendanceRecordNotFound' });

    const { rows: sessionResults } = await pool.query('SELECT * FROM services WHERE id = $1', [row.service_id]);
    const session = sessionResults[0];
    if (!session) return res.status(404).json({ error: 'errors.serviceSessionRecordNoLongerExists' });

    const { rows: typeResults } = await pool.query('SELECT * FROM service_types WHERE id = $1', [session.service_type_id]);
    const type = typeResults[0];
    if (!type) return res.status(400).json({ error: 'errors.sessionNoServiceType' });

    if (req.user.role === 'receptionist') {
      if (row.recorded_by !== req.user.id) {
        return res.status(403).json({ error: 'errors.onlyEditOwnAttendanceRecords' });
      }
      if (session.date !== todayISO()) {
        return res.status(403).json({ error: 'errors.receptionistsOnlyEditRecordsToday' });
      }
    }

    const { count, attendees, groupId, centerId, zoneId } = req.body || {};
    const gId = groupId ? Number(groupId) : null;
    const cId = centerId ? Number(centerId) : null;
    const zId = zoneId ? Number(zoneId) : null;

    const scopeErr = await validateScopes({ groupId: gId, centerId: cId, zoneId: zId });
    if (scopeErr) return res.status(400).json({ error: scopeErr });

    const cleanAttendees = parseAttendees(attendees);
    const payloadErr = validateAttendancePayload(type.attendance_mode, cleanAttendees, count);
    if (payloadErr) return res.status(400).json({ error: payloadErr });

    const finalCount = attendanceFinalCount(type.attendance_mode, cleanAttendees, count);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE attendance SET count = $1, group_id = $2, revival_center_id = $3, zone_id = $4 WHERE id = $5',
        [finalCount, gId, cId, zId, row.id]
      );
      await client.query('DELETE FROM attendance_attendees WHERE attendance_id = $1', [row.id]);
      for (const att of cleanAttendees) {
        await client.query(
          'INSERT INTO attendance_attendees (attendance_id, member_id, name) VALUES ($1, $2, $3)',
          [row.id, att.memberId, att.name]
        );
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
      action: 'attendance_updated',
      table: 'attendance',
      recordId: row.id,
      details: { fromCount: row.count, toCount: finalCount, mode: type.attendance_mode },
      ip: req.ip,
    });

    res.json({ id: row.id, count: finalCount, mode: type.attendance_mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateAttendanceRecord' });
  }
});

// PATCH /api/attendance/:id/void: soft-void a mistaken entry. Admin/superadmin
// only. The row stays for the audit trail but disappears from every list,
// trend, and summary.
router.patch('/:id/void', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM attendance WHERE id = $1', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'errors.attendanceRecordNotFound' });
    if (row.voided_at) return res.status(409).json({ error: 'errors.attendanceRecordAlreadyVoided' });

    const reason = String(req.body?.reason || '').trim() || null;
    await pool.query(
      "UPDATE attendance SET voided_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), voided_by = $1, void_reason = $2 WHERE id = $3",
      [req.user.id, reason, row.id]
    );

    await logAudit({
      userId: req.user.id,
      action: 'attendance_voided',
      table: 'attendance',
      recordId: row.id,
      details: { count: row.count, reason },
      ip: req.ip,
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedVoidAttendanceRecord' });
  }
});

// POST /api/attendance/:id/notify: trigger the batched summary. Everything the
// caller recorded today that is still un-notified is sent to the pastor as one
// digest and flagged.
router.post('/:id/notify', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM attendance WHERE id = $1', [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'errors.attendanceRecordNotFound' });
    if (req.user.role === 'receptionist' && row.recorded_by !== req.user.id) {
      return res.status(403).json({ error: 'errors.onlySendPastorOwnRecords' });
    }
    const result = await sendBatchDigest({ userId: req.user.id, userName: req.user.name, locale: req.locale });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedSendNotification' });
  }
});

module.exports = router;