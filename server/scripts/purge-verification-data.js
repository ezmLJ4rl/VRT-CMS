'use strict';
/**
 * Removes the footprint of a verification / QA exercise from a database.
 *
 * A manual (or scripted) end-to-end walkthrough writes real rows into whatever
 * database it is pointed at: throwaway entities named "Verify ...", the service
 * sessions it recorded attendance against, the members it added, and every log
 * entry it produced. When that runs against a development database the residue
 * is indistinguishable from real data in the UI, so this removes it in one pass.
 *
 * HOW IT IDENTIFIES THE RESIDUE
 * -----------------------------
 * Rows carry no "created by the verifier" flag, so the discriminator is time.
 * The exercise is a contiguous burst: the first marker rows ("Verify ..." names,
 * "verify script" notes, verify.* addresses) and the audit entries attributed to
 * the verify accounts bracket the whole session. Everything the app wrote inside
 * that window belongs to the exercise: the seeded baseline all predates it, so
 * the window is the delete predicate.
 *
 * The window and every count are printed before anything is committed, and the
 * default is a dry run: the deletes, the audit re-chain and the sequence resets
 * all run inside a transaction that is then rolled back. Adding --apply commits.
 *
 * USAGE
 *   npm run purge:verify              # dry run (safe, changes nothing)
 *   npm run purge:verify -- --apply   # commit the cleanup
 */
require('dotenv').config();

const pool = require('../db/pg');
const { rebuildChain, verifyChain } = require('../utils/audit');

const APPLY = process.argv.includes('--apply');

// Tables that can hold exercise residue, children before parents so the deletes
// never trip a foreign key. `ts` is the column recording when a row was written;
// `text` are the columns the "verify" marker can appear in.
const TABLES = [
  { name: 'attendance_attendees', ts: 'timestamp', text: ['name'] },
  { name: 'messages', ts: 'sent_at', text: ['subject', 'body', 'payload', 'category', 'recipient_role', 'thread_key'] },
  { name: 'notifications_log', ts: 'timestamp', text: ['record_type', 'sent_to', 'channel', 'status', 'message', 'url'] },
  // `extra` columns are loaded but not scanned for the marker; the audit log
  // needs user_id to attribute an entry to a verify account.
  { name: 'audit_log', ts: 'timestamp', text: ['action', 'table_affected', 'details', 'ip_address'], extra: ['user_id'] },
  { name: 'offerings', ts: 'timestamp', text: ['type', 'currency', 'reason', 'project_name', 'receipt_number', 'notes', 'void_reason'] },
  { name: 'attendance', ts: 'timestamp', text: ['mode', 'void_reason'] },
  { name: 'emergencies', ts: 'timestamp', text: ['title', 'description', 'severity', 'status'] },
  { name: 'events', ts: 'created_at', text: ['title', 'description', 'location', 'kind', 'status', 'collection_type'] },
  { name: 'services', ts: 'created_at', text: ['name', 'date', 'time', 'event_title', 'event_description'] },
  { name: 'service_type_sessions', ts: 'created_at', text: ['name'] },
  { name: 'service_types', ts: 'created_at', text: ['name', 'key', 'attendance_mode'] },
  { name: 'group_members', ts: 'joined_at', text: ['role'] },
  { name: 'members', ts: 'created_at', text: ['member_no', 'name', 'email', 'gender', 'notes'] },
  { name: 'groups', ts: 'created_at', text: ['name', 'kind', 'description'] },
  { name: 'center_zones', ts: 'created_at', text: ['name'] },
  { name: 'revival_centers', ts: 'created_at', text: ['name'] },
  { name: 'users', ts: 'created_at', text: ['name', 'email', 'phone', 'role', 'language_pref'] },
];

const MARKER = /verif/i;

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Parses both timestamp flavours in this schema. audit_log stores ISO strings
 * (from JS `toISOString()`); every other table uses the Postgres column default
 * `to_char(now(), ...)`, i.e. 'YYYY-MM-DD HH24:MI:SS' in the server's local time
 * (UTC for the dev container, matching the ISO rows).
 */
function toDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function loadTable(t) {
  const columns = ['id', ...new Set([t.ts, ...t.text, ...(t.extra || [])])];
  const { rows } = await pool.query(
    `SELECT ${columns.map(quoteIdent).join(', ')} FROM ${quoteIdent(t.name)}`
  );
  for (const row of rows) {
    row.marked = t.text.some((column) => MARKER.test(String(row[column] ?? '')));
  }
  return { ...t, rows };
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refusing to run: NODE_ENV=production');
  }

  const tables = [];
  for (const t of TABLES) tables.push(await loadTable(t));

  // 1. Open the window at the first marker row.
  let windowStart = null;
  for (const t of tables) {
    for (const row of t.rows) {
      if (!row.marked) continue;
      const d = toDate(row[t.ts]);
      if (d && (!windowStart || d < windowStart)) windowStart = d;
    }
  }
  if (!windowStart) {
    throw new Error(
      'no "verify" markers found: there is nothing to purge (refusing to guess a time window)'
    );
  }

  // 2. The verify accounts: marker rows on the users table.
  const users = tables.find((t) => t.name === 'users');
  const verifyUserIds = users.rows.filter((row) => row.marked).map((row) => row.id);
  if (!verifyUserIds.length) {
    throw new Error('no verify account found: refusing to guess a time window');
  }

  // 3. Close the window at the exercise's last write, taken as the latest of the
  //    marker rows and any audit entry attributed to a verify account. The
  //    exercise did its work through those accounts, so that is what bounds it:
  //    later activity (a real login the next morning, say) stays outside.
  const audit = tables.find((t) => t.name === 'audit_log');
  let windowEnd = windowStart;
  for (const row of audit.rows) {
    const attributed = row.marked || verifyUserIds.includes(row.user_id);
    if (!attributed) continue;
    const d = toDate(row[audit.ts]);
    if (d && d > windowEnd) windowEnd = d;
  }

  // 4. Residue selection.
  for (const t of tables) {
    t.remove = t.rows
      .filter((row) => {
        const d = toDate(row[t.ts]);
        if (!d) return false;
        // The audit log also takes everything up to the window's end: it held no
        // entries before the exercise, so its earlier rows are the exercise's own
        // preamble (the logins and password changes it performed to set itself up).
        if (t.name === 'audit_log') return d <= windowEnd;
        return d >= windowStart && d <= windowEnd;
      })
      .map((row) => row.id);
  }

  const total = tables.reduce((sum, t) => sum + t.remove.length, 0);

  console.log(`\nResidue window : ${windowStart.toISOString()}  ..  ${windowEnd.toISOString()}`);
  console.log(`Verify accounts: ${verifyUserIds.join(', ')}\n`);
  for (const t of tables) {
    if (!t.rows.length) continue;
    const flag = t.remove.length ? '' : '   (kept)';
    console.log(
      `  ${t.name.padEnd(22)} ${String(t.remove.length).padStart(4)} / ${String(t.rows.length).padStart(4)} rows removed${flag}`
    );
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${String(total).padStart(4)} rows\n`);

  if (total === 0) {
    console.log('Nothing to do.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const t of tables) {
      if (!t.remove.length) continue;
      await client.query(`DELETE FROM ${quoteIdent(t.name)} WHERE id = ANY($1::int[])`, [t.remove]);
    }

    // Fully emptied tables get their id sequence back, so a rebuilt database
    // numbers fresh rows from 1 again (receipt and member numbers are derived
    // from the data itself, so they follow automatically).
    const restarted = [];
    for (const t of tables) {
      const { rows: seqRows } = await client.query(
        'SELECT pg_get_serial_sequence($1, $2) AS s',
        [t.name, 'id']
      );
      if (!seqRows[0].s) continue;
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS n FROM ${quoteIdent(t.name)}`
      );
      if (countRows[0].n === 0) {
        await client.query(`ALTER SEQUENCE ${seqRows[0].s} RESTART WITH 1`);
        restarted.push(t.name);
      }
    }

    // Removing rows mid-chain would make the tamper-evident log report itself as
    // broken, so re-link what is left.
    const chain = await rebuildChain(client);

    if (APPLY) await client.query('COMMIT');
    else await client.query('ROLLBACK');

    console.log(`Audit chain    : ${chain.rows} row(s) kept, ${chain.changed} re-hashed`);
    if (restarted.length) console.log(`Sequences reset: ${restarted.join(', ')}`);
    console.log(
      APPLY
        ? '\nCommitted.'
        : '\nDRY RUN, rolled back. Re-run with `npm run purge:verify -- --apply` to commit.'
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  if (APPLY) {
    const result = await verifyChain();
    console.log(
      result.valid
        ? 'Audit chain verify: valid'
        : `Audit chain verify: BROKEN at id ${result.brokenAtId}`
    );
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Purge failed:', err.message);
    return pool.end().finally(() => process.exit(1));
  });
