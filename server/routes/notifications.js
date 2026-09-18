const express = require('express');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendBatchDigest } = require('../utils/digest');
const { PASTOR_NOTIFICATION_CATEGORIES } = require('../utils/notify');

const router = express.Router();
router.use(authenticate);

// GET /api/notifications: the pastor's (or admin's) in-app feed
//
// An announcement of a message that has since been recalled is withheld with
// it: a notification pointing at a message the pastor can no longer open is
// worse than no notification, and it would also contradict the message feed.
// Rows that announce something other than a message (message_id IS NULL) are
// unaffected.
router.get('/', requireRole('pastor', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { rows: notifications } = await pool.query(
      `SELECT * FROM notifications_log
       WHERE channel = 'in_app' AND sent_to = $1
         AND record_type = ANY($2::text[])
         AND (message_id IS NULL
              OR EXISTS (SELECT 1 FROM messages m WHERE m.id = notifications_log.message_id AND m.recalled_at IS NULL))
       ORDER BY timestamp DESC, id DESC LIMIT 100`,
      [req.user.email, PASTOR_NOTIFICATION_CATEGORIES]
    );
    res.json({ notifications });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadNotifications' });
  }
});

// POST /api/notifications/send-summary: fires the batched end-of-day summary
// of the caller's un-notified records for today to the pastor.
router.post('/send-summary', async (req, res) => {
  try {
    const result = await sendBatchDigest({ userId: req.user.id, userName: req.user.name, locale: req.locale });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedSendSummary' });
  }
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', requireRole('pastor', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      "UPDATE notifications_log SET read_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1 AND sent_to = $2 RETURNING message_id",
      [req.params.id, req.user.email]
    );
    // Summary and group-update feed rows are twins of a message. An explicit
    // tap on the lightweight Home preview must clear the canonical message too,
    // otherwise the shared unread badge would continue to report the same event.
    if (rows[0]?.message_id) {
      await pool.query('UPDATE messages SET read_at = to_char(now(), \'YYYY-MM-DD HH24:MI:SS\') WHERE id = $1', [rows[0].message_id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedMarkNotificationRead' });
  }
});

module.exports = router;
