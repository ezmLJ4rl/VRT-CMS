const nodemailer = require('nodemailer');
const webpush = require('web-push');
const pool = require('../db/pg');
const { translator } = require('../i18n');
const { CHURCH_NAME } = require('./brand');

// Branding is decided HERE, not in the service worker, for two reasons: every
// channel (push, email, SMS, in-app) then says the same name, and a payload that
// reaches a device is already recognizable even if the device has an older
// service worker cached. The icon/badge paths are served from the Pastor PWA's
// own origin, where public/vrt-logo.png and public/vrt-roundel.png live.
const NOTIFICATION_BRAND = CHURCH_NAME;
const NOTIFICATION_ICON = '/vrt-logo.png';
const NOTIFICATION_BADGE = '/vrt-roundel.png';

// This is the only category set allowed to create a Pastor-facing notification.
// Audit rows and general activity logging remain separate and may contain
// operational events; they must never become Pastor feed entries by accident.
const PASTOR_NOTIFICATION_CATEGORIES = Object.freeze([
  'attendance_digest',
  'offering_digest',
  'emergency',
  'event',
  'member_alert',
  'message',
  'project_milestone',
  'leadership_change',
]);
const PASTOR_NOTIFICATION_CATEGORY_SET = new Set(PASTOR_NOTIFICATION_CATEGORIES);

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:notifications@victoryrevival.church',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) return null;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
  });
  return transporter;
}

/**
 * Writes a row to notifications_log. Accepts an optional transaction client so
 * callers that must log inside a transaction (e.g. the batched digest) write on
 * the same connection. Falls back to the shared pool otherwise.
 */
async function logNotification({ recordType, recordId, sentTo, channel, status, message, url, messageId }, client = null) {
  // In-app is the Pastor-facing feed. Invalid categories are dropped at this
  // boundary even if a future caller reuses this general delivery logger.
  if (channel === 'in_app' && !PASTOR_NOTIFICATION_CATEGORY_SET.has(recordType)) return null;
  const runner = client || pool;
  const { rows } = await runner.query(
    `INSERT INTO notifications_log (record_type, record_id, sent_to, channel, status, message, url, message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    // record_type is NOT NULL: a send that did not name a record type is still
    // logged (as 'notification'), because losing the delivery record entirely
    // would hide the one clue that a push was attempted and failed.
    [recordType || 'notification', recordId || null, sentTo, channel, status, message || null, url || null, messageId || null]
  );
  return rows[0].id;
}

/** Sends an email to the pastor's inbox. Falls back to a logged no-op if SMTP isn't configured. */
async function sendEmail({ to, subject, text, recordType, recordId }) {
  const transport = getTransporter();
  if (!transport) {
    await logNotification({ recordType, recordId, sentTo: to, channel: 'email', status: 'pending', message: `${subject}: ${text}` });
    return;
  }
  try {
    await transport.sendMail({ from: process.env.PASTOR_EMAIL_FROM, to, subject, text });
    await logNotification({ recordType, recordId, sentTo: to, channel: 'email', status: 'sent', message: subject });
  } catch (err) {
    await logNotification({ recordType, recordId, sentTo: to, channel: 'email', status: 'failed', message: err.message });
  }
}

/**
 * Sends an SMS via Africa's Talking. Requires AT_USERNAME/AT_API_KEY in .env.
 * Kept dependency-free (plain HTTPS) so it doesn't add a hard install requirement
 * for churches that only want email notifications.
 */
async function sendSms({ to, message, recordType, recordId }) {
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) {
    await logNotification({ recordType, recordId, sentTo: to, channel: 'sms', status: 'pending', message });
    return;
  }
  try {
    const params = new URLSearchParams({
      username: process.env.AT_USERNAME,
      to,
      message,
      from: process.env.AT_SENDER_ID || '',
    });
    const res = await fetch('https://api.africastalking.com/version1/messaging', {
      method: 'POST',
      headers: {
        apiKey: process.env.AT_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });
    const ok = res.ok;
    await logNotification({ recordType, recordId, sentTo: to, channel: 'sms', status: ok ? 'sent' : 'failed', message });
  } catch (err) {
    await logNotification({ recordType, recordId, sentTo: to, channel: 'sms', status: 'failed', message: err.message });
  }
}

/**
 * Sends a Web Push notification to every device this user has registered: they
 * may have more than one (phone and tablet). Returns the number of subscriptions
 * the push service accepted, so a caller can tell "no device to reach" from
 * "delivered". Prunes subscriptions the push service reports as gone (410/404),
 * which is what keeps a stale subscription from silently eating every alert.
 *
 * The payload is brand-first: the device shows the church's name as the
 * notification title and the VRT logo as its icon, with the subject line and
 * detail as the body. `renotify` plus a per-kind `tag` means a second alert of the
 * same kind re-alerts (sound/vibration) instead of replacing the first silently.
 */
async function sendWebPush({ userId, title, body, url, recordType, recordId, tag, requireInteraction = false }) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    await logNotification({ recordType, recordId, sentTo: `user:${userId}`, channel: 'push', status: 'pending', message: title });
    return 0;
  }
  // The subject is dropped when a caller already passed the brand as its title
  // (notifyPastorOfRecord's default), so the notification never reads
  // "Victory Revival Temple" twice.
  const subject = title && title !== NOTIFICATION_BRAND ? String(title) : null;
  const payload = {
    brand: NOTIFICATION_BRAND,
    title: subject,
    body: body ? String(body) : '',
    url: url || '/',
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
    tag: tag || recordType || 'vrt',
    // Persistent system attention is a severity boundary, not a caller preference:
    // only emergency notifications may keep the OS alert visible.
    requireInteraction: recordType === 'emergency',
  };
  const { rows: subs } = await pool.query('SELECT * FROM push_subscriptions WHERE user_id = $1', [userId]);
  let sent = 0;
  for (const sub of subs) {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      sent += 1;
      await logNotification({ recordType, recordId, sentTo: sub.endpoint, channel: 'push', status: 'sent', message: subject || NOTIFICATION_BRAND });
    } catch (err) {
      await logNotification({ recordType, recordId, sentTo: sub.endpoint, channel: 'push', status: 'failed', message: err.message });
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [sub.id]);
      }
    }
  }
  return sent;
}

/**
 * Writes an in-app notification-feed entry the pastor dashboard polls.
 *
 * `messageId` names the message this entry announces, when the caller has one.
 * It is what lets a recall withdraw the announcement along with the message
 * (routes/messages.js), so the pastor's feed and their notification list can
 * never disagree about whether something was sent.
 */
async function pushInApp({ to, message, recordType, recordId, url, messageId }, client = null) {
  return logNotification({ recordType, recordId, sentTo: to, channel: 'in_app', status: 'sent', message, url, messageId }, client);
}

/**
 * Fires all configured channels for a new record (an emergency, a published
 * event, a finalized one). Never throws.
 *
 * `render(t, language)` builds the subject line and the body FROM THE CATALOG, and
 * is called once per pastor with a translator bound to THAT pastor's language
 * (`language` is that same catalog id, for anything `t` cannot express: a number
 * formatted for the reader, say). The
 * old shape took pre-built English prose, which made the notification the only
 * text in the system that could not follow anybody's language: a pastor reading
 * Kiswahili got English alerts no matter how the app was set. Passing a renderer
 * rather than a string is what lets a record name its own keys and keep them
 * translated per reader.
 *
 * `locale` is the caller's language, used only for a pastor account that has
 * never chosen one.
 */
async function notifyPastorOfRecord({ recordType, recordId, render, url, locale, requireInteraction = false }) {
  if (!PASTOR_NOTIFICATION_CATEGORY_SET.has(recordType)) {
    throw new Error(`Invalid Pastor notification category: ${recordType}`);
  }
  const { rows: pastors } = await pool.query("SELECT * FROM users WHERE role = 'pastor' AND is_active = 1");
  for (const pastor of pastors) {
    const language = pastor.language_pref || locale;
    const t = translator(language);
    const { title, summary } = render(t, language) || {};
    await pushInApp({ to: pastor.email, message: summary, recordType, recordId, url });
    if (pastor.email) {
      sendEmail({ to: pastor.email, subject: title || t('notify.defaultSubject', { brand: NOTIFICATION_BRAND }), text: summary, recordType, recordId }).catch(() => {});
    }
    if (pastor.phone) {
      sendSms({ to: pastor.phone, message: summary, recordType, recordId }).catch(() => {});
    }
    sendWebPush({ userId: pastor.id, title: title || NOTIFICATION_BRAND, body: summary, url, recordType, recordId, requireInteraction }).catch(() => {});
  }
}

/**
 * A real OS-level push to one signed-in person, for a notification that is NOT
 * already counted as an unread message: a direct message, say, whose unread
 * state is tracked on the message row itself. Deliberately does not write an
 * in-app row: the badge counts messages and in-app notifications separately, so
 * adding a twin row here would report one send as two unread things (the rule
 * lives in routes/messages.js: NOTIFICATION_TWIN_RECORD_TYPES).
 *
 * Never throws: a push gateway failure must not fail the action that triggered it.
 */
async function pushAlertToUser({ user, title, body, url, recordType, recordId, tag, requireInteraction }) {
  if (!user || !user.id) return 0;
  try {
    return await sendWebPush({ userId: user.id, title, body, url, recordType, recordId, tag, requireInteraction });
  } catch (err) {
    console.error('push alert failed:', err.message);
    return 0;
  }
}

/**
 * The same alert to everyone holding a role (an announcement reaching the front
 * desk, for instance). Returns how many devices accepted it.
 */
async function pushAlertToRole({ role, title, body, url, recordType, recordId, tag, requireInteraction }) {
  const { rows: users } = await pool.query('SELECT id FROM users WHERE role = $1 AND is_active = 1', [role]);
  let sent = 0;
  for (const user of users) {
    sent += await pushAlertToUser({ user, title, body, url, recordType, recordId, tag, requireInteraction });
  }
  return sent;
}

module.exports = {
  NOTIFICATION_BRAND,
  NOTIFICATION_ICON,
  NOTIFICATION_BADGE,
  PASTOR_NOTIFICATION_CATEGORIES,
  sendEmail,
  sendSms,
  sendWebPush,
  pushInApp,
  pushAlertToUser,
  pushAlertToRole,
  notifyPastorOfRecord,
  logNotification,
};
