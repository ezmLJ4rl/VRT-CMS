const express = require('express');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/push/vapid-public-key: the frontend needs this to create a push subscription.
router.get('/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'errors.pushNotificationsNotConfiguredServer' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe: registers this device's push subscription for the current user.
// Receptionists are included: the pastor's replies and alerts are pushed to the
// front desk, so a receptionist device has to be able to subscribe. The
// subscription is always stored against the AUTHENTICATED user, so this cannot be
// used to register someone else's device.
router.post('/subscribe', requireRole('pastor', 'receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'errors.validPushSubscriptionEndpointKeysRequired' });
    }
    await pool.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.user.id, endpoint, keys.p256dh, keys.auth]
    );
    res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRegisterPushSubscription' });
  }
});

// POST /api/push/unsubscribe
router.post('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: 'errors.endpointRequired' });
    await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [endpoint, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRemovePushSubscription' });
  }
});

module.exports = router;
