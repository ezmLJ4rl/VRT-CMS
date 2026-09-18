'use strict';
/**
 * Real push, and branded push.
 *
 * The pastor is alerted on the phone, not only inside the app, so this file pins
 * the two halves that make that true:
 *
 *   1. the payload the server hands to the push service is BRANDED, the church's
 *      name as the notification title, the VRT logo as its icon, and it carries
 *      the subject line, so a lock-screen alert is recognizable and informative;
 *   2. a message actually reaches the push service for a subscribed device, and a
 *      receptionist device can subscribe at all (the pastor's replies land on the
 *      front desk's phone).
 *
 * The push transport itself is stubbed in the unit half: what is under test is
 * what THIS code sends, not what a third-party push service does with it.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

const suite = startServer({ name: 'push-notifications', port: 4622 });

let adminToken;

after(() => suite.stop());

/** Waits for a condition the server reaches asynchronously (pushes are not awaited). */
async function waitFor(fn, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

describe('web push: branded payloads and real delivery', () => {
  before(async () => {
    await suite.waitReady();
    const admin = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    adminToken = admin.json.token;
    assert.ok(adminToken);
  });

  it('brands every payload with the church name, the logo and the subject', async () => {
    // Required AFTER the suite's guard is armed, so db/pg.js sees a test database.
    const notify = require('../utils/notify');
    const webpush = require('web-push');

    const user = await suite.get("SELECT id FROM users WHERE role = 'pastor' LIMIT 1");
    await suite.run(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO NOTHING`,
      [user.id, 'https://push.example.test/brand-check', 'p256dh-key', 'auth-key']
    );

    const sent = [];
    const original = webpush.sendNotification;
    webpush.sendNotification = async (subscription, payload) => {
      sent.push({ subscription, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    };
    try {
      await notify.sendWebPush({
        userId: user.id,
        title: "Today's summary from the front desk",
        body: 'Attendance: 42',
        url: '/messages',
        recordType: 'summary',
        // Even an accidental request from a routine caller cannot make a
        // routine alert persistent: only the emergency category owns that bit.
        requireInteraction: true,
      });
    } finally {
      webpush.sendNotification = original;
    }

    assert.equal(sent.length, 1, 'one device, one push');
    const payload = sent[0].payload;
    // The notification title is the brand, and the logo is its icon.
    assert.equal(payload.title, "Today's summary from the front desk");
    assert.equal(payload.brand, 'Victory Revival Temple');
    assert.equal(payload.icon, '/vrt-logo.png');
    assert.equal(payload.badge, '/vrt-roundel.png');
    assert.equal(payload.body, 'Attendance: 42');
    assert.equal(payload.url, '/messages');
    assert.equal(payload.tag, 'summary');
    assert.equal(payload.requireInteraction, false, 'routine notifications must auto-dismiss');

    sent.length = 0;
    webpush.sendNotification = async (subscription, payload) => {
      sent.push({ subscription, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    };
    try {
      await notify.sendWebPush({
        userId: user.id,
        title: 'Emergency reported',
        body: 'Please respond.',
        url: '/emergencies',
        recordType: 'emergency',
        requireInteraction: true,
      });
    } finally {
      webpush.sendNotification = original;
    }
    assert.equal(sent[0].payload.requireInteraction, true, 'only emergencies may request persistent attention');
  });

  it('drops a subscription the push service says is gone', async () => {
    const notify = require('../utils/notify');
    const webpush = require('web-push');

    const user = await suite.get("SELECT id FROM users WHERE role = 'pastor' LIMIT 1");
    const endpoint = 'https://push.example.test/gone';
    await suite.run(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO NOTHING`,
      [user.id, endpoint, 'p256dh-key', 'auth-key']
    );

    const original = webpush.sendNotification;
    webpush.sendNotification = async () => {
      const err = new Error('subscription has been unsubscribed');
      err.statusCode = 410;
      throw err;
    };
    try {
      await notify.sendWebPush({ userId: user.id, title: 'Victory Revival Temple', body: 'x', url: '/' });
    } finally {
      webpush.sendNotification = original;
    }

    // Left in place, a dead subscription silently absorbs every future alert.
    const row = await suite.get('SELECT id FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
    assert.equal(row, undefined);
  });

  it('lets a receptionist subscribe, so two-way alerts reach the front desk', async () => {
    await suite.api('POST', '/api/users', adminToken, {
      name: 'Push Desk', email: 'push-desk@test.local', role: 'receptionist', password: 'DeskPass_123!',
    });
    const desk = await suite.api('POST', '/api/auth/login', null, {
      email: 'push-desk@test.local', password: 'DeskPass_123!',
    });
    const token = desk.json.token;
    assert.ok(token);

    const key = await suite.api('GET', '/api/push/vapid-public-key', token);
    assert.equal(key.status, 200, key.text);
    assert.ok(key.json.publicKey, 'a client cannot subscribe without the public key');

    const sub = await suite.api('POST', '/api/push/subscribe', token, {
      endpoint: 'https://push.example.test/desk',
      keys: { p256dh: 'desk-p256dh', auth: 'desk-auth' },
    });
    assert.equal(sub.status, 201, sub.text);
  });

  it('attempts a real push when a message is sent to the pastor', async () => {
    const pastor = await suite.get("SELECT id, email FROM users WHERE role = 'pastor' LIMIT 1");
    const endpoint = 'https://push.example.test/pastor-message';
    await suite.run(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT (endpoint) DO NOTHING`,
      [pastor.id, endpoint, 'p256dh-key', 'auth-key']
    );

    const res = await suite.api('POST', '/api/messages', adminToken, {
      recipientId: pastor.id,
      category: 'general',
      subject: 'Please pray for the youth service',
      body: 'Bringing 30 young people on Sunday.',
    });
    assert.equal(res.status, 201, res.text);

    // The push is fired without blocking the send, so it lands shortly after:
    // what matters is that a push was genuinely attempted, and is on the record.
    const logged = await waitFor(() =>
      suite.get(
        "SELECT * FROM notifications_log WHERE channel = 'push' AND sent_to = ? AND record_id = ?",
        [endpoint, res.json.id]
      )
    );
    assert.ok(logged, 'a push must be attempted for a subscribed device');

    // …and it is NOT also written to the in-app feed: the unread badge already
    // counts the message, so a twin row would report one send as two.
    const twin = await suite.get(
      "SELECT id FROM notifications_log WHERE channel = 'in_app' AND record_type = 'message' AND record_id = ?",
      [res.json.id]
    );
    assert.equal(twin, undefined);
  });
});
