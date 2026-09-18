'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const suite = startServer({ name: 'notification-taxonomy', port: 4641 });
let adminToken;

describe('Pastor notification taxonomy', () => {
  before(async () => {
    await suite.waitReady();
    const login = await suite.api('POST', '/api/auth/login', null, {
      email: 'superadmin@victoryrevival.church',
      password: 'TestPass_123!',
    });
    assert.equal(login.status, 200, login.text);
    adminToken = login.json.token;
  });

  it('does not notify the Pastor for routine group membership changes', async () => {
    const group = await suite.api('POST', '/api/groups', adminToken, { name: 'Housekeeping Choir', kind: 'choir' });
    assert.equal(group.status, 201, group.text);
    const member = await suite.api('POST', '/api/members', adminToken, {
      name: 'Administrative Member', groupIds: [group.json.group.id],
    });
    assert.equal(member.status, 201, member.text);

    const beforeMessages = await suite.get("SELECT COUNT(*)::int AS n FROM messages WHERE recipient_role = 'pastor'");
    const beforeNotifications = await suite.get("SELECT COUNT(*)::int AS n FROM notifications_log WHERE channel = 'in_app' AND sent_to = 'pastor@victoryrevival.church'");
    const attempted = await suite.api('POST', `/api/groups/${group.json.group.id}/notify-pastor`, adminToken);
    assert.equal(attempted.status, 200, attempted.text);
    assert.equal(attempted.json.sent, false);
    assert.equal(attempted.json.reason, 'membership_changes_are_not_pastor_notifications');

    const afterMessages = await suite.get("SELECT COUNT(*)::int AS n FROM messages WHERE recipient_role = 'pastor'");
    const afterNotifications = await suite.get("SELECT COUNT(*)::int AS n FROM notifications_log WHERE channel = 'in_app' AND sent_to = 'pastor@victoryrevival.church'");
    assert.equal(afterMessages.n, beforeMessages.n);
    assert.equal(afterNotifications.n, beforeNotifications.n);
  });

  it('keeps every Pastor-facing in-app category inside the allowlist', async () => {
    const { PASTOR_NOTIFICATION_CATEGORIES } = require('../utils/notify');
    const rows = await suite.all(
      "SELECT DISTINCT record_type FROM notifications_log WHERE channel = 'in_app' AND sent_to = 'pastor@victoryrevival.church'"
    );
    for (const row of rows) assert.ok(PASTOR_NOTIFICATION_CATEGORIES.includes(row.record_type), row.record_type);
  });
});

after(() => suite.stop());
