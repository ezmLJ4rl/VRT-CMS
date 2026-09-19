const pool = require('../db/pg');
const { intlLocale, plural, translator } = require('../i18n');
const { todayISO } = require('./date');
const { pushInApp, sendWebPush } = require('./notify');
const { readDonorField } = require('./donorFields');
const { logAudit } = require('./audit');

/**
 * Batched notifications. Recording attendance/offerings never pings the pastor
 * per row (notification fatigue). Instead staff trigger one summary: everything
 * recorded today that hasn't been notified yet is collected parish-wide, flagged
 * with notified_at/notified_by, and delivered to the pastor as a single rich
 * message (with attendee names and giver names) so the pastor sees real,
 * organized data: exactly once per batch.
 */

async function collectPending() {
  const today = todayISO();

  const { rows: attendance } = await pool.query(
    `SELECT a.id, a.count, a.mode,
            s.name AS session_name, s.sub_session_id,
            st.name AS type_name,
            ss.name AS sub_session_name,
            u.name AS recorded_by_name
     FROM attendance a
     JOIN services s ON s.id = a.service_id
     LEFT JOIN service_types st ON st.id = s.service_type_id
     LEFT JOIN service_type_sessions ss ON ss.id = a.sub_session_id
     JOIN users u ON u.id = a.recorded_by
     WHERE s.date = $1 AND a.notified_at IS NULL AND a.voided_at IS NULL
     ORDER BY a.timestamp ASC`,
    [today]
  );

  const ids = attendance.map((a) => a.id);
  if (ids.length) {
    // Dynamic IN (...): build numbered placeholders directly for pg.
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rows: attendees } = await pool.query(
      `SELECT aa.attendance_id, aa.name, m.member_no
       FROM attendance_attendees aa
       LEFT JOIN members m ON m.id = aa.member_id
       WHERE aa.attendance_id IN (${ph}) ORDER BY aa.id`,
      ids
    );
    const byRow = {};
    for (const x of attendees) {
      (byRow[x.attendance_id] = byRow[x.attendance_id] || []).push(x.member_no ? `${x.name} (${x.member_no})` : x.name);
    }
    for (const a of attendance) a.attendees = byRow[a.id] || [];
  }

  const { rows: offerings } = await pool.query(
    `SELECT o.id, o.type, o.amount, o.currency, o.project_name, o.receipt_number,
            o.offerer_name_enc, o.reason,
            s.name AS session_name,
            st.name AS type_name,
            oc.name AS category_name
     FROM offerings o
     JOIN services s ON s.id = o.service_id
     LEFT JOIN service_types st ON st.id = s.service_type_id
     LEFT JOIN offering_categories oc ON oc.id = o.category_id
     WHERE o.recorded_by IN (SELECT id FROM users WHERE role IN ('receptionist','admin','superadmin'))
       AND s.date = $1 AND o.notified_at IS NULL AND o.voided_at IS NULL
     ORDER BY o.timestamp ASC`,
    [today]
  );
  for (const o of offerings) {
    const { value, unreadable } = readDonorField(o.offerer_name_enc, { table: 'offerings', id: o.id, field: 'offerer_name_enc' });
    o.giverName = value;
    o.giverNameUnavailable = unreadable;
  }

  return { attendance, offerings };
}

// Runs every statement on the caller's transaction client so the flags and the
// message row commit (or roll back) together.
async function markNotified(client, userId, ids) {
  const now = new Date().toISOString();
  for (const id of ids.attendance) {
    await client.query('UPDATE attendance SET notified_at = $1, notified_by = $2 WHERE id = $3', [now, userId, id]);
  }
  for (const id of ids.offerings) {
    await client.query('UPDATE offerings SET notified_at = $1, notified_by = $2 WHERE id = $3', [now, userId, id]);
  }
}

/**
 * The digest the pastor reads, in `t`'s language. Only the FRAME is translated:
 * the session labels, the giver names and the receipt numbers ARE the record and
 * read the same either way, so they are passed through, never looked up.
 */
function attendanceMetrics(a) {
  const attendees = a.attendees || [];
  const hasCount = a.count !== null && a.count !== undefined;
  const metrics = [];
  if (a.mode === 'headcount' || a.mode === 'both') {
    if (hasCount || a.mode === 'headcount') metrics.push({ kind: 'recorded', count: Number(a.count || 0) });
  }
  if (a.mode === 'named' || a.mode === 'both') {
    metrics.push({ kind: 'unique', count: attendees.length });
  }
  return metrics;
}

function attendanceMetric(a) {
  const metric = attendanceMetrics(a).find((item) => item.kind === 'unique') || attendanceMetrics(a)[0] || { kind: 'recorded', count: 0 };
  return { unique: metric.kind === 'unique', count: metric.count };
}

function buildDigestText(t, locale, userName, attendance, offerings) {
  const lines = [t('digest.intro', { user: userName })];
  if (attendance.length) {
    lines.push('');
    lines.push(plural(
      t, attendance.length,
      'digest.attendanceHeading_one', 'digest.attendanceHeading_other',
      { count: attendance.length }
    ));
    for (const a of attendance) {
      const label = a.sub_session_name ? `${a.type_name} \u00b7 ${a.sub_session_name}` : a.type_name;
      const metrics = attendanceMetrics(a);
      if (metrics.length > 1) {
        lines.push(t('digest.attendanceBothLine', {
          label,
          recorded: metrics.find((metric) => metric.kind === 'recorded')?.count || 0,
          unique: metrics.find((metric) => metric.kind === 'unique')?.count || 0,
          recordedMetric: t('digest.recordedHeadcount'),
          uniqueMetric: t('digest.uniqueAttendees'),
        }));
      } else {
        const metric = metrics[0] || { kind: 'recorded', count: 0 };
        lines.push(t('digest.attendanceLine', {
          label,
          count: metric.count,
          metric: t(metric.kind === 'unique' ? 'digest.uniqueAttendees' : 'digest.recordedHeadcount'),
        }));
      }
      if (a.attendees && a.attendees.length && a.attendees.length <= 25) {
        lines.push(t('digest.attendeeLine', { names: a.attendees.join(', ') }));
      }
    }
  }
  if (offerings.length) {
    lines.push('');
    lines.push(plural(
      t, offerings.length,
      'digest.offeringHeading_one', 'digest.offeringHeading_other',
      { count: offerings.length }
    ));
    for (const o of offerings) {
      let line = t('digest.offeringLine', {
        category: o.category_name || o.type,
        amount: Number(o.amount).toLocaleString(intlLocale(locale)),
        currency: o.currency,
      });
      // The two optional clauses are their own keys so a language can move them
      // (a Kiswahili sentence may want the receipt first) without touching code.
      if (o.giverName) line += t('digest.giverSuffix', { giver: o.giverName });
      if (o.receipt_number) line += t('digest.receiptSuffix', { receipt: o.receipt_number });
      lines.push(line);
    }
  }
  if (!attendance.length && !offerings.length) {
    lines.push(t('digest.nothing'));
  }
  return lines.join('\n');
}

function buildDigestPayload(date, attendance, offerings) {
  return {
    date,
    // Do not publish one aggregate "people" total: headcounts cannot be
    // deduplicated and named attendees are only unique within their own session.
    attendanceSessions: attendance.length,
    totalOfferings: offerings.reduce((s, o) => s + Number(o.amount || 0), 0),
    currency: offerings[0]?.currency || 'TZS',
    attendance: attendance.map((a) => ({
      id: a.id,
      label: a.sub_session_name ? `${a.type_name} \u00b7 ${a.sub_session_name}` : a.type_name,
      typeName: a.type_name,
      subSession: a.sub_session_name,
      mode: a.mode,
      count: attendanceMetric(a).count,
      metric: attendanceMetric(a).unique ? 'unique' : 'recorded',
      recordedCount: attendanceMetrics(a).find((metric) => metric.kind === 'recorded')?.count ?? null,
      uniqueCount: attendanceMetrics(a).find((metric) => metric.kind === 'unique')?.count ?? null,
      attendees: a.attendees || [],
      recordedBy: a.recorded_by_name,
    })),
    offerings: offerings.map((o) => ({
      id: o.id,
      category: o.category_name || o.type,
      type: o.type,
      service: o.session_name,
      serviceType: o.type_name,
      amount: o.amount,
      currency: o.currency,
      giver: o.giverName,
      project: o.project_name,
      reason: o.reason,
      receipt: o.receipt_number,
    })),
  };
}

function parsePayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  try { return JSON.parse(payload); } catch { return {}; }
}

function mergeDigestPayload(existing, incoming) {
  const attendance = new Map();
  const offerings = new Map();
  for (const row of [...(existing.attendance || []), ...(incoming.attendance || [])]) attendance.set(String(row.id), row);
  for (const row of [...(existing.offerings || []), ...(incoming.offerings || [])]) offerings.set(String(row.id), row);
  const mergedAttendance = [...attendance.values()];
  const mergedOfferings = [...offerings.values()];
  return {
    ...incoming,
    attendanceSessions: mergedAttendance.length,
    totalOfferings: mergedOfferings.reduce((sum, row) => sum + Number(row.amount || 0), 0),
    currency: incoming.currency || existing.currency || 'TZS',
    attendance: mergedAttendance,
    offerings: mergedOfferings,
  };
}

function attendanceRowsFromPayload(payload) {
  return (payload.attendance || []).map((row) => ({
    ...row,
    type_name: row.typeName || row.type_name || String(row.label || 'Service').split(' · ')[0],
    sub_session_name: row.subSession ?? row.sub_session_name ?? null,
    count: row.recordedCount ?? row.count ?? 0,
  }));
}

function offeringRowsFromPayload(payload) {
  return (payload.offerings || []).map((row) => ({
    ...row,
    category_name: row.category || row.category_name || row.type,
    type: row.type || row.category,
    giverName: row.giver,
    receipt_number: row.receipt,
    session_name: row.service,
  }));
}

/**
 * Writes the in-app feed entry and the message row on the caller's transaction
 * client so the digest never appears in the feed while the flagging of the
 * underlying records is rolled back. Web Push is inherently non-transactional
 * (external service), so the pushes it needed are returned to the caller and
 * fired after COMMIT: a failed push just means the pastor misses the ping,
 * never the message itself.
 *
 * The text is written per pastor, not once for all of them: the digest is sent BY
 * the front desk but READ by the pastor, so it is written in the pastor's own
 * saved language. `locale` (the sender's) is only the fallback for an account
 * that has never chosen one.
 */
async function postDigestToPastor(client, { senderId, userName, locale, attendance, offerings, payload }) {
  const { rows: pastors } = await client.query("SELECT * FROM users WHERE role = 'pastor' AND is_active = 1 ORDER BY id ASC");
  let insertedId = null;
  const pushes = [];
  const incoming = parsePayload(payload);
  for (const pastor of pastors) {
    const language = pastor.language_pref || locale;
    const t = translator(language);
    // A digest is a dated document, not a send event. If a staff member sends
    // again after recording another category, update that day's existing
    // document instead of creating a second partial message.
    const { rows: existingRows } = await client.query(
      `SELECT m.id, m.payload FROM messages m
       JOIN notifications_log n ON n.message_id = m.id AND n.channel = 'in_app' AND n.sent_to = $1
       WHERE m.recipient_id IS NULL AND m.recipient_role = 'pastor'
         AND m.recalled_at IS NULL AND m.category IN ('attendance', 'offering')
         AND m.payload IS NOT NULL
       ORDER BY m.id DESC`,
      [pastor.email]
    );
    const existing = existingRows.find((row) => parsePayload(row.payload).date === incoming.date);
    const merged = existing ? mergeDigestPayload(parsePayload(existing.payload), incoming) : incoming;
    const mergedAttendance = attendanceRowsFromPayload(merged);
    const mergedOfferings = offeringRowsFromPayload(merged);
    const subject = t('digest.subject');
    const body = buildDigestText(t, language, userName, mergedAttendance, mergedOfferings);
    const category = mergedAttendance.length ? 'attendance' : 'offering';
    let messageId;
    if (existing) {
      await client.query(
        'UPDATE messages SET category = $1, subject = $2, body = $3, payload = $4, read_at = NULL WHERE id = $5',
        [category, subject, body, JSON.stringify(merged), existing.id]
      );
      messageId = existing.id;
      await client.query('UPDATE notifications_log SET read_at = NULL WHERE channel = \'in_app\' AND message_id = $1', [messageId]);
    } else {
      const result = await client.query(
        `INSERT INTO messages (sender_id, recipient_role, category, subject, body, payload)
         VALUES ($1, 'pastor', $5, $2, $3, $4) RETURNING id`,
        [senderId, subject, body, JSON.stringify(merged), category]
      );
      messageId = result.rows[0].id;
    }
    // Keep one notification twin for the dated document. An update may push
    // again, but it never adds a second feed row or a second unread item.
    const digestCategory = mergedAttendance.length ? 'attendance_digest' : 'offering_digest';
    const existingTwin = await client.query(
      'SELECT id FROM notifications_log WHERE channel = \'in_app\' AND message_id = $1 LIMIT 1',
      [messageId]
    );
    if (!existingTwin.rows[0]) {
      await pushInApp({ to: pastor.email, message: subject, recordType: digestCategory, recordId: null, url: '/messages', messageId }, client);
    }
    pushes.push({ pastor, subject, body });
    if (insertedId === null) insertedId = messageId;
  }
  return { insertedId, pushes };
}

/**
 * Collects + flags every un-notified record for today (parish-wide) and sends a
 * single rich digest to the pastor. Because records are flagged before the
 * message is inserted, a repeated trigger can never produce a duplicate.
 * Returns distinct recordedHeadcount and uniqueAttendees values (plus a legacy
 * `people` alias for existing desk clients), never one conflated attendance total.
 */
async function sendBatchDigest({ userId, userName, locale }) {
  const { attendance, offerings } = await collectPending();
  if (!attendance.length && !offerings.length) {
    return { sent: false, attendanceCount: 0, offeringsCount: 0, recordedHeadcount: 0, uniqueAttendees: 0, people: 0, total: 0 };
  }

  const date = todayISO();
  const payload = JSON.stringify(buildDigestPayload(date, attendance, offerings));

  // Atomicity: flagging the records as notified and inserting the digest
  // message must succeed or fail together. Previously the rows were flagged
  // BEFORE the insert, so any failure in between silently dropped the digest
  // while the records looked "already sent": they'd never be reported.
  let messageId = null;
  let pushes = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await markNotified(client, userId, { attendance: attendance.map((a) => a.id), offerings: offerings.map((o) => o.id) });
    const posted = await postDigestToPastor(client, { senderId: userId, userName, locale, attendance, offerings, payload });
    messageId = posted.insertedId;
    pushes = posted.pushes;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  // External, non-transactional channel: fire after commit, swallow failures.
  for (const { pastor, subject, body } of pushes) {
    sendWebPush({
      userId: pastor.id,
      title: subject,
      body: body.split('\n').slice(0, 6).join('\n'),
      url: '/messages',
      recordType: attendance.length ? 'attendance_digest' : 'offering_digest',
      recordId: null,
    }).catch(() => {});
  }

  const recordedHeadcount = attendance.reduce((sum, a) => sum + (attendanceMetrics(a).find((metric) => metric.kind === 'recorded')?.count || 0), 0);
  const uniqueAttendees = attendance.reduce((sum, a) => sum + (attendanceMetrics(a).find((metric) => metric.kind === 'unique')?.count || 0), 0);
  const total = offerings.reduce((s, o) => s + o.amount, 0);
  await logAudit({
    userId,
    action: 'digest_sent',
    table: 'messages',
    recordId: messageId,
    details: { attendanceCount: attendance.length, offeringsCount: offerings.length, recordedHeadcount, uniqueAttendees, total, currency: offerings[0]?.currency || 'TZS' },
  });
  return { sent: true, attendanceCount: attendance.length, offeringsCount: offerings.length, recordedHeadcount, uniqueAttendees, people: recordedHeadcount, total, currency: offerings[0]?.currency || 'TZS', messageId };
}

module.exports = { sendBatchDigest, collectPending };
