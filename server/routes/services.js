const express = require('express');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { todayISO } = require('../utils/date');

const router = express.Router();
router.use(authenticate);

// GET /api/services?date=YYYY-MM-DD, list sessions for a given day (defaults to today,
// in the church's timezone, never UTC, which is off by hours here).
router.get('/', async (req, res) => {
  try {
    const date = req.query.date || todayISO();
    const { rows: services } = await pool.query('SELECT * FROM services WHERE date = $1 ORDER BY id', [date]);
    res.json({ services });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadServices' });
  }
});

// POST /api/services: admins/superadmin can define new service sessions.
// A service_type_id is REQUIRED: untyped sessions (service_type_id IS NULL)
// don't join to service_types and used to vanish silently from every list,
// report, and the pastor digest. Sessions are now always created through the
// typed path (see routes/attendance.js and utils/sessions.js).
router.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { name, date, time, serviceTypeId, subSessionId } = req.body;
    if (!serviceTypeId) {
      return res.status(400).json({ error: 'errors.serviceTypeRequiredUsePostApiAttendanceApiOfferings' });
    }
    const { rows: typeRows } = await pool.query('SELECT * FROM service_types WHERE id = $1 AND is_active = 1', [serviceTypeId]);
    const type = typeRows[0];
    if (!type) return res.status(400).json({ error: 'errors.selectedServiceTypeNotAvailable' });
    if (subSessionId) {
      const { rows: subRows } = await pool.query(
        'SELECT id FROM service_type_sessions WHERE id = $1 AND service_type_id = $2',
        [subSessionId, serviceTypeId]
      );
      if (!subRows[0]) return res.status(400).json({ error: 'errors.selectedSubSessionNotBelongServiceType' });
    }
    const targetDate = date || todayISO();
    if (!/\d{4}-\d{2}-\d{2}/.test(targetDate)) {
      return res.status(400).json({ error: 'errors.dateYyyyMmDdFormat' });
    }
    const { rows } = await pool.query(
      'INSERT INTO services (name, date, time, service_type_id, sub_session_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [name || type.name, targetDate, time || null, serviceTypeId, subSessionId || null]
    );
    const id = rows[0].id;
    await logAudit({ userId: req.user.id, action: 'service_created', table: 'services', recordId: id, ip: req.ip });
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreateService' });
  }
});

module.exports = router;
