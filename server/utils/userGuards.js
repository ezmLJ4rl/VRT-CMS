'use strict';
/**
 * Rules that stop user management from destroying either access or history.
 *
 * These live in one module because three different operations (edit, deactivate,
 * delete) all have to ask the same questions, and a guard that is copy-pasted
 * into each handler is a guard that will eventually disagree with itself.
 */
const pool = require('../db/pg');

// Mirrors the CHECK constraint on users.role.
const VALID_ROLES = ['receptionist', 'admin', 'pastor', 'superadmin'];
const VALID_LANGUAGES = ['en', 'sw'];

/**
 * Everything the church has *recorded* through an account: rows this user
 * authored or acted on.
 *
 * Deleting such an account would either violate the foreign key outright or,
 * worse if it were forced, leave attendance, offering and emergency history
 * attributed to nobody, which silently corrupts financial records. So deletion
 * is refused for these accounts and they are deactivated instead, which keeps
 * history intact while removing access immediately.
 */
const AUTHORED_REFS = [
  ['attendance', 'recorded_by', 'attendance records'],
  ['attendance', 'notified_by', 'attendance notifications'],
  ['attendance', 'voided_by', 'voided attendance'],
  ['offerings', 'recorded_by', 'offerings'],
  ['offerings', 'notified_by', 'offering notifications'],
  ['offerings', 'voided_by', 'voided offerings'],
  ['emergencies', 'reported_by', 'emergencies'],
  ['emergencies', 'resolved_by', 'resolved emergencies'],
  ['emergencies', 'notified_by', 'emergency notifications'],
  ['messages', 'sender_id', 'messages'],
  ['events', 'created_by', 'events'],
];

function isActive(user) {
  return Number(user && user.is_active) === 1 || user?.is_active === true;
}

/** Every authored-record reference for one user, with counts. Empty = deletable. */
async function authoredRecordCounts(userId, client = pool) {
  const found = [];
  for (const [table, column, label] of AUTHORED_REFS) {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS count FROM ${table} WHERE ${column} = $1`,
      [userId]
    );
    if (rows[0].count > 0) found.push({ table, column, label, count: rows[0].count });
  }
  return found;
}

/**
 * True when this account is the last active superadmin: i.e. when demoting,
 * deactivating or deleting it would leave nobody able to manage users at all.
 *
 * The self-service guard already covers the common case (a superadmin cannot
 * demote themselves); this closes the case where the only other superadmin's
 * token is still in flight, or a deactivation landed between the check and the
 * write.
 */
async function isLastActiveSuperadmin(user, client = pool) {
  if (!user || user.role !== 'superadmin' || !isActive(user)) return false;
  const { rows } = await client.query(
    "SELECT COUNT(*)::int AS count FROM users WHERE role = 'superadmin' AND is_active = 1 AND id <> $1",
    [user.id]
  );
  return rows[0].count === 0;
}

module.exports = {
  AUTHORED_REFS,
  VALID_LANGUAGES,
  VALID_ROLES,
  authoredRecordCounts,
  isActive,
  isLastActiveSuperadmin,
};
