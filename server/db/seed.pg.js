require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./pg');
const { migrate } = require('./migrate');
const { todayISO } = require('../utils/date');

// SQLite used `?` placeholders; pg needs `$1, $2, ...`. This converts a query
// string with `?` markers into pg's positional placeholder syntax so the rest
// of this file can keep the same shape as the original SQLite version.
function toParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function upsertUser({ name, email, phone, role, password }) {
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (rows[0]) {
    console.log(`- ${email} already exists, skipping.`);
    return;
  }
  const hash = bcrypt.hashSync(password, 12);
  await pool.query(
    `INSERT INTO users (name, email, phone, role, password_hash, language_pref) VALUES ($1, $2, $3, $4, $5, 'en')`,
    [name, email, phone || null, role, hash]
  );
  console.log(`- created ${role}: ${email}`);
}

// Insert a row only if it doesn't already exist, returns id.
// whereSql/insertSql are written with `?` placeholders (matching the original
// SQLite version) and converted to `$1, $2, ...` here.
async function ensure(table, whereSql, params, insertSql, insertParams) {
  const selectSql = `SELECT id FROM ${table} WHERE ${toParams(whereSql)}`;
  const { rows } = await pool.query(selectSql, params);
  if (rows[0]) return rows[0].id;

  const insertSqlPg = `${toParams(insertSql)} RETURNING id`;
  const result = await pool.query(insertSqlPg, insertParams);
  return result.rows[0].id;
}

// The SQLite version created its tables the moment its schema module was
// required, so seeding an empty machine was a single command. Keep that promise
// for Postgres:
// apply schema.sql only when the schema is entirely absent. schema.sql is not
// re-runnable (its deferred ADD CONSTRAINT statements would collide on a second
// pass), so this must stay a one-shot bootstrap guarded by the users table.
async function ensureSchema() {
  const { rows } = await pool.query("SELECT to_regclass('public.users') AS t");
  if (rows[0].t) return;
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('- applied db/schema.sql (fresh database)');
}

async function main() {
  console.log('Seeding VRT CMS database...');
  await ensureSchema();
  // Seeding an existing database must also bring its schema up to date, or the
  // service-type rows below would be written with columns that are not there yet.
  await migrate();

  console.log('- users');
  await upsertUser({
    name: process.env.SEED_SUPERADMIN_NAME || 'Super Admin',
    email: process.env.SEED_SUPERADMIN_EMAIL || 'superadmin@victoryrevival.church',
    role: 'superadmin',
    password: process.env.SEED_SUPERADMIN_PASSWORD || 'ChangeMe_123!',
  });

  await upsertUser({
    name: process.env.SEED_PASTOR_NAME || 'Reverend Pastor',
    email: process.env.SEED_PASTOR_EMAIL || 'pastor@victoryrevival.church',
    phone: process.env.PASTOR_PHONE || null,
    role: 'pastor',
    password: process.env.SEED_PASTOR_PASSWORD || 'ChangeMe_123!',
  });

  // ------------------------- Service types + sub-sessions ------------------
  console.log('- service types & sub-sessions');
  // `kind` splits church services (ibada) from rehearsals. A rehearsal records
  // attendance only, never offerings, and is reported on its own, so practice
  // numbers never inflate the church's service figures. A rehearsal is always
  // 'both': a headcount plus names, where the names may be handwritten for people
  // who are not registered yet or picked from the existing member list.
  const SERVICE_TYPES = [
    { name: '1st Sunday Service', key: 'sunday_1', kind: 'service', mode: 'headcount', sessions: ['Sunday School', 'Main Service'] },
    { name: '2nd Sunday Service', key: 'sunday_2', kind: 'service', mode: 'headcount', sessions: ['Sunday School', 'Main Service'] },
    { name: 'Wednesday Service', key: 'wednesday', kind: 'service', mode: 'headcount', sessions: [] },
    { name: 'Friday Service', key: 'friday', kind: 'service', mode: 'headcount', sessions: [] },
    { name: 'Choir Rehearsal 1', key: 'choir_rehearsal_1', kind: 'rehearsal', mode: 'both', sessions: [] },
    { name: 'Choir Rehearsal 2', key: 'choir_rehearsal_2', kind: 'rehearsal', mode: 'both', sessions: [] },
    { name: 'Praise & Worship Rehearsal', key: 'pw_rehearsal', kind: 'rehearsal', mode: 'both', sessions: [] },
  ];

  // The three pre-existing rehearsals are moved over by db/migrate.js, which runs
  // on every boot as well as here, so a church that only restarts still gets them.

  for (let i = 0; i < SERVICE_TYPES.length; i++) {
    const st = SERVICE_TYPES[i];
    const { rows: existingRows } = await pool.query('SELECT id FROM service_types WHERE key = $1', [st.key]);
    let typeId;
    if (existingRows[0]) {
      typeId = existingRows[0].id;
    } else {
      const result = await pool.query(
        `INSERT INTO service_types (name, key, kind, attendance_mode, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [st.name, st.key, st.kind, st.mode, i]
      );
      typeId = result.rows[0].id;
    }

    for (let j = 0; j < st.sessions.length; j++) {
      const sName = st.sessions[j];
      await ensure(
        'service_type_sessions',
        'service_type_id = ? AND name = ?',
        [typeId, sName],
        'INSERT INTO service_type_sessions (service_type_id, name, sort_order) VALUES (?, ?, ?)',
        [typeId, sName, j]
      );
    }
  }

  // ------------------------- Offering categories ----------------------------
  console.log('- offering categories');
  const OFFERING_CATEGORIES = [
    { name: 'Zaka (Tithe)', key: 'zaka', legacy: 'tithe', receipt: 1 },
    { name: 'Thanksgiving Offering', key: 'thanksgiving', legacy: 'thanksgiving', receipt: 1 },
    { name: 'General Offering', key: 'general', legacy: 'service', receipt: 0 },
    { name: 'Special Project', key: 'special', legacy: 'special', receipt: 1 },
  ];
  for (let i = 0; i < OFFERING_CATEGORIES.length; i++) {
    const cat = OFFERING_CATEGORIES[i];
    await ensure(
      'offering_categories',
      'key = ?',
      [cat.key],
      'INSERT INTO offering_categories (name, key, legacy, requires_receipt, sort_order) VALUES (?, ?, ?, ?, ?)',
      [cat.name, cat.key, cat.legacy, cat.receipt, i]
    );
  }

  // Normalise legacy offering type values to the canonical category keys.
  const { canonicalizeOfferingTypes } = require('./canonicalize');
  await canonicalizeOfferingTypes();
  // Rows that only ever carried a legacy string still need their category_id.
  for (const { key } of OFFERING_CATEGORIES) {
    await pool.query(
      `UPDATE offerings SET category_id = (SELECT id FROM offering_categories WHERE key = $1)
       WHERE type = $1 AND category_id IS NULL`,
      [key]
    );
  }

  // ------------------------- Revival centers + zones ------------------------
  console.log('- revival centers');
  for (let i = 1; i <= 8; i++) {
    const centerId = await ensure(
      'revival_centers',
      'name = ?',
      [`Revival Center ${i}`],
      'INSERT INTO revival_centers (name, sort_order) VALUES (?, ?)',
      [`Revival Center ${i}`, i]
    );
    for (const zone of ['Zone A', 'Zone B']) {
      await ensure(
        'center_zones',
        'revival_center_id = ? AND name = ?',
        [centerId, zone],
        'INSERT INTO center_zones (revival_center_id, name) VALUES (?, ?)',
        [centerId, zone]
      );
    }
  }

  // ------------------------- Groups -------------------------------------------
  console.log('- groups');
  const GROUPS = [
    { name: 'WWK', kind: 'small_group' },
    { name: 'CMF', kind: 'small_group' },
    { name: 'CAs (Vijana)', kind: 'small_group' },
    { name: 'Watoto', kind: 'small_group' },
    { name: 'Choir 1', kind: 'choir' },
    { name: 'Choir 2', kind: 'choir' },
    { name: 'Praise & Worship Team', kind: 'worship_team' },
  ];
  for (let i = 0; i < GROUPS.length; i++) {
    const g = GROUPS[i];
    const id = await ensure(
      '"groups"',
      'name = ?',
      [g.name],
      'INSERT INTO "groups" (name, kind, sort_order) VALUES (?, ?, ?)',
      [g.name, g.kind, i]
    );
    // ensure() only inserts when the name is absent, so a group that already
    // existed kept whatever kind it had, which is how a database migrated from
    // the retired SQLite seed ended up with every one of these groups stored as
    // 'fellowship' while the Groups page showed a faithful 'Fellowship' badge.
    // The badge was never the bug: the value underneath it was stale, and
    // nothing reconciled it. The seed owns these seven names, so re-seeding now
    // brings their kinds back in line with what this file declares (a group
    // renamed or removed by hand is left alone: it is no longer one of them).
    const { rows: current } = await pool.query('SELECT kind FROM "groups" WHERE id = $1', [id]);
    if (current[0] && current[0].kind !== g.kind) {
      await pool.query('UPDATE "groups" SET kind = $1 WHERE id = $2', [g.kind, id]);
      console.log(`  - corrected ${g.name}: ${current[0].kind} -> ${g.kind}`);
    }
  }

  // ------------------------- Legacy session cleanup ---------------------------
  // The old seed created untyped service sessions for "today". Because they are
  // not linked to a service type they would show up as miscategorized orphans.
  // Remove them only where nothing references them yet, then create properly
  // typed sessions for today so the front desk has something to pick from.
  await pool.query(
    `DELETE FROM services
     WHERE service_type_id IS NULL
       AND id NOT IN (SELECT service_id FROM attendance)
       AND id NOT IN (SELECT service_id FROM offerings)
       AND id NOT IN (SELECT service_id FROM emergencies)`
  );

  const today = todayISO();
  const { rows: activeTypes } = await pool.query(
    'SELECT * FROM service_types WHERE is_active = 1 ORDER BY sort_order'
  );
  for (const t of activeTypes) {
    const { rows: existingService } = await pool.query(
      'SELECT id FROM services WHERE date = $1 AND service_type_id = $2',
      [today, t.id]
    );
    if (!existingService[0]) {
      await pool.query('INSERT INTO services (name, date, time, service_type_id) VALUES ($1, $2, $3, $4)', [
        t.name,
        today,
        null,
        t.id,
      ]);
      console.log(`- created ${t.name} session for ${today}`);
    }
  }

  console.log('Done. IMPORTANT: change the seeded passwords immediately after first login.');
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('Seeding failed:', err);
    return pool.end().finally(() => process.exit(1));
  });
