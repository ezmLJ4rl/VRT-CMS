'use strict';
/**
 * Schema evolution for databases that already exist.
 *
 * `db/schema.sql` is a one-shot bootstrap: `db/seed.pg.js` only applies it when
 * the database is empty, so a column added there would never reach a church whose
 * system is already running and already full of real records. Every schema change
 * therefore also lands here, as a statement that is safe to run on every boot:
 * the same self-repair approach as `db/canonicalize.js`, and the reason a deploy
 * needs no manual migration step.
 *
 * Rules for anything added here:
 *   - it must be idempotent (guarded by IF NOT EXISTS, or an exception handler);
 *   - it must be additive: a live church database is never dropped or rewritten;
 *   - it must be cheap, because this runs at startup before the server listens.
 */
const pool = require('./pg');
const { generateVerificationToken } = require('../utils/verificationToken');
// The number a member quotes when they pay: one allocator for the form, this
// backfill and the matcher (see utils/memberNumbers.js).
const { nextMemberNo } = require('../utils/memberNumbers');

const STATEMENTS = [
  // Rehearsals vs services (ibada). Existing rows are services, which is what
  // the column default says, so this is a no-op for them.
  `ALTER TABLE service_types ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'service'`,
  // ADD CONSTRAINT has no IF NOT EXISTS, so re-running is swallowed explicitly.
  `DO $$ BEGIN
     ALTER TABLE service_types
       ADD CONSTRAINT service_types_kind_check CHECK (kind IN ('service','rehearsal'));
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,
  { label: 'service_types kind', sql: "CREATE INDEX IF NOT EXISTS idx_service_types_kind ON service_types(kind)" },
  // The three rehearsals existed before rehearsals were a concept, as named-only
  // services. Move them over, but only while they still look exactly like that
  // original default, so an admin who has since re-classified or reconfigured a
  // type is never overridden. This is a data migration, so it lives here rather
  // than in the seeder: a church that simply restarts gets it too.
  {
    label: 'rehearsals reclassified',
    sql: `UPDATE service_types SET kind = 'rehearsal', attendance_mode = 'both'
           WHERE key IN ('choir_rehearsal_1','choir_rehearsal_2','pw_rehearsal')
             AND kind = 'service' AND attendance_mode = 'named'`,
  },
  // ---- Server-side session records (see db/schema.sql for the commentary) --
  // One row per authenticated device: concurrent logins each get their own
  // revocable session, so multi-device use is a first-class fact, and "log out
  // here" and "log out everywhere" are different, verifiable operations.
  {
    label: 'user_sessions',
    sql: `CREATE TABLE IF NOT EXISTS user_sessions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            sid TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
            last_active_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
            revoked_at TEXT
          )`,
  },
  { label: 'user_sessions user index', sql: 'CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id)' },
  // Appointment requests between secretary-capable staff and the pastor.
  {
    label: 'appointments',
    sql: `CREATE TABLE IF NOT EXISTS appointments (
            id SERIAL PRIMARY KEY,
            requested_by INTEGER NOT NULL REFERENCES users(id),
            pastor_id INTEGER NOT NULL REFERENCES users(id),
            requested_date TEXT NOT NULL,
            requested_time TEXT NOT NULL,
            duration_minutes INTEGER,
            purpose TEXT NOT NULL,
            requester_notes TEXT,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','declined','rescheduled','completed','cancelled')),
            proposed_date TEXT,
            proposed_time TEXT,
            pastor_notes TEXT,
            created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
            updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
          )`,
  },
  { label: 'appointments requester index', sql: 'CREATE INDEX IF NOT EXISTS idx_appointments_requested_by ON appointments(requested_by)' },
  { label: 'appointments pastor status index', sql: 'CREATE INDEX IF NOT EXISTS idx_appointments_pastor_status ON appointments(pastor_id, status)' },
  { label: 'appointments date index', sql: 'CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(requested_date)' },
  // Appointment messages are direct user messages, but older databases have a
  // category constraint that predates this workflow.
  {
    label: 'messages appointment category',
    sql: `DO $$ BEGIN
            ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_category_check;
            ALTER TABLE messages ADD CONSTRAINT messages_category_check CHECK (category IN ('attendance','offering','member_alert','event','appointment','general'));
          EXCEPTION WHEN duplicate_object THEN NULL;
          END $$`,
  },
  // Special projects (see db/schema.sql for the full commentary). Created here
  // as well because a running church database never re-runs schema.sql: a
  // deploy must not need a manual migration step.
  {
    label: 'projects',
    sql: `CREATE TABLE IF NOT EXISTS projects (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            started_on TEXT,
            target_on TEXT,
            goal_amount REAL NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'TZS',
            created_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
            updated_at TEXT
          )`,
  },
  {
    label: 'projects integrity constraints',
    sql: `DO $$ BEGIN
            ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (status IN ('active','on_hold','completed'));
          EXCEPTION WHEN duplicate_object THEN NULL;
          END $$`,
  },
  {
    label: 'projects goal constraint',
    sql: `DO $$ BEGIN
            ALTER TABLE projects ADD CONSTRAINT projects_goal_amount_check CHECK (goal_amount >= 0);
          EXCEPTION WHEN duplicate_object THEN NULL;
          END $$`,
  },
  {
    label: 'project_pledges',
    sql: `CREATE TABLE IF NOT EXISTS project_pledges (
            id SERIAL PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            member_id INTEGER REFERENCES members(id),
            pledge_name_enc TEXT,
            amount REAL NOT NULL,
            fulfilled_amount REAL NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'TZS',
            pledged_on TEXT,
            status TEXT NOT NULL DEFAULT 'open',
            notes TEXT,
            created_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
          )`,
  },
  {
    label: 'project pledges integrity constraints',
    sql: `DO $$ BEGIN
            ALTER TABLE project_pledges ADD CONSTRAINT project_pledges_status_check CHECK (status IN ('open','fulfilled','cancelled'));
          EXCEPTION WHEN duplicate_object THEN NULL;
          END $$`,
  },
  {
    label: 'project pledges amount constraint',
    sql: `DO $$ BEGIN
            ALTER TABLE project_pledges ADD CONSTRAINT project_pledges_amount_check CHECK (amount > 0 AND fulfilled_amount >= 0 AND fulfilled_amount <= amount);
          EXCEPTION WHEN duplicate_object THEN NULL;
          END $$`,
  },
  {
    label: 'project_debts',
    sql: `CREATE TABLE IF NOT EXISTS project_debts (
            id SERIAL PRIMARY KEY,
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            description TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'TZS',
            status TEXT NOT NULL DEFAULT 'outstanding',
            incurred_on TEXT,
            paid_on TEXT,
            notes TEXT,
            created_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
          )`,
  },
  {
    label: 'project debts integrity constraints',
    sql: `DO $$ BEGIN
            ALTER TABLE project_debts ADD CONSTRAINT project_debts_status_check CHECK (status IN ('outstanding','paid'));
          EXCEPTION WHEN duplicate_object THEN NULL;
          END $$`,
  },
  {
    label: 'project debts amount constraint',
    sql: `DO $$ BEGIN
            ALTER TABLE project_debts ADD CONSTRAINT project_debts_amount_check CHECK (amount > 0);
          EXCEPTION WHEN duplicate_object THEN NULL;
          END $$`,
  },
  {
    label: 'offerings.project_id',
    sql: 'ALTER TABLE offerings ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id)',
  },
  // Who leads a zone. Added after the fact because zones shipped first: a
  // church already running has zones with no leader column at all, and the
  // roster's zone cards read this through GET /revival-centers.
  // Zone leaders used to be a single member id on the zone. A zone can be led by
  // more than one member, so they now live in their own table: shaped like
  // group_members, because it is the same fact one level up.
  {
    label: 'center_zone_leaders',
    sql: `CREATE TABLE IF NOT EXISTS center_zone_leaders (
            id SERIAL PRIMARY KEY,
            zone_id INTEGER NOT NULL REFERENCES center_zones(id) ON DELETE CASCADE,
            member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
            assigned_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
            CONSTRAINT ux_center_zone_leaders_pair UNIQUE (zone_id, member_id)
          )`,
  },
  // What each zone leader is in charge of. Free text (see db/schema.sql): the
  // church's own word for the job, addable by an admin without a deploy. Existing
  // rows keep '': "no role recorded", which the app renders as a plain Leader
  // rather than guessing a job for somebody who was assigned before roles existed.
  { label: 'center_zone_leaders.role_name', sql: "ALTER TABLE center_zone_leaders ADD COLUMN IF NOT EXISTS role_name TEXT NOT NULL DEFAULT ''" },
  { label: 'center zone leaders index', sql: 'CREATE INDEX IF NOT EXISTS idx_center_zone_leaders_zone ON center_zone_leaders(zone_id)' },
  // Carry every existing single leader across before the column goes. Guarded on
  // the column existing, because a database bootstrapped from schema.sql never
  // had it: without the guard this statement would throw and stop the rest of
  // the migration on exactly the databases that are already up to date.
  {
    label: 'zone leaders carried over',
    sql: `DO $$ BEGIN
            IF EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'center_zones' AND column_name = 'leader_member_id') THEN
              INSERT INTO center_zone_leaders (zone_id, member_id)
                SELECT id, leader_member_id FROM center_zones WHERE leader_member_id IS NOT NULL
                ON CONFLICT DO NOTHING;
            END IF;
          END $$`,
  },
  // Then drop the old column. This is the one deliberate exception to "additive":
  // the values were copied in the statement above, in the same pass, so nothing
  // is lost, and leaving a second, unread answer to "who leads this zone?" in
  // the schema is how a future reader gets it wrong.
  { label: 'center_zones.leader_member_id dropped', sql: 'ALTER TABLE center_zones DROP COLUMN IF EXISTS leader_member_id' },
  { label: 'offerings project index', sql: 'CREATE INDEX IF NOT EXISTS idx_offerings_project ON offerings(project_id)' },
  { label: 'pledges project index', sql: 'CREATE INDEX IF NOT EXISTS idx_pledges_project ON project_pledges(project_id)' },
  { label: 'debts project index', sql: 'CREATE INDEX IF NOT EXISTS idx_debts_project ON project_debts(project_id)' },
  // Group logos, stored with the group (see the comment on the columns in
  // db/schema.sql). Additive: a database bootstrapped from an older schema.sql
  // simply gains the three columns on next boot.
  { label: 'groups.logo_data', sql: 'ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS logo_data BYTEA' },
  { label: 'groups.logo_mime', sql: 'ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS logo_mime TEXT' },
  { label: 'groups.logo_updated_at', sql: 'ALTER TABLE "groups" ADD COLUMN IF NOT EXISTS logo_updated_at TEXT' },
  // Recalling a message (see routes/messages.js): additive, and every existing
  // row keeps its current meaning because NULL is "not recalled".
  { label: 'messages.recalled_at', sql: 'ALTER TABLE messages ADD COLUMN IF NOT EXISTS recalled_at TEXT' },
  { label: 'messages.recalled_by', sql: 'ALTER TABLE messages ADD COLUMN IF NOT EXISTS recalled_by INTEGER REFERENCES users(id)' },
  // Which message an in-app notification announced. Without it a recall could
  // only remove the message and leave the pastor's notification feed still
  // naming it: the exact half-widrawn state the feature exists to prevent.
  { label: 'notifications_log.message_id', sql: 'ALTER TABLE notifications_log ADD COLUMN IF NOT EXISTS message_id INTEGER' },
  // Receipt verification (the QR on every receipt: see
  // utils/receiptVerification.js and db/schema.sql). Additive and NULL-able: an
  // offering without a receipt keeps no verification identity, and every
  // existing receipt row is given one by backfillVerificationTokens() below,
  // which runs once on the first boot after this deploy.
  { label: 'offerings.verification_token', sql: 'ALTER TABLE offerings ADD COLUMN IF NOT EXISTS verification_token TEXT' },
  { label: 'offerings.verification_status', sql: "ALTER TABLE offerings ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'active'" },
  { label: 'offerings.verification_revoked_at', sql: 'ALTER TABLE offerings ADD COLUMN IF NOT EXISTS verification_revoked_at TEXT' },
  { label: 'offerings.verification_revoked_by', sql: 'ALTER TABLE offerings ADD COLUMN IF NOT EXISTS verification_revoked_by INTEGER REFERENCES users(id)' },
  { label: 'offerings.verification_revocation_reason', sql: 'ALTER TABLE offerings ADD COLUMN IF NOT EXISTS verification_revocation_reason TEXT' },
  // The token is the public credential, so it must be unique: a UNIQUE index is
  // what makes "one QR verifies one receipt" a database guarantee. Named as
  // schema.sql's inline UNIQUE names it, so both bootstrap paths agree.
  {
    label: 'offerings_verification_token_key',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS offerings_verification_token_key ON offerings(verification_token)',
  },
  // ADD CONSTRAINT has no IF NOT EXISTS (see the service_types kind check above).
  `DO $$ BEGIN
     ALTER TABLE offerings
       ADD CONSTRAINT offerings_verification_status_check CHECK (verification_status IN ('active','revoked'));
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,
  // How a gift was paid, and the reference that came with it (see
  // utils/payments.js and db/schema.sql). Additive and NULL-able: every offering
  // recorded before this keeps "not recorded" rather than being assumed to have
  // been cash, and no existing receipt changes what it says.
  { label: 'offerings.payment_method', sql: 'ALTER TABLE offerings ADD COLUMN IF NOT EXISTS payment_method TEXT' },
  { label: 'offerings.payment_reference', sql: 'ALTER TABLE offerings ADD COLUMN IF NOT EXISTS payment_reference TEXT' },
  `DO $$ BEGIN
     ALTER TABLE offerings
       ADD CONSTRAINT offerings_payment_method_check CHECK (payment_method IN ('cash','mobile_money','bank','cheque'));
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,

  // ---- Church payment accounts and the payments that arrive in them --------
  // (see db/schema.sql for the full commentary; declared here as well because a
  // running church database never re-runs schema.sql). Additive throughout: an
  // existing database gains two empty tables and two columns, and no existing
  // offering changes what it says: `source` defaults to 'manual', which is what
  // every row written before this feature genuinely was.
  {
    label: 'payment_accounts',
    sql: `CREATE TABLE IF NOT EXISTS payment_accounts (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            provider TEXT NOT NULL,
            method TEXT NOT NULL,
            account_ref TEXT,
            currency TEXT NOT NULL DEFAULT 'TZS',
            status TEXT NOT NULL DEFAULT 'active',
            credentials_enc TEXT,
            last_synced_at TEXT,
            last_sync_summary TEXT,
            source TEXT NOT NULL DEFAULT 'manual',
            created_by INTEGER REFERENCES users(id),
            created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
            updated_at TEXT,
            CONSTRAINT payment_accounts_method_check CHECK (method IN ('cash','mobile_money','bank','cheque')),
            CONSTRAINT payment_accounts_status_check CHECK (status IN ('active','disabled')),
            CONSTRAINT payment_accounts_source_check CHECK (source IN ('manual','demo')),
            CONSTRAINT ux_payment_accounts_provider_ref UNIQUE (provider, account_ref)
          )`,
  },
  {
    label: 'payment_transactions',
    sql: `CREATE TABLE IF NOT EXISTS payment_transactions (
            id SERIAL PRIMARY KEY,
            account_id INTEGER NOT NULL REFERENCES payment_accounts(id) ON DELETE CASCADE,
            provider_transaction_id TEXT NOT NULL,
            provider_reference TEXT,
            amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'TZS',
            occurred_at TEXT NOT NULL,
            payer_name TEXT,
            payer_phone_enc TEXT,
            payer_account_ref TEXT,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'successful',
            source TEXT NOT NULL DEFAULT 'statement',
            match_status TEXT NOT NULL DEFAULT 'unmatched',
            matched_member_id INTEGER REFERENCES members(id),
            suggested_member_id INTEGER REFERENCES members(id),
            match_method TEXT,
            match_note TEXT,
            matched_by INTEGER REFERENCES users(id),
            matched_at TEXT,
            offering_id INTEGER REFERENCES offerings(id),
            reconciled_by INTEGER REFERENCES users(id),
            reconciled_at TEXT,
            ignored_reason TEXT,
            import_note TEXT,
            possible_duplicate_of INTEGER REFERENCES payment_transactions(id),
            imported_by INTEGER REFERENCES users(id),
            imported_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
            CONSTRAINT payment_transactions_status_check CHECK (status IN ('pending','successful','reversed','failed')),
            CONSTRAINT payment_transactions_source_check CHECK (source IN ('statement','webhook','demo')),
            CONSTRAINT payment_transactions_match_status_check CHECK (match_status IN ('unmatched','review','matched','confirmed','ignored')),
            CONSTRAINT ux_payment_transactions_provider UNIQUE (account_id, provider_transaction_id)
          )`,
  },
  { label: 'offerings.payment_transaction_id', sql: 'ALTER TABLE offerings ADD COLUMN IF NOT EXISTS payment_transaction_id INTEGER REFERENCES payment_transactions(id)' },
  { label: 'offerings.source', sql: "ALTER TABLE offerings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'" },
  `DO $$ BEGIN
     ALTER TABLE offerings ADD CONSTRAINT offerings_source_check CHECK (source IN ('manual','import','demo'));
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,
  // UNIQUE because one provider transaction may produce at most one giving
  // record: the guarantee that a double-confirmed payment cannot be counted and
  // receipted twice (see routes/paymentTransactions.js).
  { label: 'ux_offerings_payment_transaction', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS ux_offerings_payment_transaction ON offerings(payment_transaction_id)' },
  // WHY a matched-or-not payment is in review, where the state alone cannot say:
  // a stored KEY the admin screen names in its own language (see db/schema.sql).
  { label: 'payment_transactions.match_note', sql: 'ALTER TABLE payment_transactions ADD COLUMN IF NOT EXISTS match_note TEXT' },
  { label: 'payment account/transaction indexes', sql: 'CREATE INDEX IF NOT EXISTS idx_payment_transactions_account ON payment_transactions(account_id)' },
  { label: 'payment match status index', sql: 'CREATE INDEX IF NOT EXISTS idx_payment_transactions_match_status ON payment_transactions(match_status)' },
  { label: 'payment occurred index', sql: 'CREATE INDEX IF NOT EXISTS idx_payment_transactions_occurred ON payment_transactions(occurred_at)' },
  { label: 'payment offering index', sql: 'CREATE INDEX IF NOT EXISTS idx_payment_transactions_offering ON payment_transactions(offering_id)' },
  { label: 'payment accounts status index', sql: 'CREATE INDEX IF NOT EXISTS idx_payment_accounts_status ON payment_accounts(status)' },
  { label: 'offerings source index', sql: 'CREATE INDEX IF NOT EXISTS idx_offerings_source ON offerings(source)' },

  // ---- Group membership changes (see db/schema.sql for the full commentary) --
  // Declared here as well because a running church database never re-runs
  // schema.sql. Additive: an existing database gains one empty table and an
  // index, and nothing that answers "who is in this group now" changes what it
  // reads: that is still group_members alone. The changes that predate this
  // table are carried over by backfillGroupMemberEvents() below, on the first
  // boot after the deploy.
  {
    label: 'group_member_events',
    sql: `CREATE TABLE IF NOT EXISTS group_member_events (
            id SERIAL PRIMARY KEY,
            group_id INTEGER NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
            member_id INTEGER,
            member_name TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN ('added','removed','role_changed')),
            role TEXT,
            actor_id INTEGER REFERENCES users(id),
            at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
            reported_at TEXT
          )`,
  },
  {
    label: 'group member events pending index',
    sql: 'CREATE INDEX IF NOT EXISTS idx_group_member_events_pending ON group_member_events(group_id) WHERE reported_at IS NULL',
  },
];

/**
 * Gives every receipt that predates QR verification its own token.
 *
 * The tokens are minted in Node with crypto.randomBytes, not in SQL: an already
 * printed receipt's QR must not be guessable from its neighbours, and Postgres'
 * random() is a predictable PRNG whose state could be inferred from a batch.
 * Runs on every boot and costs one indexed lookup once the backlog is clear.
 */
async function backfillVerificationTokens() {
  const { rows } = await pool.query(
    'SELECT id FROM offerings WHERE receipt_number IS NOT NULL AND verification_token IS NULL ORDER BY id'
  );
  for (const row of rows) {
    // Only fills the empty slot: a row that already has a token never gets a
    // second identity, so a scan of paper already handed out keeps working.
    await pool.query('UPDATE offerings SET verification_token = $1 WHERE id = $2 AND verification_token IS NULL', [
      generateVerificationToken(),
      row.id,
    ]);
  }
  return rows.length;
}

/**
 * Records every existing group membership as an unreported 'added' change.
 *
 * Without this, a church that upgrades would press "Send to pastor" and be told
 * there is nothing new, while the pastor has in fact never been told who is in
 * that group: the memberships that predate this table have no change history at
 * all. They are recorded with their REAL joined_at, so the change log is not
 * invented, and left unreported, so the next update mentions them once and then
 * never again.
 *
 * Idempotent by construction: a membership that already has an 'added' change is
 * skipped, so this runs on every boot for the cost of one anti-join, and a
 * membership added today (by the routes, which write their own change) is never
 * duplicated here. A self-repairing property falls out of the same guard: a
 * membership that somehow lost its change gets one again.
 */
async function backfillGroupMemberEvents() {
  const { rows } = await pool.query(
    `INSERT INTO group_member_events (group_id, member_id, member_name, action, role, at)
     SELECT gm.group_id, gm.member_id, m.name, 'added', gm.role, gm.joined_at
       FROM group_members gm
       JOIN members m ON m.id = gm.member_id
      WHERE NOT EXISTS (SELECT 1 FROM group_member_events e
                         WHERE e.group_id = gm.group_id
                           AND e.member_id = gm.member_id
                           AND e.action = 'added')
     RETURNING id`
  );
  return rows.length;
}

/**
 * Gives a member number to every member who has none.
 *
 * The number is the code a member quotes when they pay by bank or mobile money,
 * and the reconciliation matcher resolves an incoming payment on it (see
 * utils/identityMatch.js). A member without one is a person money cannot be
 * attributed to, which is why this runs on every boot rather than being left to
 * whoever notices: the column has always allowed NULL, so a database that
 * predates the number, or a row inserted by hand: can genuinely have members
 * without one, and the cost of checking is a single indexed scan.
 *
 * The numbers are allocated from the same allocator the member form uses, so a
 * backfilled member is indistinguishable from one registered today.
 */
async function backfillMemberNumbers() {
  const { rows } = await pool.query(
    "SELECT id FROM members WHERE member_no IS NULL OR member_no = '' ORDER BY id"
  );
  for (const row of rows) {
    // Only fills the empty slot: a member who already has a number never gets a
    // second one, so codes already written on a giving envelope keep working.
    await pool.query('UPDATE members SET member_no = $1 WHERE id = $2 AND (member_no IS NULL OR member_no = \'\')', [
      await nextMemberNo(),
      row.id,
    ]);
  }
  return rows.length;
}

async function migrate() {
  const applied = [];
  for (const entry of STATEMENTS) {
    const { sql, label } = typeof entry === 'string' ? { sql: entry, label: entry } : entry;
    await pool.query(sql);
    applied.push(label);
  }
  const backfilled = await backfillVerificationTokens();
  if (backfilled) applied.push(`receipt verification tokens issued for ${backfilled} existing receipt(s)`);
  const coded = await backfillMemberNumbers();
  if (coded) applied.push(`member numbers issued for ${coded} member(s) without one`);
  const membershipChanges = await backfillGroupMemberEvents();
  if (membershipChanges) applied.push(`group membership changes recorded for ${membershipChanges} existing membership(s)`);
  return applied;
}

module.exports = { migrate, STATEMENTS, backfillVerificationTokens, backfillMemberNumbers, backfillGroupMemberEvents };
