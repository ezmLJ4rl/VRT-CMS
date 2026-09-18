const express = require('express');
const pool = require('../db/pg');
const { toParams } = require('../utils/sqlParams');
const { intlLocale, translator } = require('../i18n');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { notifyPastorOfRecord, sendSms, sendEmail } = require('../utils/notify');
const { plainTextSheet, htmlSheet, pdfSheet, collectionLabel } = require('../utils/eventSheet');
const { decryptField } = require('../utils/crypto');
const { todayISO } = require('../utils/date');

const router = express.Router();
router.use(authenticate);

const KINDS = ['event', 'service', 'giving', 'conference', 'other'];
const MANAGERS = ['pastor', 'admin', 'superadmin'];
const COLLECTION_TYPES = ['attendance', 'offerings', 'both'];

function canManage(event, user) {
  return event.created_by === user.id || ['admin', 'superadmin'].includes(user.role);
}

// Notify the receptionists that the event is live: a clear in-app message with
// the event's name, date/time, and what will be collected, plus the printable
// sheet so the front desk can print or post the announcement.
//
// One row addresses the whole receptionist ROLE, so the message can only be
// written in one language: the publisher's, which is what `locale` carries. The
// alternative: picking a language on behalf of several readers: would have to
// be a guess, and the sheet is attached in the same language, so reader and
// document at least agree.
async function notifyReceptionistOfEvent(event, actor, locale) {
  // `desk` is the PUBLISHER's language, and it covers the message row above and
  // the sheet attached to it. The pastor's own copy is rendered below by a
  // translator bound to the pastor, which is why that one is not named here.
  const desk = translator(locale);
  const dt = String(event.starts_at || '').replace('T', ' ').slice(0, 16);
  const sheet = plainTextSheet(event, locale);
  const body = desk('event.receptionistBody', {
    title: event.title,
    when: dt,
    collection: collectionLabel(desk, event.collection_type),
    sheet,
  });

  await pool.query(
    `INSERT INTO messages (sender_id, recipient_role, category, subject, body, payload, thread_key)
     VALUES ($1, 'receptionist', 'event', $2, $3, $4, $5)`,
    [
      actor.id,
      desk('event.receptionistSubject', { title: event.title }),
      body,
      JSON.stringify({ eventId: event.id, collectionType: event.collection_type, startsAt: event.starts_at, printable: sheet }),
      `event:${event.id}`,
    ]
  );

  // Also land it in the pastor's own feed so the publish is on record there.
  try {
    await notifyPastorOfRecord({
      recordType: 'event',
      recordId: event.id,
      url: event.workspace_service_id ? `/records/${event.workspace_service_id}` : '/records',
      locale,
      // `t` here is the PASTOR's translator (bound per recipient by
      // utils/notify.js), not the publisher's above.
      render: (t) => ({
        title: t('event.publishedTitle', { title: event.title }),
        summary: t('event.publishedSummary', {
          title: event.title,
          when: dt,
          collection: collectionLabel(t, event.collection_type),
        }),
      }),
    });
  } catch (e) {
    // Non-fatal: the receptionist message is the primary delivery path.
  }
}

// Auto-provision the temporary data-collection workspace for a published event.
// The workspace is a TYPED services row (service type "Special Event") on the
// event's date, pre-filled with the event's name, so the front desk can record
// attendance/offerings into it through the normal typed path (service type +
// date) with zero manual setup, and it joins to service_types like any other
// session (reports, breakdowns, and the pastor's records all see it).
// Idempotent: an event that already has a workspace never gets a duplicate.
async function ensureEventWorkspace(event, actor) {
  if (event.workspace_service_id) {
    const { rows: existingRows } = await pool.query('SELECT id FROM services WHERE id = $1', [event.workspace_service_id]);
    if (existingRows[0]) return existingRows[0].id;
  }

  // One shared "Special Event" type collects one-off events; sessions are per-date.
  let { rows: typeRows } = await pool.query("SELECT * FROM service_types WHERE key = 'special_event'");
  let type = typeRows[0];
  if (!type) {
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM service_types');
    const maxOrder = maxRows[0].m;
    const inserted = await pool.query(
      "INSERT INTO service_types (name, key, attendance_mode, sort_order) VALUES ('Special Event', 'special_event', 'both', $1) RETURNING id",
      [maxOrder + 1]
    );
    const { rows: createdRows } = await pool.query('SELECT * FROM service_types WHERE id = $1', [inserted.rows[0].id]);
    type = createdRows[0];
    await logAudit({ userId: actor.id, action: 'service_type_created', table: 'service_types', recordId: type.id, details: { key: 'special_event', auto: true } });
  }

  const eventDate = String(event.starts_at || '').slice(0, 10);
  // The event's own name becomes a sub-session of the Special Event type, so
  // every event workspace is uniquely addressable from the front desk's normal
  // typed path (type + date + sub-session): two events on the same day never
  // collide, and each shows up under its real name in the sub-session picker.
  const { rows: subRows } = await pool.query(
    'SELECT * FROM service_type_sessions WHERE service_type_id = $1 AND name = $2 AND is_active = 1',
    [type.id, event.title]
  );
  let sub = subRows[0];
  if (!sub) {
    const { rows: maxSubRows } = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) AS m FROM service_type_sessions WHERE service_type_id = $1',
      [type.id]
    );
    const maxSub = maxSubRows[0].m;
    const insertedSub = await pool.query(
      'INSERT INTO service_type_sessions (service_type_id, name, sort_order) VALUES ($1, $2, $3) RETURNING id',
      [type.id, event.title, maxSub + 1]
    );
    sub = { id: insertedSub.rows[0].id };
  }
  // (date, type, sub-session) identifies a session uniquely; adopt an existing
  // row only for a genuinely identical gathering (same title, same day).
  let sessionId;
  const { rows: existingSessionRows } = await pool.query(
    'SELECT id FROM services WHERE date = $1 AND service_type_id = $2 AND sub_session_id = $3',
    [eventDate, type.id, sub.id]
  );
  if (existingSessionRows[0]) {
    sessionId = existingSessionRows[0].id;
  } else {
    const { rows: insertedSession } = await pool.query(
      `INSERT INTO services (name, date, is_temporary, event_title, event_description, service_type_id, sub_session_id)
       VALUES ($1, $2, 1, $3, $4, $5, $6) RETURNING id`,
      [event.title, eventDate, event.title, event.description || null, type.id, sub.id]
    );
    sessionId = insertedSession[0].id;
  }
  await pool.query('UPDATE events SET workspace_service_id = $1 WHERE id = $2', [sessionId, event.id]);
  event.workspace_service_id = sessionId;
  await logAudit({ userId: actor.id, action: 'event_workspace_provisioned', table: 'services', recordId: sessionId, details: { eventId: event.id, title: event.title, date: eventDate } });
  return sessionId;
}

// GET /api/events: shared calendar. Published events are visible to everyone
// with an account; drafts are visible only to their owner (or admins).
// Query: ?status=published|draft&from=&to=
router.get('/', async (req, res) => {
  try {
    const { status, from, to } = req.query;

    // Default view: the full calendar, published events plus your drafts
    // (admins see every draft too).
    if (!status && !from && !to) {
      const isAdmin = ['admin', 'superadmin'].includes(req.user.role);
      const where = isAdmin
        ? `(e.status = 'published') OR (e.status = 'draft')`
        : `(e.status = 'published') OR (e.status = 'draft' AND e.created_by = $1)`;
      const params = isAdmin ? [] : [req.user.id];
      const { rows: events } = await pool.query(
        `SELECT e.*, u.name AS created_by_name FROM events e JOIN users u ON u.id = e.created_by
         WHERE ${where} ORDER BY e.starts_at, e.id`,
        params
      );
      return res.json({ events });
    }

    const clauses = [];
    const params = [];
    if (status === 'draft' && !['admin', 'superadmin'].includes(req.user.role)) {
      clauses.push('e.created_by = ?');
      params.push(req.user.id);
    }
    if (status) { clauses.push('e.status = ?'); params.push(status); }
    if (from) { clauses.push('e.starts_at >= ?'); params.push(from); }
    if (to) { clauses.push('e.starts_at <= ?'); params.push(to); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows: events } = await pool.query(
      toParams(`SELECT e.*, u.name AS created_by_name FROM events e JOIN users u ON u.id = e.created_by ${where} ORDER BY e.starts_at, e.id`),
      params
    );
    res.json({ events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadEvents' });
  }
});

// GET /api/events/pending-finalization, the finalize review queue: published
// events that have ended but whose data-collection workspace is still marked
// temporary. Each row carries the recorded totals so the dashboard can show
// exactly what will move into the permanent record at a glance. MUST be
// registered before GET /:id, which would otherwise swallow the path.
router.get('/pending-finalization', requireRole('admin', 'pastor', 'superadmin'), async (req, res) => {
  try {
    // The church's own date, not UTC (utils/date.js): for three hours each
    // night the UTC date is still yesterday, which would keep an event that
    // ended last evening out of the review queue.
    const today = todayISO();
    const { rows: events } = await pool.query(
      `SELECT e.id, e.title, e.starts_at, e.collection_type, e.workspace_service_id,
              (SELECT COALESCE(SUM(COALESCE(a.count,
                 (SELECT COUNT(*) FROM attendance_attendees aa WHERE aa.attendance_id = a.id)
               )), 0) FROM attendance a WHERE a.service_id = s.id AND a.voided_at IS NULL) AS attendance,
              (SELECT COALESCE(SUM(o.amount), 0) FROM offerings o WHERE o.service_id = s.id AND o.voided_at IS NULL) AS offerings,
              (SELECT COUNT(*) FROM offerings o WHERE o.service_id = s.id AND o.voided_at IS NULL) AS gift_count
       FROM events e
       JOIN services s ON s.id = e.workspace_service_id
       WHERE e.status = 'published' AND s.is_temporary = 1 AND substr(e.starts_at, 1, 10) < $1
       ORDER BY e.starts_at ASC`,
      [today]
    );
    res.json({ events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadFinalizeQueue' });
  }
});

// GET /api/events/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: 'errors.eventNotFound' });
    if (event.status === 'draft' && !canManage(event, req.user)) return res.status(403).json({ error: 'errors.eventStillDraft' });
    res.json({ event });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadEvent' });
  }
});

// GET /api/events/:id/printable-sheet: clean printable announcement for the
// front desk (print or post it at reception). ?format=html|pdf serves the
// branded renderers; default is the plain-text JSON sheet.
router.get('/:id/printable-sheet', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: 'errors.eventNotFound' });
    if (event.status === 'draft' && !canManage(event, req.user)) return res.status(403).json({ error: 'errors.eventStillDraft' });
    // All three renders are server-side documents, so the language is handed to
    // them directly: the sheet the front desk prints is in the language the front
    // desk asked for, sheet, headings and collection type alike.
    if (req.query.format === 'pdf') {
      const buf = await pdfSheet(event, req.locale);
      res.header('Content-Type', 'application/pdf');
      res.header('Content-Disposition', `inline; filename="event-${event.id}.pdf"`);
      return res.send(buf);
    }
    if (req.query.format === 'html') {
      res.header('Content-Type', 'text/html; charset=utf-8');
      return res.send(htmlSheet(event, req.locale));
    }
    res.json({ sheet: plainTextSheet(event, req.locale) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.notRenderEventSheet' });
  }
});

// POST /api/events: the pastor (or an admin) creates a draft announcement.
router.post('/', requireRole('pastor', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { title, description, location, startsAt, endsAt, kind, status, collectionType } = req.body;
    if (!title || !String(title).trim()) return res.status(400).json({ error: 'errors.titleRequired' });
    if (!startsAt) return res.status(400).json({ error: 'errors.startDateTimeRequired' });
    if (endsAt && endsAt < startsAt) return res.status(400).json({ error: 'errors.eventCannotEndBeforeStarts' });
    if (kind && !KINDS.includes(kind)) return res.status(400).json({ error: 'errors.unknownEventKind' });
    if (collectionType !== undefined && !COLLECTION_TYPES.includes(collectionType)) {
      return res.status(400).json({ error: 'errors.unknownCollectionType' });
    }

    const { rows } = await pool.query(
      `INSERT INTO events (title, description, location, starts_at, ends_at, kind, status, collection_type, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        String(title).trim(),
        description || null,
        location || null,
        String(startsAt),
        endsAt || null,
        kind || 'event',
        status === 'published' ? 'published' : 'draft',
        COLLECTION_TYPES.includes(collectionType) ? collectionType : 'attendance',
        req.user.id,
      ]
    );
    const { rows: createdRows } = await pool.query('SELECT * FROM events WHERE id = $1', [rows[0].id]);
    const event = createdRows[0];
    // Publishing on creation immediately provisions the front desk's data-collection
    // workspace and notifies the receptionist: same path as the PATCH publish flow.
    if (event.status === 'published') {
      await ensureEventWorkspace(event, req.user);
      await notifyReceptionistOfEvent(event, req.user, req.locale);
    }
    await logAudit({ userId: req.user.id, action: 'event_created', table: 'events', recordId: event.id, details: { title, status: event.status, collectionType: event.collection_type }, ip: req.ip });
    res.status(201).json({ event });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreateEvent' });
  }
});

// PATCH /api/events/:id: edit details, or publish/unpublish.
router.patch('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: 'errors.eventNotFound' });
    if (!canManage(event, req.user)) return res.status(403).json({ error: 'errors.onlyCreatorAdminEditEvent' });

    const { title, description, location, startsAt, endsAt, kind, status, collectionType } = req.body;
    if (title !== undefined && !String(title).trim()) return res.status(400).json({ error: 'errors.titleRequired' });
    if (startsAt !== undefined && !startsAt) return res.status(400).json({ error: 'errors.startDateTimeRequired' });
    const nextStart = startsAt !== undefined ? String(startsAt) : event.starts_at;
    if ((endsAt !== undefined ? String(endsAt) : event.ends_at) && (endsAt !== undefined ? String(endsAt) : event.ends_at) < nextStart) {
      return res.status(400).json({ error: 'errors.eventCannotEndBeforeStarts' });
    }
    if (kind !== undefined && !KINDS.includes(kind)) return res.status(400).json({ error: 'errors.unknownEventKind' });
    if (status !== undefined && !['draft', 'published'].includes(status)) return res.status(400).json({ error: 'errors.statusDraftPublished' });
    if (collectionType !== undefined && !COLLECTION_TYPES.includes(collectionType)) {
      return res.status(400).json({ error: 'errors.unknownCollectionType' });
    }

    await pool.query(
      `UPDATE events SET title = $1, description = $2, location = $3, starts_at = $4, ends_at = $5, kind = $6, status = $7, collection_type = $8, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $9`,
      [
        title !== undefined ? String(title).trim() : event.title,
        description !== undefined ? description : event.description,
        location !== undefined ? location : event.location,
        nextStart,
        endsAt !== undefined ? endsAt : event.ends_at,
        kind !== undefined ? kind : event.kind,
        status !== undefined ? status : event.status,
        collectionType !== undefined ? (COLLECTION_TYPES.includes(collectionType) ? collectionType : 'attendance') : event.collection_type,
        event.id,
      ]
    );
    await logAudit({ userId: req.user.id, action: status === 'published' ? 'event_published' : 'event_updated', table: 'events', recordId: event.id, details: { title: title || event.title, status }, ip: req.ip });
    const { rows: updatedRows } = await pool.query('SELECT * FROM events WHERE id = $1', [event.id]);
    const updated = updatedRows[0];
    // Transitioning draft → published is the moment the front desk's workspace is
    // provisioned and the receptionist is notified (idempotent: only on the
    // draft→published transition, so re-saves never re-provision or re-notify).
    if (updated.status === 'published' && event.status !== 'published') {
      await ensureEventWorkspace(updated, req.user);
      await notifyReceptionistOfEvent(updated, req.user, req.locale);
    }
    res.json({ event: updated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateEvent' });
  }
});

// DELETE /api/events/:id: only drafts (or unpublished) can be deleted.
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: 'errors.eventNotFound' });
    if (!canManage(event, req.user)) return res.status(403).json({ error: 'errors.onlyCreatorAdminDeleteEvent' });
    if (event.status !== 'draft') return res.status(400).json({ error: 'errors.publishedEventsCannotDeletedUnpublishThemFirst' });
    await pool.query('DELETE FROM events WHERE id = $1', [event.id]);
    await logAudit({ userId: req.user.id, action: 'event_deleted', table: 'events', recordId: event.id, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedDeleteEvent' });
  }
});

// POST /api/events/:id/finalize: after the event has run, promote its temporary
// data-collection workspace into the permanent record: the services row loses
// its temporary flag (and keeps the event's name/date/description), a summary
// notification with the recorded totals lands in the pastor's feed, and the
// audit trail records the promotion. Idempotent: an event without a workspace,
// or already promoted, responds 409/400 instead of acting twice.
router.post('/:id/finalize', requireRole('pastor', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: 'errors.eventNotFound' });
    if (!canManage(event, req.user)) return res.status(403).json({ error: 'errors.onlyCreatorAdminFinalizeEvent' });
    if (event.status !== 'published') return res.status(409).json({ error: 'errors.draftEventsCannotFinalizedPublishEventFirst' });
    if (!event.workspace_service_id) return res.status(409).json({ error: 'errors.eventNoDataCollectionWorkspaceFinalize' });

    const { rows: sessionRows } = await pool.query('SELECT * FROM services WHERE id = $1', [event.workspace_service_id]);
    const session = sessionRows[0];
    if (!session) return res.status(409).json({ error: 'errors.workspaceEventNoLongerExists' });
    if (!session.is_temporary) return res.status(409).json({ error: 'errors.eventAlreadyFinalized' });

    const { rows: statsRows } = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(COALESCE(a.count,
            (SELECT COUNT(*) FROM attendance_attendees aa WHERE aa.attendance_id = a.id)
          )), 0) FROM attendance a WHERE a.service_id = s.id AND a.voided_at IS NULL) AS attendance,
         (SELECT COALESCE(SUM(o.amount), 0) FROM offerings o WHERE o.service_id = s.id AND o.voided_at IS NULL) AS offerings,
         (SELECT COUNT(*) FROM offerings o WHERE o.service_id = s.id AND o.voided_at IS NULL) AS gift_count
       FROM services s WHERE s.id = $1`,
      [session.id]
    );
    const stats = statsRows[0];

    // services carries no updated_at column (see db/schema.sql): the flag flip is
    // enough; the promotion itself is the audit-log row.
    await pool.query('UPDATE services SET is_temporary = 0 WHERE id = $1', [session.id]);

    await notifyPastorOfRecord({
      recordType: 'event',
      recordId: event.id,
      url: `/records/${session.id}`,
      locale: req.locale,
      // Rendered per pastor, in the pastor's own language: the counts are the
      // record and read the same, only the frame around them changes.
      render: (t, language) => ({
        title: t('event.finalizedTitle', { title: event.title }),
        summary: t('event.finalizedSummary', {
          title: event.title,
          date: String(event.starts_at || '').slice(0, 10),
          attendance: stats.attendance,
          gifts: stats.gift_count,
          total: Number(stats.offerings).toLocaleString(intlLocale(language)),
          currency: 'TZS',
        }),
      }),
    });

    await logAudit({
      userId: req.user.id,
      action: 'event_finalized',
      table: 'services',
      recordId: session.id,
      details: { eventId: event.id, title: event.title, attendance: stats.attendance, offerings: stats.offerings, gifts: stats.gift_count },
      ip: req.ip,
    });

    res.json({ success: true, summary: { attendance: stats.attendance, offerings: stats.offerings, gifts: stats.gift_count } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedFinalizeEvent' });
  }
});

// POST /api/events/:id/announce: blast the announcement to members.
// SMS goes to every active member with a stored phone number; members with an
// email but NO phone get the same announcement by email (no member is contacted
// twice). Every send is logged in notifications_log ('sent', or 'pending' when
// SMS/SMTP is not configured, so nothing is silently lost). One blast per
// event: a second call responds 409 rather than double-texting the congregation.
router.post('/:id/announce', requireRole('pastor', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: 'errors.eventNotFound' });
    if (!canManage(event, req.user)) return res.status(403).json({ error: 'errors.onlyCreatorAdminAnnounceEvent' });
    if (event.status !== 'published') return res.status(400).json({ error: 'errors.draftEventsCannotAnnouncedPublishEventFirst' });
    if (event.announced_at) return res.status(409).json({ error: 'errors.eventAlreadyAnnouncedMembers' });

    const { rows: members } = await pool.query(
      "SELECT id, name, phone_enc, email FROM members WHERE is_active = 1 AND (phone_enc IS NOT NULL AND phone_enc != '' OR email IS NOT NULL AND email != '')"
    );

    const smsMembers = [];
    const emailMembers = [];
    for (const m of members) {
      let hasPhone = false;
      if (m.phone_enc) {
        try {
          if (decryptField(m.phone_enc)) hasPhone = true;
        } catch (e) {
          // Undecryptable number: skip the phone channel for this member.
        }
      }
      if (hasPhone) smsMembers.push(m);
      else if (m.email) emailMembers.push(m);
    }
    if (!smsMembers.length && !emailMembers.length) {
      return res.status(409).json({ error: 'errors.noMembersPhoneNumberEmailAnnounce' });
    }

    // The blast goes to members, who have no language of their own stored, so it
    // follows the caller's: the language the announcement was written in.
    const t = translator(req.locale);
    const when = String(event.starts_at || '').replace('T', ' ').slice(0, 16);
    const collection = collectionLabel(t, event.collection_type);
    const smsText = [
      t('event.announceSubject', { title: event.title }),
      t('event.lineWhen', { when }),
      event.location ? t('event.lineWhere', { where: event.location }) : null,
      t('event.welcome', { collection }),
    ].filter(Boolean).join('\n');
    const emailSubject = t('event.announceSubject', { title: event.title });
    const emailText = [
      t('event.emailHead', { title: event.title }),
      t('event.lineWhen', { when }),
      event.location ? t('event.lineWhere', { where: event.location }) : null,
      event.description ? `\n${event.description}` : null,
      t('event.welcome', { collection }),
    ].filter(Boolean).join('\n');

    let smsSent = 0;
    for (const m of smsMembers) {
      try {
        // record_type 'event_announce' scopes the blast's log rows to the blast
        // itself, so the delivery report is never polluted by the publish-time
        // pastor notification (which shares record_type 'event' + record_id).
        await sendSms({ to: decryptField(m.phone_enc), message: smsText, recordType: 'event_announce', recordId: event.id });
        smsSent += 1;
      } catch (e) {
        // A single undecryptable/missing number must never abort the blast or
        // crash the process (async route handlers are not caught by Express 4).
        continue;
      }
    }
    let emailSent = 0;
    for (const m of emailMembers) {
      try {
        await sendEmail({ to: m.email, subject: emailSubject, text: emailText, recordType: 'event_announce', recordId: event.id });
        emailSent += 1;
      } catch (e) {
        continue;
      }
    }

    await pool.query("UPDATE events SET announced_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1", [event.id]);
    await logAudit({
      userId: req.user.id,
      action: 'event_announced',
      table: 'events',
      recordId: event.id,
      details: { title: event.title, sms: smsSent, email: emailSent },
      ip: req.ip,
    });

    res.json({ success: true, recipients: smsSent + emailSent, sms: smsSent, email: emailSent });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedAnnounceEvent' });
  }
});

// GET /api/events/:id/announce-report: delivery breakdown for the announcement
// blast: per-channel sent/failed/pending counts from the notification log.
// Pending means the channel is not configured (or the provider hasn't settled);
// failed means the provider rejected that send. Only meaningful once the event
// has been announced (409 before that).
router.get('/:id/announce-report', requireRole('pastor', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [req.params.id]);
    const event = rows[0];
    if (!event) return res.status(404).json({ error: 'errors.eventNotFound' });
    if (!canManage(event, req.user)) return res.status(403).json({ error: 'errors.onlyCreatorAdminViewReport' });
    if (!event.announced_at) return res.status(409).json({ error: 'errors.eventNotAnnouncedMembersYet' });

    const { rows: counts } = await pool.query(
      `SELECT channel, status, COUNT(*) AS n
       FROM notifications_log
       WHERE record_type = 'event_announce' AND record_id = $1 AND channel IN ('sms', 'email')
       GROUP BY channel, status`,
      [event.id]
    );

    const byChannel = { sms: { sent: 0, failed: 0, pending: 0 }, email: { sent: 0, failed: 0, pending: 0 } };
    for (const r of counts) {
      if (byChannel[r.channel] && r.status in byChannel[r.channel]) byChannel[r.channel][r.status] = r.n;
    }
    res.json({ announcedAt: event.announced_at, channels: byChannel });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadAnnouncementReport' });
  }
});

module.exports = router;
