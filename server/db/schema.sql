-- VRT-CMS Postgres schema
-- Converted from server/db/init.js (better-sqlite3 / SQLite)
-- Run once against a fresh database: psql -U vrt_admin -d vrt_cms -f schema.sql

-- ===================== Core / legacy tables =====================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('receptionist','admin','pastor','superadmin')),
  password_hash TEXT NOT NULL,
  language_pref TEXT NOT NULL DEFAULT 'en',
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  service_type_id INTEGER,
  sub_session_id INTEGER,
  is_temporary INTEGER NOT NULL DEFAULT 0,
  event_title TEXT,
  event_description TEXT
);

CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id),
  count INTEGER,
  mode TEXT NOT NULL DEFAULT 'headcount' CHECK (mode IN ('headcount','named','both')),
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  timestamp TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  sub_session_id INTEGER,
  group_id INTEGER,
  revival_center_id INTEGER,
  zone_id INTEGER,
  notified_at TEXT,
  notified_by INTEGER REFERENCES users(id),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id SERIAL PRIMARY KEY,
  record_type TEXT NOT NULL,
  record_id INTEGER,
  sent_to TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  read_at TEXT,
  timestamp TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  url TEXT,
  -- The message this in-app entry announced, when there is one. A recalled
  -- message takes its in-app announcement with it (see routes/notifications.js).
  -- Deliberately unconstrained: this table is created before `messages`, and
  -- `record_id` above is loose in the same way (it points at whichever table
  -- record_type names).
  message_id INTEGER
);

-- Tamper-evident audit log hash-chained to the previous row.
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  table_affected TEXT NOT NULL,
  record_id INTEGER,
  details TEXT,
  ip_address TEXT,
  timestamp TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  prev_hash TEXT NOT NULL DEFAULT '',
  hash TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS emergencies (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low','medium','high','critical')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  service_id INTEGER REFERENCES services(id),
  reported_by INTEGER NOT NULL REFERENCES users(id),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  timestamp TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  notified_at TEXT,
  notified_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- ===================== Reference data tables =====================

CREATE TABLE IF NOT EXISTS service_types (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT UNIQUE NOT NULL,
  -- 'service' = a church service (ibada), which may record attendance and
  -- offerings; 'rehearsal' = a practice session (choir, worship team) that
  -- records attendance only, and is reported separately so it never inflates
  -- the church's service figures. See db/migrate.js for existing databases.
  kind TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('service','rehearsal')),
  attendance_mode TEXT NOT NULL DEFAULT 'headcount' CHECK (attendance_mode IN ('headcount','named','both')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS service_type_sessions (
  id SERIAL PRIMARY KEY,
  service_type_id INTEGER NOT NULL REFERENCES service_types(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS offering_categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  key TEXT UNIQUE NOT NULL,
  legacy TEXT,
  requires_receipt INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS revival_centers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS center_zones (
  id SERIAL PRIMARY KEY,
  revival_center_id INTEGER NOT NULL REFERENCES revival_centers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  member_no TEXT,
  name TEXT NOT NULL,
  phone_enc TEXT,
  email TEXT,
  gender TEXT,
  date_joined TEXT,
  revival_center_id INTEGER REFERENCES revival_centers(id),
  zone_id INTEGER REFERENCES center_zones(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS "groups" (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'small_group' CHECK (kind IN ('small_group','choir','worship_team','fellowship')),
  description TEXT,
  -- The group's own logo, stored with the group rather than compiled into a
  -- client: a choir's identity belongs to the choir, and a new group must not
  -- need a deploy to look like itself. Bytes live here (never on the filesystem,
  -- which backups would silently desync); the API serves them per group under
  -- /groups/:id/logo and every list/detail payload carries only `has_logo`, so
  -- megabytes of images never ride along with a JSON list (see routes/groups.js).
  logo_data BYTEA,
  logo_mime TEXT,
  logo_updated_at TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS group_members (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','leader','co-leader')),
  joined_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  CONSTRAINT ux_group_members_pair UNIQUE (group_id, member_id)
);

-- What CHANGED in a group's membership, one row per change: added, removed, or
-- promoted/demoted. This is what a group update to the pastor is built from.
--
-- History, never an answer to "who is in this group now". That question is
-- answered from group_members alone: no roster, count or picker anywhere reads
-- this table, and nothing here is joined into one. What the table adds is the
-- one thing a current membership list cannot say: what changed since the pastor
-- was last told. Previously the update carried a snapshot of the roster taken at
-- send time, which made two updates from different days contradict each other
-- (a member who left in between made the newer card claim FEWER members than the
-- older one, with nothing anywhere saying anyone had left). A change log has no
-- such failure mode: the feed can only say what happened, and the group's own
-- page is the single place that says who is in it today.
--
-- `member_name` is stored rather than joined. A member who is later deleted (or
-- removed and re-added) must still be nameable in a change that was already
-- reported, and group_members cascades that name away with the member row.
-- `member_id` is deliberately unconstrained, exactly like notifications_log's
-- record_id: it names the member for as long as they exist.
--
-- `reported_at` is the same watermark the daily digest keeps on attendance and
-- offerings (see utils/digest.js): it is stamped in the transaction that writes
-- the update, so a second press of "Send to pastor" cannot report the same
-- change twice, and several changes made before one press arrive as ONE update.
CREATE TABLE IF NOT EXISTS group_member_events (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  member_id INTEGER,
  member_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('added','removed','role_changed')),
  role TEXT,
  actor_id INTEGER REFERENCES users(id),
  at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  reported_at TEXT
);

-- The only read that matters is "this group's unreported changes", so the index
-- is partial: reported changes are history nobody queries by group.
CREATE INDEX IF NOT EXISTS idx_group_member_events_pending
  ON group_member_events(group_id) WHERE reported_at IS NULL;

-- Who is responsible for a zone, and for what. Shaped exactly like group_members,
-- because it is the same fact one level up: a small set of the church's people
-- attached to a thing, and because a zone can have several bearers of office
-- (a deacon, a treasurer, a secretary). Members, never free text: a zone leader
-- is somebody the church can open, count and reach. Whoever leads a zone of a
-- revival center thereby leads that CENTER, derived, never a second list for an
-- admin to keep in step (see routes/revivalCenters.js).
--
-- Both keys CASCADE. A leader link means nothing without its zone, and nothing
-- without its member: deleting either must not leave a row pointing at a hole.
-- A member is normally deactivated rather than deleted (see routes/members.js),
-- so the second case is rare, and when it happens the zone simply has one fewer
-- leader and keeps standing.
CREATE TABLE IF NOT EXISTS center_zone_leaders (
  id SERIAL PRIMARY KEY,
  zone_id INTEGER NOT NULL REFERENCES center_zones(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  -- What the person is in charge OF: deacon, treasurer, secretary, or whatever
  -- this church calls the job. FREE TEXT on purpose: a fixed enum would mean a
  -- migration and a deploy before an admin could add a role the church already
  -- has, and role names are the church's vocabulary, not this program's.
  --
  -- Empty means "no role recorded", which is only ever true of rows written
  -- before roles existed; the assign form requires one. The app shows that as a
  -- plain "Leader" rather than inventing a job for somebody.
  role_name TEXT NOT NULL DEFAULT '',
  assigned_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  -- One role per member per zone: a person is the deacon OR the treasurer here.
  -- (Two roles for one person would need this key relaxed to include role_name.)
  CONSTRAINT ux_center_zone_leaders_pair UNIQUE (zone_id, member_id)
);

CREATE TABLE IF NOT EXISTS attendance_attendees (
  id SERIAL PRIMARY KEY,
  attendance_id INTEGER NOT NULL REFERENCES attendance(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id),
  name TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('pastor','receptionist','admin','superadmin')),
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('attendance','offering','member_alert','event','general')),
  subject TEXT NOT NULL,
  body TEXT,
  payload TEXT,
  read_at TEXT,
  sent_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  recipient_id INTEGER REFERENCES users(id),
  thread_key TEXT,
  -- A message the sender took back. Recalling never deletes the row: the pastor
  -- simply stops seeing it (every read path filters `recalled_at IS NULL`) while
  -- the sender keeps a marked record of what was withdrawn, and the audit log
  -- keeps who did it and when.
  recalled_at TEXT,
  recalled_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  kind TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event','service','giving','conference','other')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  collection_type TEXT NOT NULL DEFAULT 'attendance',
  workspace_service_id INTEGER REFERENCES services(id),
  announced_at TEXT
);

-- ===================== Deferred foreign keys (tables above referenced these before they existed) =====================

ALTER TABLE services
  ADD CONSTRAINT fk_services_service_type FOREIGN KEY (service_type_id) REFERENCES service_types(id),
  ADD CONSTRAINT fk_services_sub_session FOREIGN KEY (sub_session_id) REFERENCES service_type_sessions(id);

ALTER TABLE attendance
  ADD CONSTRAINT fk_attendance_sub_session FOREIGN KEY (sub_session_id) REFERENCES service_type_sessions(id),
  ADD CONSTRAINT fk_attendance_group FOREIGN KEY (group_id) REFERENCES "groups"(id),
  ADD CONSTRAINT fk_attendance_center FOREIGN KEY (revival_center_id) REFERENCES revival_centers(id),
  ADD CONSTRAINT fk_attendance_zone FOREIGN KEY (zone_id) REFERENCES center_zones(id);



-- ===================== Offerings (categorized) =====================

CREATE TABLE IF NOT EXISTS offerings (
  id SERIAL PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id),
  category_id INTEGER REFERENCES offering_categories(id),
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TZS',
  offerer_name_enc TEXT,
  offerer_phone_enc TEXT,
  reason TEXT,
  project_name TEXT,
  receipt_number TEXT UNIQUE,
  member_id INTEGER REFERENCES members(id),
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  sub_session_id INTEGER REFERENCES service_type_sessions(id),
  group_id INTEGER REFERENCES "groups"(id),
  revival_center_id INTEGER REFERENCES revival_centers(id),
  zone_id INTEGER REFERENCES center_zones(id),
  notes TEXT,
  notified_at TEXT,
  notified_by INTEGER REFERENCES users(id),
  timestamp TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  voided_at TEXT,
  voided_by INTEGER REFERENCES users(id),
  void_reason TEXT,
  -- Receipt verification (the QR printed on every receipt). The token is the
  -- public credential the QR carries: unguessable, unique, and never derived
  -- from the sequential offering id: see utils/receiptVerification.js. It is
  -- deliberately kept on the offering row, because the offering IS the
  -- transaction and its receipt_number IS the receipt identity: a correction
  -- that reuses the receipt number carries the same token, so one receipt has
  -- exactly one verification identity for its whole life.
  verification_token TEXT UNIQUE,
  verification_status TEXT NOT NULL DEFAULT 'active',  -- active | revoked
  verification_revoked_at TEXT,
  verification_revoked_by INTEGER REFERENCES users(id),
  verification_revocation_reason TEXT,
  -- How the gift was paid, and the reference that came with it (a mobile-money
  -- confirmation code, a bank slip or a cheque number). Two plain columns rather
  -- than a payments table: the offering IS the transaction, so a separate record
  -- would have nothing of its own to point at: see utils/payments.js.
  -- NULL means "not recorded" (every row that predates this feature), never
  -- "cash": inferring a method nobody entered would be inventing data about how
  -- the church handled money.
  payment_method TEXT,     -- cash | mobile_money | bank | cheque
  payment_reference TEXT,  -- printed on the receipt and shown on the verification page
  CONSTRAINT offerings_verification_status_check CHECK (verification_status IN ('active', 'revoked')),
  CONSTRAINT offerings_payment_method_check CHECK (payment_method IN ('cash', 'mobile_money', 'bank', 'cheque'))
);

-- ===================== Special projects =====================
-- A project is a first-class fundraising record (name, goal, timeline,
-- status), not a bare offering category. Its money is NOT tallied separately:
-- contributions are the offerings themselves, linked by offerings.project_id,
-- so the figure on a project page is the same money that appears in the
-- offering ledger, on the receipts and in the reports.

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',       -- active | on_hold | completed
  started_on TEXT,
  target_on TEXT,
  goal_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TZS',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT
);

-- A pledge is money promised, not money received: pledged amount and fulfilled
-- amount are tracked apart so "promised" can never be presented as "raised".
CREATE TABLE IF NOT EXISTS project_pledges (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id),
  pledge_name_enc TEXT,                        -- free text for a pledger not in the member list
  amount REAL NOT NULL,
  fulfilled_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TZS',
  pledged_on TEXT,
  status TEXT NOT NULL DEFAULT 'open',         -- open | fulfilled | cancelled
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- What the project owes. A `paid` row is money already spent, an `outstanding`
-- one is still owed, which is what lets leadership see a net position instead
-- of gross funds raised.
CREATE TABLE IF NOT EXISTS project_debts (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'TZS',
  status TEXT NOT NULL DEFAULT 'outstanding',  -- outstanding | paid
  incurred_on TEXT,
  paid_on TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- Which project an offering funds. NULL = not a project gift (every zaka,
-- thanksgiving and general offering). Added with IF NOT EXISTS so an existing
-- database picks it up when the schema is re-applied.
ALTER TABLE offerings ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id);

-- ===================== Church payment accounts (imported giving) =====================
-- A church's OWN financial account, connected so the gifts that land in it are
-- recorded without the desk retyping them from a statement.
--
-- WHAT IS NOT STORED HERE: bank passwords, internet-banking logins, mobile-money
-- PINs, or any credential that could be replayed to move money. Those are never
-- asked for and never stored: see utils/paymentAccounts.js and the provider
-- registry in utils/paymentProviders.js. What `credentials_enc` may hold is the
-- narrow, revocable secret a machine-to-machine integration actually needs (an
-- API key, a webhook signing secret), encrypted at rest with utils/crypto.js
-- (AES-256-GCM) and never returned by any endpoint.
--
-- `provider` names which integration a real connection would use. There is no
-- "pretend" provider: the two that exist today are integrations a church can
-- genuinely run (a downloaded statement, and a signed provider webhook), and a
-- provider with a documented API is added by writing one adapter in
-- utils/paymentProviders.js: the accounts, imports, matching, receipts and
-- reports around it do not change.
--
-- The account carries the METHOD a gift on it was paid by (bank account -> bank,
-- mobile-money till -> mobile_money): that is a property of the account, not
-- something to be re-guessed per transaction, and it keeps imported gifts in the
-- same four-value vocabulary the front desk uses (utils/payments.js).
--
-- `source` marks rows the demo seeder wrote ('demo'), so scripts/sample-giving.js
-- can remove exactly its own footprint and nothing else (see that file).
CREATE TABLE IF NOT EXISTS payment_accounts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,                        -- a key from utils/paymentProviders.js
  method TEXT NOT NULL,                          -- cash | mobile_money | bank | cheque
  account_ref TEXT,                              -- the church's own account/till number (masked in the UI)
  currency TEXT NOT NULL DEFAULT 'TZS',
  status TEXT NOT NULL DEFAULT 'active',         -- active | disabled
  credentials_enc TEXT,
  last_synced_at TEXT,
  -- The outcome of the last import, as JSON ({inserted, duplicates, rejected,
  -- fileName}). JSON rather than a sentence because the admin screen renders it
  -- with catalog keys, so the counts read in the admin's own language, which is the same
  -- reason messages.payload exists (see routes/messages.js).
  last_sync_summary TEXT,
  source TEXT NOT NULL DEFAULT 'manual',         -- manual | demo
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT,
  CONSTRAINT payment_accounts_method_check CHECK (method IN ('cash', 'mobile_money', 'bank', 'cheque')),
  CONSTRAINT payment_accounts_status_check CHECK (status IN ('active', 'disabled')),
  CONSTRAINT payment_accounts_source_check CHECK (source IN ('manual', 'demo')),
  -- One connection per real account: connecting the same bank account twice would
  -- import every payment twice. NULL account_ref stays unconstrained (an admin
  -- may add an account before its number is to hand).
  CONSTRAINT ux_payment_accounts_provider_ref UNIQUE (provider, account_ref)
);

-- One payment that arrived in one church account, as the provider reported it.
--
-- THIS IS NOT A SECOND LEDGER. An unmatched transaction is not giving: it is a
-- statement line waiting to be explained, and a transaction becomes giving only
-- when a person confirms it, at which point it writes ONE offering (the same
-- record the front desk writes, with the same receipt and QR code) and keeps the
-- pointer in `offering_id`. So every report still totals offerings and nothing
-- has to add two sources of money together (see utils/paymentIntake.js).
--
-- IDEMPOTENCY IS A DATABASE GUARANTEE, not a convention: `ux_payment_transactions_provider`
-- means re-syncing an overlapping statement cannot insert the same provider
-- transaction twice. `provider_transaction_id` is the provider's own identifier;
-- when a provider sends none, utils/paymentIntake.js derives one from the fields
-- it did send (date + amount + reference + payer) so the key is still meaningful.
--
-- `status` is the PROVIDER's verdict (pending/successful/reversed/failed) and is
-- deliberately separate from `match_status`, which is the CHURCH's (did we work
-- out who gave this, and has anybody confirmed it?).
--
-- `payer_phone_enc` is encrypted for the same reason members.phone_enc is: a
-- payer's phone number is personal data, and matching needs only an equality
-- comparison, not a readable column. A payer is NOT assumed to be the giver:
-- `matched_member_id` is filled only by the rules in utils/paymentIntake.js, and
-- 'review' means "a human must decide" (see the seed data for why).
CREATE TABLE IF NOT EXISTS payment_transactions (
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
  status TEXT NOT NULL DEFAULT 'successful',      -- pending | successful | reversed | failed
  source TEXT NOT NULL DEFAULT 'statement',       -- statement | webhook | demo
  match_status TEXT NOT NULL DEFAULT 'unmatched', -- unmatched | review | matched | confirmed | ignored
  matched_member_id INTEGER REFERENCES members(id),
  suggested_member_id INTEGER REFERENCES members(id),
  match_method TEXT,                              -- member_no | phone | name | manual
  -- WHY a payment is sitting in review, where the state alone does not say. A
  -- stored KEY, not a sentence: the admin screen names the reason in its own
  -- language, the way the other catalog keys work. NULL means "nothing to add"
  -- (an unknown payer, a name two members share): the state is the whole story.
  -- Cleared the moment a person decides, because the note explains the matcher's
  -- hesitation and nobody's decision needs explaining.
  match_note TEXT,                                -- code_vs_payer_name
  matched_by INTEGER REFERENCES users(id),
  matched_at TEXT,
  offering_id INTEGER REFERENCES offerings(id),
  reconciled_by INTEGER REFERENCES users(id),
  reconciled_at TEXT,
  ignored_reason TEXT,
  import_note TEXT,                               -- the file it came in on, shown as-is (data, not UI copy)
  -- The earlier row that looks like the same payment under a different provider
  -- id. A POINTER rather than a sentence in a note: the admin screen renders
  -- "possible duplicate of #41" in its own language, and the link means the
  -- question can be answered by opening the other row.
  possible_duplicate_of INTEGER REFERENCES payment_transactions(id),
  imported_by INTEGER REFERENCES users(id),
  imported_at TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
  CONSTRAINT payment_transactions_status_check CHECK (status IN ('pending', 'successful', 'reversed', 'failed')),
  CONSTRAINT payment_transactions_source_check CHECK (source IN ('statement', 'webhook', 'demo')),
  CONSTRAINT payment_transactions_match_status_check CHECK (match_status IN ('unmatched', 'review', 'matched', 'confirmed', 'ignored')),
  CONSTRAINT ux_payment_transactions_provider UNIQUE (account_id, provider_transaction_id)
);

-- Which provider line an offering came from, and how that offering was written.
-- `source`: 'manual' = typed at the desk, 'import' = confirmed from an imported
-- payment, 'demo' = written by scripts/sample-giving.js (which is what makes the
-- demo purge exact; see that script). Added with IF NOT EXISTS so an existing
-- database picks both columns up on the next boot.
ALTER TABLE offerings ADD COLUMN IF NOT EXISTS payment_transaction_id INTEGER REFERENCES payment_transactions(id);
ALTER TABLE offerings ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
-- ADD CONSTRAINT has no IF NOT EXISTS, so the duplicate is swallowed explicitly
-- on databases already carrying the constraints (db/migrate.js declares the same
-- two statements for a running church).
DO $$ BEGIN
  ALTER TABLE offerings ADD CONSTRAINT offerings_source_check CHECK (source IN ('manual', 'import', 'demo'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
-- ONE giving record per provider transaction. This is what stops a double-click
-- on Confirm from recording the same gift twice, and it holds even if two admins
-- confirm the same row at the same instant.
CREATE UNIQUE INDEX IF NOT EXISTS ux_offerings_payment_transaction ON offerings(payment_transaction_id);

-- ===================== Indexes =====================

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_emergencies_status ON emergencies(status);
CREATE INDEX IF NOT EXISTS idx_attendance_service ON attendance(service_id);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_services_type ON services(service_type_id);
CREATE INDEX IF NOT EXISTS idx_services_date ON services(date);
CREATE INDEX IF NOT EXISTS idx_offerings_service ON offerings(service_id);
CREATE INDEX IF NOT EXISTS idx_offerings_type ON offerings(type);
CREATE INDEX IF NOT EXISTS idx_attendance_sub_session ON attendance(sub_session_id);
CREATE INDEX IF NOT EXISTS idx_attendance_group ON attendance(group_id);
CREATE INDEX IF NOT EXISTS idx_attendance_center ON attendance(revival_center_id);
CREATE INDEX IF NOT EXISTS idx_attendance_zone ON attendance(zone_id);
CREATE INDEX IF NOT EXISTS idx_offerings_receipt ON offerings(receipt_number);
CREATE INDEX IF NOT EXISTS idx_offerings_verification_token ON offerings(verification_token);
CREATE INDEX IF NOT EXISTS idx_offerings_category ON offerings(category_id);
CREATE INDEX IF NOT EXISTS idx_offerings_group ON offerings(group_id);
CREATE INDEX IF NOT EXISTS idx_offerings_center ON offerings(revival_center_id);
CREATE INDEX IF NOT EXISTS idx_offerings_sub_session ON offerings(sub_session_id);
CREATE INDEX IF NOT EXISTS idx_members_center ON members(revival_center_id);
CREATE INDEX IF NOT EXISTS idx_members_zone ON members(zone_id);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(name);
CREATE INDEX IF NOT EXISTS idx_group_members_member ON group_members(member_id);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_center_zone_leaders_zone ON center_zone_leaders(zone_id);
CREATE INDEX IF NOT EXISTS idx_center_zone_leaders_member ON center_zone_leaders(member_id);
CREATE INDEX IF NOT EXISTS idx_attendees_attendance ON attendance_attendees(attendance_id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_role);
CREATE INDEX IF NOT EXISTS idx_offerings_project ON offerings(project_id);
CREATE INDEX IF NOT EXISTS idx_pledges_project ON project_pledges(project_id);
CREATE INDEX IF NOT EXISTS idx_debts_project ON project_debts(project_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_account ON payment_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_match_status ON payment_transactions(match_status);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_occurred ON payment_transactions(occurred_at);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_offering ON payment_transactions(offering_id);
CREATE INDEX IF NOT EXISTS idx_payment_accounts_status ON payment_accounts(status);
CREATE INDEX IF NOT EXISTS idx_offerings_source ON offerings(source);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(starts_at);
CREATE INDEX IF NOT EXISTS idx_events_created_by ON events(created_by);
