const express = require('express');
const pool = require('../db/pg');
const { toParams } = require('../utils/sqlParams');
const { enumLabel } = require('../i18n');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { notifyPastorOfRecord } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);

const SEVERITIES = ['low', 'medium', 'high', 'critical'];

// GET /api/emergencies?status=open: admin/pastor/superadmin see all; receptionists see their own.
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const clauses = [];
    const params = [];

    if (req.user.role === 'receptionist') {
      clauses.push('e.reported_by = ?');
      params.push(req.user.id);
    }
    if (status) {
      clauses.push('e.status = ?');
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const sql = toParams(
      `SELECT e.*, u.name AS reported_by_name, r.name AS resolved_by_name, s.name AS service_name
       FROM emergencies e
       JOIN users u ON u.id = e.reported_by
       LEFT JOIN users r ON r.id = e.resolved_by
       LEFT JOIN services s ON s.id = e.service_id
       ${where}
       ORDER BY e.timestamp DESC`
    );
    const { rows: emergencies } = await pool.query(sql, params);
    res.json({ emergencies });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadEmergencies' });
  }
});

// POST /api/emergencies, any staff member (receptionist/admin/superadmin) can flag an emergency.
// This intentionally bypasses the "today only" restriction, urgent situations aren't schedule-bound.
router.post('/', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { title, description, severity, serviceId } = req.body;
    if (!title) return res.status(400).json({ error: 'errors.shortTitleDescribingEmergencyRequired' });
    if (severity && !SEVERITIES.includes(severity)) return res.status(400).json({ error: 'errors.invalidSeverityLevel' });

    const { rows } = await pool.query(
      'INSERT INTO emergencies (title, description, severity, service_id, reported_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [title, description || null, severity || 'medium', serviceId || null, req.user.id]
    );
    const id = rows[0].id;

    await logAudit({ userId: req.user.id, action: 'emergency_reported', table: 'emergencies', recordId: id, details: { severity: severity || 'medium' }, ip: req.ip });

    // The alert is rendered per pastor from these keys (see utils/notify.js), so
    // an emergency reaches a Kiswahili-reading pastor in Kiswahili. The severity is
    // an enum in the database and is labelled through the catalog: it used to be
    // printed raw and shouted ('MEDIUM'), which was English text in every language.
    await notifyPastorOfRecord({
      recordType: 'emergency',
      recordId: id,
      url: '/emergencies',
      locale: req.locale,
      requireInteraction: true,
      render: (t) => ({
        title: t('emergency.pushTitle', { title }),
        summary: t(
          description ? 'emergency.summary' : 'emergency.summaryNoDescription',
          {
            severity: enumLabel(t, 'emergency.severity_', severity || 'medium'),
            title,
            description,
            name: req.user.name,
          }
        ),
      }),
    });

    res.status(201).json({ id, message: 'messages.recordedSuccessfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRecordEmergency' });
  }
});

// PATCH /api/emergencies/:id/resolve: admin/superadmin marks an emergency resolved.
router.patch('/:id/resolve', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM emergencies WHERE id = $1', [req.params.id]);
    const emergency = rows[0];
    if (!emergency) return res.status(404).json({ error: 'errors.emergencyRecordNotFound' });

    await pool.query(
      "UPDATE emergencies SET status = 'resolved', resolved_by = $1, resolved_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2",
      [req.user.id, req.params.id]
    );
    await logAudit({ userId: req.user.id, action: 'emergency_resolved', table: 'emergencies', recordId: Number(req.params.id), ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedResolveEmergency' });
  }
});

module.exports = router;
