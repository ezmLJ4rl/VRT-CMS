const crypto = require('crypto');
const pool = require('../db/pg');

/**
 * The canonical hash of one audit entry.
 *
 * Everything that writes or validates the chain, logAudit, verifyChain and
 * rebuildChain, must agree byte-for-byte, so the payload shape lives here once.
 * Note `details` is the *parsed* value (object or null), matching the JSON that
 * is stored in the text column, not the raw string.
 */
function hashEntry({ userId, action, table, recordId, details, ip, timestamp, prevHash }) {
  const payload = JSON.stringify({
    userId: userId ?? null,
    action,
    table,
    recordId: recordId ?? null,
    details: details ?? null,
    ip: ip ?? null,
    timestamp,
    prevHash,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

async function logAudit({ userId, action, table, recordId, details, ip }) {
  const normalizedUserId = userId ?? null;
  const normalizedRecordId = recordId ?? null;
  const normalizedDetails = details ?? null;
  const normalizedIp = ip ?? null;
  const timestamp = new Date().toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // FOR UPDATE locks the last row so a concurrent logAudit() call can't read
    // the same prevHash before this one commits: SQLite never had this risk
    // (single writer at a time); Postgres does, so the chain needs this lock.
    const { rows } = await client.query(
      'SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1 FOR UPDATE'
    );
    const prevHash = rows[0] ? rows[0].hash : 'GENESIS';

    const hash = hashEntry({
      userId: normalizedUserId,
      action,
      table,
      recordId: normalizedRecordId,
      details: normalizedDetails,
      ip: normalizedIp,
      timestamp,
      prevHash,
    });

    await client.query(
      `INSERT INTO audit_log (user_id, action, table_affected, record_id, details, ip_address, timestamp, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        normalizedUserId,
        action,
        table,
        normalizedRecordId,
        normalizedDetails ? JSON.stringify(normalizedDetails) : null,
        normalizedIp,
        timestamp,
        prevHash,
        hash,
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function verifyChain() {
  const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY id ASC');
  let expectedPrev = 'GENESIS';
  for (const row of rows) {
    const recomputed = hashEntry({
      userId: row.user_id,
      action: row.action,
      table: row.table_affected,
      recordId: row.record_id,
      details: row.details ? JSON.parse(row.details) : null,
      ip: row.ip_address,
      timestamp: row.timestamp,
      prevHash: expectedPrev,
    });
    if (row.prev_hash !== expectedPrev || row.hash !== recomputed) {
      return { valid: false, brokenAtId: row.id };
    }
    expectedPrev = row.hash;
  }
  return { valid: true, brokenAtId: null };
}

/**
 * Recomputes prev_hash/hash for every remaining row, in id order.
 *
 * Removing rows mid-chain (a maintenance cleanup, never normal operation) leaves
 * the survivors pointing at hashes that no longer exist, which makes
 * verifyChain() report the log as tampered. This re-links what is left so the
 * log stays verifiable. Returns how many rows changed.
 */
async function rebuildChain(client = pool) {
  const { rows } = await client.query('SELECT * FROM audit_log ORDER BY id ASC');
  let prevHash = 'GENESIS';
  let changed = 0;
  for (const row of rows) {
    const hash = hashEntry({
      userId: row.user_id,
      action: row.action,
      table: row.table_affected,
      recordId: row.record_id,
      details: row.details ? JSON.parse(row.details) : null,
      ip: row.ip_address,
      timestamp: row.timestamp,
      prevHash,
    });
    if (row.prev_hash !== prevHash || row.hash !== hash) {
      await client.query('UPDATE audit_log SET prev_hash = $1, hash = $2 WHERE id = $3', [
        prevHash,
        hash,
        row.id,
      ]);
      changed += 1;
    }
    prevHash = hash;
  }
  return { rows: rows.length, changed };
}

module.exports = { hashEntry, logAudit, verifyChain, rebuildChain };
