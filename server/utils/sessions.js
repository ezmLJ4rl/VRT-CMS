const pool = require('../db/pg');

/**
 * Expected failures carry a catalog key so the response layer can translate
 * them (see i18n/). Throwing a sentence instead would put English prose in front
 * of a Kiswahili user, and would leak an internal message on any unexpected path.
 */
function sessionError(key, status) {
  const err = new Error(key);
  err.status = status;
  err.key = key;
  return err;
}

/**
 * Finds the typed service session for a service type on a given date, creating
 * it on demand (mirroring how attendance sessions are created). Offerings are
 * attributed to the same typed sessions so finance reports line up with
 * attendance categories.
 */
async function findOrCreateSession(serviceTypeId, date, subSessionId) {
  const { rows: typeRows } = await pool.query('SELECT * FROM service_types WHERE id = $1 AND is_active = 1', [serviceTypeId]);
  const type = typeRows[0];
  if (!type) throw sessionError('errors.serviceTypeNotFound', 404);

  if (subSessionId) {
    const { rows: subRows } = await pool.query(
      'SELECT * FROM service_type_sessions WHERE id = $1 AND service_type_id = $2',
      [subSessionId, serviceTypeId]
    );
    if (!subRows[0]) throw sessionError('errors.subSessionNotBelongToServiceType', 400);
  }

  // IS NOT DISTINCT FROM is Postgres's null-safe equality, matching SQLite's `IS ?`
  // (a NULL parameter matched a NULL column there; pg's `IS` can't bind a value).
  const { rows: sessionRows } = await pool.query(
    `SELECT * FROM services
     WHERE service_type_id = $1 AND date = $2
       AND sub_session_id IS NOT DISTINCT FROM $3`,
    [serviceTypeId, date, subSessionId || null]
  );
  let session = sessionRows[0];

  if (!session) {
    const { rows: subNameRows } = subSessionId
      ? await pool.query('SELECT name FROM service_type_sessions WHERE id = $1', [subSessionId])
      : { rows: [] };
    const name = [type.name, subNameRows[0] ? `· ${subNameRows[0].name}` : ''].filter(Boolean).join(' ');
    const { rows: inserted } = await pool.query(
      'INSERT INTO services (name, date, time, service_type_id, sub_session_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [name, date, null, serviceTypeId, subSessionId || null]
    );
    session = inserted[0];
  }
  return session;
}

module.exports = { findOrCreateSession };
