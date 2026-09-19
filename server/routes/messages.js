const express = require('express');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { pushAlertToUser, pushAlertToRole, PASTOR_NOTIFICATION_CATEGORIES } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);

const CATEGORIES = ['attendance', 'offering', 'member_alert', 'event', 'general'];

function threadKey(idA, idB) {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  return `U:${lo}:${hi}`;
}

function decorate(m) {
  const row = { ...m };
  if (m.payload) {
    try { row.payload = JSON.parse(m.payload); } catch (e) { /* keep as string */ }
  }
  return row;
}

// GET /api/messages, conversations for the current user: broadcasts aimed at
// their role plus direct threads they participate in.
//
// Recalled messages are absent from every read path (here, /unread, the thread
// view and the notification feed): a recall has to mean the pastor stops seeing
// it, not merely that a row changed. The sender's own record of what was
// withdrawn lives in GET /sent, where it is explicitly marked as recalled.
router.get('/', async (req, res) => {
  try {
    const me = req.user;

    const { rows: direct } = await pool.query(
      `SELECT m.thread_key AS conversation_id,
              MAX(m.id) AS last_id,
              SUM(CASE WHEN (m.recipient_id = $1 OR m.recipient_role = $2) AND m.read_at IS NULL AND m.sender_id != $3 THEN 1 ELSE 0 END) AS unread,
              (SELECT COUNT(*) FROM messages WHERE thread_key = m.thread_key AND recalled_at IS NULL) AS msgs
       FROM messages m
       WHERE (m.sender_id = $4 OR m.recipient_id = $5) AND m.thread_key IS NOT NULL
         AND m.recalled_at IS NULL
       GROUP BY m.thread_key`,
      [me.id, me.role, me.id, me.id, me.id]
    );

    const threads = [];
    for (const d of direct) {
      const { rows: lastRows } = await pool.query('SELECT * FROM messages WHERE id = $1', [d.last_id]);
      const last = lastRows[0];
      const { rows: partnerRows } = await pool.query('SELECT * FROM messages WHERE thread_key = $1 AND recalled_at IS NULL ORDER BY id ASC', [d.conversation_id]);
      const partnerMsg = partnerRows[0];
      const partnerId = partnerMsg.sender_id === me.id ? partnerMsg.recipient_id : partnerMsg.sender_id;
      const { rows: userRows } = await pool.query('SELECT id, name, role FROM users WHERE id = $1', [partnerId]);
      threads.push({
        id: d.conversation_id,
        msgs: d.msgs,
        unread: d.unread,
        last: {
          id: last.id,
          subject: last.subject,
          body: last.body,
          sentAt: last.sent_at,
          fromMe: last.sender_id === me.id,
        },
        partner: userRows[0],
      });
    }

    // `sent_at` is recorded to the second, so two updates sent in the same second
    // tie on it: without the id tiebreaker their order is whatever the database
    // happens to return, and a group's updates can then be read in the wrong
    // sequence, which is indistinguishable from the group having changed in that
    // order. Id is the order they were written, so it settles the tie the way
    // GET /sent already does.
    const { rows: broadcastRows } = await pool.query(
      `SELECT * FROM messages
       WHERE recipient_id IS NULL AND recipient_role = $1 AND recalled_at IS NULL
         AND NOT (category = 'member_alert' AND (payload LIKE '%"group"%' OR subject ILIKE 'Group update:%'))
       ORDER BY sent_at DESC, id DESC LIMIT 50`,
      [me.role]
    );
    const broadcasts = broadcastRows.map(decorate);

    res.json({ conversations: { threads, broadcasts } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadMessages' });
  }
});

// GET /api/messages/broadcast/:id: canonical detail for a broadcast message.
// The list endpoint intentionally carries only enough data to scan; this route
// supplies the full digest/notification payload for the dedicated detail page.
router.get('/broadcast/:id', requireRole('pastor'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM messages
       WHERE id = $1 AND recipient_id IS NULL AND recipient_role = 'pastor' AND recalled_at IS NULL`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'errors.messageNotFound' });
    res.json({ message: decorate(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadMessage' });
  }
});

// GET /api/messages/unread: one lightweight count the apps poll for badges.
//
// `total` is the single number every badge in the pastor app shows: the nav
// pill and the Home notifications tile must never be able to disagree, so they
// read the same field of the same response rather than counting for themselves.
//
// One event must count once. A batched digest writes BOTH
// a message row and an in-app notification, one feeds the conversation list,
// the other the activity feed, so counting every unread in-app row would report
// a single send as two unread things. The notification twins of a message are
// therefore excluded from `notifications`: 'attendance_digest' and
// 'offering_digest' (the digest's in-app twin).
//
// NOTIFICATION_TWIN_RECORD_TYPES is the single place that rule lives, and the
// server test asserts it matches what routes/digest actually
// write, so adding a third message-carrying notification cannot silently
// double-count the badge.
const NOTIFICATION_TWIN_RECORD_TYPES = ['attendance_digest', 'offering_digest'];
router.get('/unread', async (req, res) => {
  try {
    const me = req.user;
    // A recalled message is unread for nobody: the row stays for the record, but
    // it is no longer something to notice, so it leaves the badge with it.
    const { rows: threadRows } = await pool.query(
      `SELECT COALESCE(SUM(
         CASE WHEN (m.recipient_id = $1 OR m.recipient_role = $2) AND m.read_at IS NULL AND m.sender_id != $3 THEN 1 ELSE 0 END
       ), 0) AS n
       FROM messages m
       WHERE (m.sender_id = $4 OR m.recipient_id = $5) AND m.thread_key IS NOT NULL
         AND m.recalled_at IS NULL`,
      [me.id, me.role, me.id, me.id, me.id]
    );
    const { rows: broadcastRows } = await pool.query(
      "SELECT COUNT(*) AS n FROM messages WHERE recipient_id IS NULL AND recipient_role = $1 AND read_at IS NULL AND recalled_at IS NULL AND NOT (category = 'member_alert' AND (payload LIKE '%group%' OR subject ILIKE 'Group update:%'))",
      [me.role]
    );
    // An in-app announcement whose message was recalled is withheld from the
    // notification count exactly as it is from the notification feed. Rows that
    // announce something other than a message (message_id IS NULL) count as
    // before.
    const { rows: notificationRows } = await pool.query(
      `SELECT COUNT(*) AS n FROM notifications_log
       WHERE channel = 'in_app' AND sent_to = $1 AND read_at IS NULL AND record_type = ANY($2::text[])
         AND (message_id IS NULL
              OR EXISTS (SELECT 1 FROM messages m WHERE m.id = notifications_log.message_id AND m.recalled_at IS NULL))`,
      [me.email, PASTOR_NOTIFICATION_CATEGORIES.filter((type) => !NOTIFICATION_TWIN_RECORD_TYPES.includes(type))]
    );
    const unread = Number(threadRows[0].n || 0) + Number(broadcastRows[0].n || 0);
    const notifications = Number(notificationRows[0].n || 0);
    res.json({ unread, notifications, total: unread + notifications });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadUnreadCount' });
  }
});

/**
 * GET /api/messages/sent: what has gone out to the pastor, so a mistake can be
 * seen and taken back from the app instead of hunted for in the database.
 *
 * Scoped by role: the front desk sees its own sends, which is what it is
 * responsible for, while an admin sees every send (that is what the oversight
 * role is for). Recalled messages are listed here, this is the one view that
 * keeps them, precisely so "what did we take back?" has an answer, and they are
 * marked rather than filtered.
 *
 * `read_at` rides along deliberately: a recall stops the pastor from seeing the
 * message again, but it cannot unring a message they already opened, and the
 * front desk deserves to know which case it is in before deciding.
 */
router.get('/sent', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const me = req.user;
    const ownOnly = me.role === 'receptionist';
    const toPastor = req.query.to === 'pastor';
    const { rows } = await pool.query(
      `SELECT m.id, m.sender_id, m.recipient_id, m.recipient_role, m.category,
              m.subject, m.body, m.sent_at, m.read_at, m.recalled_at,
              u.name AS recalled_by_name, s.name AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.recalled_by
       LEFT JOIN users s ON s.id = m.sender_id
       WHERE ($1::boolean = false OR m.sender_id = $2)
         AND ($3::boolean = false OR m.recipient_role = 'pastor')
       ORDER BY m.sent_at DESC, m.id DESC
       LIMIT 30`,
      [ownOnly, me.id, toPastor]
    );
    res.json({
      sent: rows.map((m) => ({
        ...m,
        recalled: !!m.recalled_at,
        read: !!m.read_at,
        canRecall: !m.recalled_at && (m.sender_id === me.id || me.role === 'admin' || me.role === 'superadmin'),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadSentMessages' });
  }
});

/**
 * POST /api/messages/:id/recall: take a message back from the pastor's feed.
 *
 * What it does: stamps `recalled_at`/`recalled_by`, and from then on every read
 * path (the pastor's feed, thread view, unread badge and notification list)
 * skips the row. What it cannot do: unsend a push notification that has already
 * reached a phone: no API can reach into a handset's notification tray. The UI
 * says so rather than implying a recall is invisible if it is not.
 *
 * Who may: the sender, or an admin/superadmin cleaning up after someone else.
 * A receptionist cannot recall a colleague's message. Already-recalled is not an
 * error: the caller asked for the end state and it holds, and re-recalling
 * writes no second audit entry, so the log counts withdrawals, not clicks.
 *
 * The row is never deleted: the audit trail and the sender's own /sent view both
 * depend on it still existing.
 */
router.post('/:id/recall', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const me = req.user;
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [req.params.id]);
    const message = rows[0];
    if (!message) return res.status(404).json({ error: 'errors.messageNotFound' });

    const isAdmin = me.role === 'admin' || me.role === 'superadmin';
    if (message.sender_id !== me.id && !isAdmin) {
      return res.status(403).json({ error: 'errors.cannotRecallMessage' });
    }
    if (message.recalled_at) {
      return res.json({ id: message.id, recalledAt: message.recalled_at, alreadyRecalled: true });
    }

    const { rows: updated } = await pool.query(
      "UPDATE messages SET recalled_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), recalled_by = $1 WHERE id = $2 RETURNING recalled_at",
      [me.id, message.id]
    );
    await logAudit({
      userId: me.id,
      action: 'message_recalled',
      table: 'messages',
      recordId: message.id,
      details: {
        to: message.recipient_id || message.recipient_role,
        category: message.category,
        sentAt: message.sent_at,
        wasRead: !!message.read_at,
        byAdmin: message.sender_id !== me.id,
      },
      ip: req.ip,
    });
    res.json({ id: message.id, recalledAt: updated[0].recalled_at, alreadyRecalled: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRecallMessage' });
  }
});

// GET /api/messages/:threadKey: the full back-and-forth of one direct thread.
router.get('/:threadKey', async (req, res) => {
  try {
    const me = req.user;
    const { rows } = await pool.query(
      `SELECT * FROM messages
       WHERE thread_key = $1 AND (sender_id = $2 OR recipient_id = $3) AND recalled_at IS NULL
       ORDER BY sent_at ASC, id ASC`,
      [req.params.threadKey, me.id, me.id]
    );
    res.json({ threadKey: req.params.threadKey, messages: rows.map(decorate) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadConversation' });
  }
});

// POST /api/messages: send. Either broadcast to a role or reply to a person.
router.post('/', async (req, res) => {
  try {
    const { recipientId, recipientRole, category, subject, body } = req.body;
    if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'errors.subjectRequired' });
    if (!['attendance', 'offering', 'member_alert', 'event', 'general'].includes(category)) {
      return res.status(400).json({ error: 'errors.unknownMessageCategory' });
    }

    let recipientIdFinal = null;
    if (recipientId) {
      const { rows } = await pool.query('SELECT id, name, role FROM users WHERE id = $1 AND is_active = 1', [recipientId]);
      if (!rows[0]) return res.status(404).json({ error: 'errors.recipientNotFound' });
      recipientIdFinal = Number(recipientId);
    } else if (!recipientRole || !['pastor', 'receptionist', 'admin', 'superadmin'].includes(recipientRole)) {
      return res.status(400).json({ error: 'errors.recipientRoleSpecificRecipientRequired' });
    }

    const key = recipientIdFinal ? threadKey(req.user.id, recipientIdFinal) : null;
    const { rows } = await pool.query(
      `INSERT INTO messages (sender_id, recipient_role, recipient_id, thread_key, category, subject, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.id, recipientRole || 'pastor', recipientIdFinal, key, category, subject, String(body || '').trim() || null]
    );
    const id = rows[0].id;

    await logAudit({ userId: req.user.id, action: 'message_sent', table: 'messages', recordId: id, details: { to: recipientIdFinal || recipientRole, category }, ip: req.ip });

    // A message is only a notification if the person is actually told. The push
    // carries the sender and the subject and opens the thread; the unread badge
    // comes from the message row itself, so no in-app twin is written here (see
    // NOTIFICATION_TWIN_RECORD_TYPES below: one event must count once).
    //
    // Direct threads reach one person; a broadcast reaches every active holder
    // of the role, including the receptionist, which is what makes the pastor's
    // replies land on the front desk's phone. These message pushes are routine;
    // only the emergency route requests persistent system attention. The push
    // itself is deliberately not awaited (matching the other push call
    // sites): a slow or down push gateway must never delay the reply, and it can
    // never fail a send that the database has already accepted.
    const pushTitle = `${req.user.name}: ${subject}`;
    const pushBody = String(body || '').trim().slice(0, 180) || subject;
    const pushOpts = {
      title: pushTitle,
      body: pushBody,
      url: '/messages',
      recordType: 'message',
      recordId: id,
      tag: key || `role:${recipientRole || 'pastor'}`,
      // Routine messages, including member alerts, auto-dismiss. Only the
      // emergency notification route requests persistent system attention.
      requireInteraction: false,
    };
    if (recipientIdFinal) {
      const { rows: recipientRows } = await pool.query('SELECT id, name, role FROM users WHERE id = $1', [recipientIdFinal]);
      if (recipientRows[0]) pushAlertToUser({ user: recipientRows[0], ...pushOpts }).catch(() => {});
    } else {
      pushAlertToRole({ role: recipientRole || 'pastor', ...pushOpts }).catch(() => {});
    }

    res.status(201).json({ id, threadKey: key });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedSendMessage' });
  }
});

// PATCH /api/messages/read-all
// Marks every message and notification currently visible to this user as read.
// It clears the badge without deleting history or changing the sender's copy.
router.patch('/read-all', async (req, res) => {
  try {
    const me = req.user;
    await pool.query(
      `UPDATE messages
          SET read_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE recalled_at IS NULL AND read_at IS NULL
          AND ((recipient_id = $1) OR (recipient_id IS NULL AND recipient_role = $2)
               OR (thread_key IS NOT NULL AND (sender_id = $1 OR recipient_id = $1)))`,
      [me.id, me.role]
    );
    await pool.query(
      `UPDATE notifications_log
          SET read_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE sent_to = $1 AND read_at IS NULL`,
      [me.email]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedMarkMessageRead' });
  }
});

// PATCH /api/messages/:id/read
router.patch('/:id/read', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [req.params.id]);
    const m = rows[0];
    if (!m) return res.status(404).json({ error: 'errors.messageNotFound' });
    const isMine = m.sender_id === req.user.id || m.recipient_id === req.user.id || (m.recipient_id === null && m.recipient_role === req.user.role);
    if (!isMine) return res.status(403).json({ error: 'errors.notMessage' });
    await pool.query("UPDATE messages SET read_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1", [m.id]);
    // Keep the optional in-app announcement twin in step with the canonical
    // message when the Pastor explicitly opens it from Messages.
    await pool.query("UPDATE notifications_log SET read_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE message_id = $1 AND sent_to = $2", [m.id, req.user.email]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedMarkMessageRead' });
  }
});

module.exports = router;
module.exports.threadKey = threadKey;
module.exports.CATEGORIES = CATEGORIES;
module.exports.NOTIFICATION_TWIN_RECORD_TYPES = NOTIFICATION_TWIN_RECORD_TYPES;
