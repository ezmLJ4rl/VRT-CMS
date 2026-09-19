'use strict';

const express = require('express');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { notifyPastorOfRecord, pushAlertToUser } = require('../utils/notify');
const { translator } = require('../i18n');

const router = express.Router();
router.use(authenticate);

const STAFF_ROLES = ['receptionist', 'admin', 'superadmin'];
const RESPONSE_STATUSES = ['confirmed', 'declined', 'rescheduled'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const SELECT = `
  SELECT a.*, requester.name AS requester_name, requester.email AS requester_email,
         pastor.name AS pastor_name, pastor.email AS pastor_email
    FROM appointments a
    JOIN users requester ON requester.id = a.requested_by
    JOIN users pastor ON pastor.id = a.pastor_id
`;

function serialize(row) {
  return {
    id: row.id,
    requestedBy: row.requested_by,
    requesterName: row.requester_name,
    requesterEmail: row.requester_email,
    pastorId: row.pastor_id,
    pastorName: row.pastor_name,
    requestedDate: row.requested_date,
    requestedTime: row.requested_time,
    durationMinutes: row.duration_minutes,
    purpose: row.purpose,
    requesterNotes: row.requester_notes,
    status: row.status,
    proposedDate: row.proposed_date,
    proposedTime: row.proposed_time,
    pastorNotes: row.pastor_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateSchedule({ requestedDate, requestedTime, purpose, proposedDate, proposedTime }) {
  if (!DATE_RE.test(String(requestedDate || ''))) return 'errors.appointmentDateRequired';
  if (!TIME_RE.test(String(requestedTime || ''))) return 'errors.appointmentTimeRequired';
  if (!String(purpose || '').trim()) return 'errors.appointmentPurposeRequired';
  if (String(purpose).trim().length > 200) return 'errors.appointmentPurposeTooLong';
  if (proposedDate !== undefined && proposedDate !== null && proposedDate !== '' && !DATE_RE.test(String(proposedDate))) return 'errors.appointmentProposedDateRequired';
  if (proposedTime !== undefined && proposedTime !== null && proposedTime !== '' && !TIME_RE.test(String(proposedTime))) return 'errors.appointmentProposedTimeRequired';
  return null;
}

async function findPastor(pastorId) {
  const query = pastorId
    ? 'SELECT id, name, email, language_pref FROM users WHERE id = $1 AND role = \'pastor\' AND is_active = 1'
    : 'SELECT id, name, email, language_pref FROM users WHERE role = \'pastor\' AND is_active = 1 ORDER BY id LIMIT 1';
  const { rows } = await pool.query(query, pastorId ? [pastorId] : []);
  return rows[0] || null;
}

async function notifyRequester(appointment, status, actorNotes) {
  const { rows } = await pool.query('SELECT id, name, email, role, language_pref FROM users WHERE id = $1 AND is_active = 1', [appointment.requested_by]);
  const requester = rows[0];
  if (!requester) return;
  const t = translator(requester.language_pref || 'en');
  const date = appointment.proposed_date || appointment.requested_date;
  const time = appointment.proposed_time || appointment.requested_time;
  const subject = t(`appointment.${status}Title`);
  const body = t(`appointment.${status}Body`, {
    date,
    time,
    purpose: appointment.purpose,
    notes: actorNotes || '',
  });
  const messageRows = await pool.query(
    `INSERT INTO messages (sender_id, recipient_role, recipient_id, thread_key, category, subject, body, payload)
     VALUES ($1, $2, $3, $4, 'appointment', $5, $6, $7) RETURNING id`,
    [appointment.pastor_id, requester.role, requester.id, `appointment:${appointment.id}`, subject, body, JSON.stringify({ appointmentId: appointment.id, status })]
  );
  const messageId = messageRows.rows[0].id;
  pushAlertToUser({
    user: requester,
    title: subject,
    body,
    url: '/appointments',
    recordType: 'message',
    recordId: messageId,
    tag: `appointment:${appointment.id}`,
    requireInteraction: false,
  }).catch(() => {});
}

// GET /api/appointments: staff see their own requests; pastors and superadmins
// see the complete appointment queue.
router.get('/', requireRole(...STAFF_ROLES, 'pastor'), async (req, res) => {
  try {
    const isBroadView = req.user.role === 'pastor' || req.user.role === 'superadmin';
    const where = isBroadView ? '' : 'WHERE a.requested_by = $1';
    const params = isBroadView ? [] : [req.user.id];
    const { rows } = await pool.query(`${SELECT} ${where} ORDER BY COALESCE(a.proposed_date, a.requested_date), COALESCE(a.proposed_time, a.requested_time), a.created_at DESC`, params);
    res.json({ appointments: rows.map(serialize) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadAppointments' });
  }
});

// POST /api/appointments: receptionist/admin/superadmin can request time with a
// pastor. Pastor selection is optional while there is one active pastor.
router.post('/', requireRole(...STAFF_ROLES), async (req, res) => {
  try {
    const body = req.body || {};
    const purpose = String(body.purpose || '').trim();
    const requesterNotes = String(body.requesterNotes || '').trim() || null;
    const validation = validateSchedule({ ...body, purpose });
    if (validation) return res.status(400).json({ error: validation });
    if (requesterNotes && requesterNotes.length > 1000) return res.status(400).json({ error: 'errors.appointmentNotesTooLong' });

    const pastor = await findPastor(body.pastorId ? Number(body.pastorId) : null);
    if (!pastor) return res.status(400).json({ error: 'errors.appointmentPastorUnavailable' });

    const { rows } = await pool.query(
      `INSERT INTO appointments
        (requested_by, pastor_id, requested_date, requested_time, duration_minutes, purpose, requester_notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [req.user.id, pastor.id, body.requestedDate, body.requestedTime, body.durationMinutes ? Number(body.durationMinutes) : null, purpose, requesterNotes]
    );
    const appointmentId = rows[0].id;
    await logAudit({ userId: req.user.id, action: 'appointment_requested', table: 'appointments', recordId: appointmentId, details: { requestedDate: body.requestedDate, requestedTime: body.requestedTime }, ip: req.ip });

    await notifyPastorOfRecord({
      recordType: 'appointment_request',
      recordId: appointmentId,
      url: '/appointments',
      locale: req.locale,
      render: (t) => ({
        title: t('appointment.requestTitle'),
        summary: t('appointment.requestBody', { requester: req.user.name, date: body.requestedDate, time: body.requestedTime, purpose }),
      }),
    });

    const { rows: created } = await pool.query(`${SELECT} WHERE a.id = $1`, [appointmentId]);
    res.status(201).json({ appointment: serialize(created[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreateAppointment' });
  }
});

// PATCH /api/appointments/:id/respond: only the pastor or superadmin can
// confirm, decline, or propose a different time.
router.patch('/:id/respond', requireRole('pastor', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT} WHERE a.id = $1`, [req.params.id]);
    const appointment = rows[0];
    if (!appointment) return res.status(404).json({ error: 'errors.appointmentNotFound' });
    if (req.user.role === 'pastor' && appointment.pastor_id !== req.user.id) return res.status(403).json({ error: 'errors.appointmentNotAssignedToPastor' });

    const status = String(req.body?.status || '');
    if (!RESPONSE_STATUSES.includes(status)) return res.status(400).json({ error: 'errors.appointmentResponseInvalid' });
    if (!['pending', 'rescheduled'].includes(appointment.status)) return res.status(409).json({ error: 'errors.appointmentAlreadyDecided' });

    const proposedDate = req.body?.proposedDate || null;
    const proposedTime = req.body?.proposedTime || null;
    const notes = String(req.body?.pastorNotes || '').trim() || null;
    if (status === 'rescheduled') {
      if (!DATE_RE.test(String(proposedDate || ''))) return res.status(400).json({ error: 'errors.appointmentProposedDateRequired' });
      if (!TIME_RE.test(String(proposedTime || ''))) return res.status(400).json({ error: 'errors.appointmentProposedTimeRequired' });
    }
    if (notes && notes.length > 1000) return res.status(400).json({ error: 'errors.appointmentNotesTooLong' });

    const effectiveDate = status === 'rescheduled' ? proposedDate : appointment.requested_date;
    const effectiveTime = status === 'rescheduled' ? proposedTime : appointment.requested_time;
    if (status === 'confirmed') {
      const { rows: conflicts } = await pool.query(
        `SELECT id FROM appointments
          WHERE pastor_id = $1 AND id <> $2 AND status = 'confirmed'
            AND COALESCE(proposed_date, requested_date) = $3
            AND COALESCE(proposed_time, requested_time) = $4
          LIMIT 1`,
        [appointment.pastor_id, appointment.id, effectiveDate, effectiveTime]
      );
      if (conflicts[0]) return res.status(409).json({ error: 'errors.appointmentTimeUnavailable' });
    }

    await pool.query(
      `UPDATE appointments
          SET status = $1, proposed_date = $2, proposed_time = $3, pastor_notes = $4,
              updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE id = $5`,
      [status, status === 'rescheduled' ? proposedDate : appointment.proposed_date, status === 'rescheduled' ? proposedTime : appointment.proposed_time, notes, appointment.id]
    );
    await logAudit({ userId: req.user.id, action: `appointment_${status}`, table: 'appointments', recordId: appointment.id, details: { date: effectiveDate, time: effectiveTime, notes }, ip: req.ip });
    await notifyRequester({ ...appointment, proposed_date: proposedDate, proposed_time: proposedTime }, status, notes);

    const { rows: updated } = await pool.query(`${SELECT} WHERE a.id = $1`, [appointment.id]);
    res.json({ appointment: serialize(updated[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRespondAppointment' });
  }
});

// PATCH /api/appointments/:id/cancel: the requester can withdraw a pending or
// confirmed request; admins and superadmins can cancel on behalf of staff.
router.patch('/:id/cancel', requireRole(...STAFF_ROLES, 'pastor'), async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT} WHERE a.id = $1`, [req.params.id]);
    const appointment = rows[0];
    if (!appointment) return res.status(404).json({ error: 'errors.appointmentNotFound' });
    if (['receptionist', 'admin'].includes(req.user.role) && appointment.requested_by !== req.user.id) return res.status(403).json({ error: 'errors.appointmentOwnRequestsOnly' });
    if (!['pending', 'confirmed', 'rescheduled'].includes(appointment.status)) return res.status(409).json({ error: 'errors.appointmentCannotCancel' });
    await pool.query("UPDATE appointments SET status = 'cancelled', updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1", [appointment.id]);
    await logAudit({ userId: req.user.id, action: 'appointment_cancelled', table: 'appointments', recordId: appointment.id, ip: req.ip });
    const { rows: updated } = await pool.query(`${SELECT} WHERE a.id = $1`, [appointment.id]);
    res.json({ appointment: serialize(updated[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCancelAppointment' });
  }
});

module.exports = router;
