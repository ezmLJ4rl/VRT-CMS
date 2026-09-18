# VRT CMS & VRT Pastor

A secure system for tracking congregation attendance, financial offerings,
and emergency incidents, built for **Victory Revival Temple** (7663+Q4Q, Dar
es Salaam, Tanzania). It's split into three parts:

```
vrt-cms/
├── server/         Node.js/Express API + PostgreSQL database (shared backend)
├── client-admin/   Desktop/web app: receptionists & admins enter data
└── client-pastor/  Installable mobile PWA: the Reverend Pastor's app
```

- **`client-admin`** is where receptionists record attendance and offerings,
  and where admins manage users, view analytics, report/resolve
  emergencies, and export reports. Used on a computer, tablet, or phone
  browser at the front desk or office.
- **`client-pastor`** is a lightweight, installable Progressive Web App
  (PWA) built just for the Reverend Pastor: a fast, read-only, mobile-first
  view of everything happening at church, with **push notifications** the
  moment something is recorded, including urgent emergency alerts.
- Both talk to the same **`server`** API, so everything either app shows is
  always in sync in real time.

---

## 1. Quick start (local development)

You need Node.js 18+ and PostgreSQL 14+ (Docker is the easiest way to get
it locally).

### 1.1 Backend

```bash
cd server
npm install
cp .env.example .env
```

Start the database (Postgres 16 in a container; the credentials it creates
are the ones already in `.env.example`):

```bash
docker compose up -d
```

Fill in the required secrets in `.env` (generator commands are in the
file's comments):

```
DATABASE_URL=postgresql://vrt_admin:<password>@localhost:5432/vrt_cms
                                            # must match docker-compose.yml
JWT_SECRET=...                              # session signing key
JWT_EXPIRES_IN=30d                          # session lifetime (renews as it is used)
FIELD_ENCRYPTION_KEY=...                    # encrypts donor names/phones at rest
VAPID_PUBLIC_KEY=... / VAPID_PRIVATE_KEY=... # enables push notifications to the Pastor PWA
```

```bash
npm run seed   # applies db/schema.sql on a fresh DB, then seeds the
               # Super Admin, Reverend Pastor, service types, and groups
npm start      # API now runs on http://localhost:4000
```

`npm run seed` prints the seeded login emails. Passwords default to
`ChangeMe_123!` unless you set `SEED_SUPERADMIN_PASSWORD` /
`SEED_PASTOR_PASSWORD` first. **Change these immediately after first
login.**

### 1.2 Admin/desktop app

```bash
cd client-admin
npm install
npm run dev      # http://localhost:5173, proxies /api to the backend
```

### 1.3 Pastor PWA

```bash
cd client-pastor
npm install
npm run dev      # http://localhost:5174, proxies /api to the backend
```

To try it as an actual installed app: `npm run build && npm run preview`,
open the preview URL on a phone (or Chrome DevTools device emulation),
and use "Add to Home Screen" / the browser's install prompt.

### 1.4 First login

1. Open `client-admin` at `http://localhost:5173/login` and sign in with
   the seeded Super Admin credentials.
2. You'll be asked to set up two-factor authentication immediately (see
   §3), required for Admin, Pastor, and Super Admin accounts.
3. From **Settings → Users & roles**, create real receptionist/admin
   accounts and deactivate or repassword the seeded Super Admin.
4. The Reverend Pastor signs in separately at `client-pastor`
   (`http://localhost:5174/login`) with the seeded Pastor credentials.
   This app rejects any non-pastor account, by design.

---

## 2. Roles

| Role | App | Can do |
|---|---|---|
| **Receptionist** | client-admin | Front desk: record attendance + offerings for **today only**, report emergencies, register members at a center, work the **Members** directory (register, correct details, assign groups, deleting a member and deactivating one stay with an administrator, and the page does not offer what the API would refuse), and run the **Groups** section exactly as an admin does (create/rename/deactivate groups, manage members and roles, send a group summary to the pastor). Sees only their own attendance/offering entries. |
| **Admin** | client-admin | Full read access to all records, analytics, top-contributor report, reports, resolving emergencies, user management. The front desk's own screen is not in an administrator's navigation, the front desk runs it (the route still opens for an administrator who has to cover the desk, it is simply not a destination on the bar). Also the church's **payment accounts** and the payments that arrive in them (Admin → **Reconciliation**), a queue that carries payer names and phone numbers, so it is never the front desk's screen. |
| **Super Admin** | client-admin | Everything Admin can, plus full account management: create, edit credentials (name, email, phone, role, password), deactivate and delete. |
| **Reverend Pastor** | client-pastor (PWA) | Read-only view of everything + real-time push notifications + emergency alerts. Cannot sign into client-admin. |

---

## 3. Security features

- Passwords hashed with bcrypt; JWT sessions; rate-limited login.
- **Long sessions that renew themselves.** Sessions last 30 days by default
  (`JWT_EXPIRES_IN`), and a token past half its life is re-issued on the next
  request (`X-Refreshed-Token`), so anyone using the app is never signed out
  mid-work. Tokens also carry a fingerprint of the password they were issued
  against, so changing or resetting a password ends every session that used the
  old one immediately, the device that made the change keeps its own session.
- **Single-step login** (email + password). Accounts can be signed in on
  several devices at once, and lockouts are tracked per app, so locking the
  admin app never locks the Pastor PWA out of the same account.
- **Field-level encryption (AES-256-GCM)** for donor names/phone numbers, and
  for the phone number of a payer on an imported payment.
- **Verified offering receipts.** Every receipt carries its own QR code, which
  resolves to that one receipt and nothing else
  (`GET /verify/receipt/:verificationToken`, the page a member scans). The
  credential is a 192-bit `crypto.randomBytes` token minted with the receipt and
  stored on it, never the offering id or the receipt number, both of which are
  printed, guessable and enumerable. A receipt that was revoked or whose offering
  was voided still resolves, and says so. See §5.5.
- **How each gift was paid.** An offering records its payment method (cash,
  mobile money, bank or cheque) and the reference that came with it (an M-Pesa
  code, a bank slip or cheque number). Both are printed on the receipt and shown
  on the page a member scans, and giving can be totalled by method in the
  reports and in the Pastor app. `NULL` means "not recorded", never "cash".
  See §5.6.
- **Church payment accounts hold no credential that can move money.** Connecting
  a bank or mobile-money account stores exactly one secret, a webhook signing
  key, encrypted with `FIELD_ENCRYPTION_KEY`, never returned by any endpoint,
  and shown once while it is created or rotated (losing it means rotating it, not
  reading it back). No bank password, PIN or card number is a column, is asked
  for, or would be stored if posted. The church's own account number is masked in
  every response, the whole section is admin-only, every change is audited, and a
  payment's payer name and phone number (encrypted at rest, like a member's) are
  visible to administrators only, never on a receipt, a verification page, or in
  the Pastor app. See §5.7.
- **Tamper-evident audit log**: every sensitive action is hash-chained to
  the previous entry; any edit/deletion of a historical row breaks the
  chain. Check the whole chain from the Admin dashboard or
  `GET /api/reports/audit-integrity`, or one day of it with
  `GET /api/reports/audit/verify?date=YYYY-MM-DD` (Receipts → *Daily audit
  chain* in the admin app). That daily check is a separate mechanism from a
  receipt's QR code on purpose: it verifies a day's books, admin-only, while the
  QR verifies one receipt for the member holding it.
- `helmet` security headers, CORS locked to configured origins, HTTPS
  redirect in production.
- Role-based access control enforced **server-side** on every route, each
  app's own role checks are a UX convenience, not the security boundary.
- **Account management cannot destroy either access or history.** A Super Admin
  cannot demote, deactivate or delete their own account, nor the last active
  Super Admin. Deleting an account that recorded attendance, offerings,
  messages, events or emergencies is refused with the reason and the account is
  deactivated instead, because those records must stay attributed to a real user. Only
  accounts that never recorded anything are removed (together with their own
  audit entries, after which the chain is re-linked so it still verifies).
  Passwords set by a Super Admin are never written to the audit log.

**Before going to production:**
- Serve both apps and the API over HTTPS, required for push notifications
  and service workers to work at all (except on `localhost`).
- Keep `.env` secrets in your host's secret manager, not in version control.
- Configure real SMTP (`SMTP_*`) and/or Africa's Talking (`AT_*`) credentials
  so email/SMS notifications actually send.
- Set up automated, encrypted, off-site backups (`npm run backup` produces
  `pg_dump` archives, see §8.2).

---

## 4. Push notifications (Pastor PWA)

The Pastor PWA uses the Web Push API, no Apple/Google developer account
needed, and it works across iOS (16.4+), Android, and desktop browsers.

1. The server needs `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` in `.env`
   (generate with `node -e "console.log(require('web-push').generateVAPIDKeys())"`).
2. The Pastor taps **"Turn on notifications"** on the Home screen (or in
   Settings), this asks browser permission, subscribes the device, and
   registers the subscription with the server.
3. From then on, every new **emergency** triggers a real push notification
   the moment it's reported, even if the app isn't open, via
   `server/utils/notify.js`. Attendance and offering records are deliberately
   **not** pushed one by one: the front desk sends a single batched
   end-of-day summary (with attendee and giver names) from the receptionist
   dashboard, which arrives as a push plus an in-app message.
4. Tapping a push notification opens the app to the relevant screen (e.g.
   an emergency alert opens straight to Alerts).

If VAPID keys aren't configured, emergency push sends are simply logged as
"pending" in `notifications_log` instead of failing silently, nothing is
lost, it's just not delivered as a push until keys are set.

#### Recalling a message sent to the pastor by mistake

Anything that reaches the pastor's feed, a note from the front desk, a group
roster, the end-of-day summary, can be taken back from **Messages → Sent to
the pastor**. The panel lists what has gone out (the front desk sees its own
sends, an admin sees everyone's), each row shows whether the pastor has opened
it, and **Recall** asks once before withdrawing.

What a recall does: the message leaves the pastor's feed, their unread badge and
their notification list, so nobody is left notified about something they cannot
open. What it cannot do: unsend a push that has already reached a phone. The row
itself is never deleted, the sender keeps it, marked *Recalled*, and the audit
log keeps who withdrew it, which is why `db/schema.sql` keeps `recalled_at`
rather than a delete.

---

## 5. How to add things

### 5.1 Add a new language

Both apps use the same pattern independently:
1. Copy `<app>/src/i18n/en.json` to `<app>/src/i18n/<code>.json` and
   translate every value (keep the keys identical).
2. Register it in `<app>/src/i18n/index.js` and add it to
   `SUPPORTED_LANGUAGES` in `<app>/src/i18n/common.js`.

The API has the same shape, in `server/i18n/`:
1. Copy `server/i18n/en.json` to `server/i18n/<code>.json` and translate every
   value (keep the keys identical).
2. Add it to the `catalogs` map in `server/i18n/index.js`. Nothing else changes: no route, middleware or client edit.

Church name/address/currency defaults live in `common.js` (each client) and
`server/utils/brand.js` (the server's own copy, which receipts, event sheets and
notifications all read) and should stay untranslated, a translated proper noun
would make a receipt unrecognizable. Only touch the `.json` files for
user-facing text.

#### Server messages are keys, never prose

A route returns a **message key**, and `server/middleware/locale.js` translates
it on the way out:

```js
res.status(400).json({ error: 'errors.amountRequired' });
res.status(400).json({
  error: 'errors.categoryRequiresGiverFullName',
  params: { category: cat.name },   // fills {category}; stripped from the response
});
```

So when you add a message, add the key to `server/i18n/en.json` **and**
`server/i18n/sw.json`, a test fails if a route uses a key that is missing from
the catalog, or if a handler slips back to raw English prose. Three things are
worth knowing:

- **Which language?** The caller's choice, resolved as `X-Language` (both apps
  send it from `vrt_language`), then `?lang=` for links opened outside the app,
  then the browser's `Accept-Language`, then English. An unknown language falls
  back to English, never to a raw key, and never to a blank message.
- **Only the text fields are touched.** A payload value is translated only when
  it exists in `en.json`; anything else (`blockedBy`, `retryAfter`, an
  interpolated sentence, a message from a library) passes through untouched.
- **`scripts/backup.js` is not localized.** It is operator-facing CLI output for
  `npm run backup`, not an API response.

To add a language for a future language switch in the browser, nothing in the
routes needs to change; to see it end-to-end, add it to
`SUPPORTED_LANGUAGES` in both apps' `common.js` as well.

#### Text the server *generates*

A receipt, an event sheet, a digest body and an SMS never pass through a JSON
response, so `middleware/locale.js` cannot localize them. They are built by a
renderer, which takes the language explicitly:

```js
const { translator } = require('../i18n');
const t = translator(req.locale);          // or a recipient's language_pref
res.type('html').send(renderReceiptHtml(row, req.locale));
```

Which language is not a detail: **it follows the reader.** A document asked for
by the caller uses `req.locale`; anything addressed to a named person uses that
person's saved `users.language_pref`, so a pastor whose app is set to Kiswahili
gets Kiswahili alerts whichever desk triggered them. Where the readers are not
users at all, an SMS blast to members, one message row addressed to a whole
role, the caller's language is the only honest choice.

Three helpers carry the conventions, so a new string needs no new code:

- `translator(locale)` returns a `t(key, params)` that always produces a string
  (unlike `translate`, which returns `null` for anything it does not recognise so
  that it can never mangle a payload). An untranslated key therefore degrades to
  English, and an unknown key shows itself rather than leaving a hole.
- `plural(t, count, oneKey, otherKey, params)`, the catalog carries a `_one` and
  an `_other` variant; there are no plural rules to get wrong.
- `enumLabel(t, prefix, value)`, a stored enum (`choir`, `critical`) is looked up
  as `prefix + value` and printed as a label. **Never print a raw column value**
  in generated text; a test enumerates the enums from the code that validates
  them and fails if one has no label.

`server/test/generated-text-i18n.test.js` pins all of it, including that a
Kiswahili receipt contains no English label and that the PDF takes the same
language as the HTML one.

### 5.2 Add a new offering type

Offering categories are **database rows** (the single source of truth is
`offerings.category_id` → `offering_categories`), not hardcoded enums:

1. **Backend**: insert a row into `offering_categories`
   (`name`, unique `key`, optional `legacy` aliases, `requires_receipt` 0/1,
   `sort_order`). The API exposes them via `GET /api/offerings/categories`;
   the entry form and every report pick new rows up automatically.
2. **client-admin**: add `type_<key>` translations to `src/i18n/en.json` and
   `sw.json`, the receptionist form and reports both key off the category.
3. **client-pastor**: add the same `type_<key>` translation keys to its
   `en.json`/`sw.json` so Records displays it correctly.

To retire a category, set `is_active = 0`, historical rows keep their
meaning and reports stay stable (a management UI for this is a natural
next step).

A category is what a gift is **for**. How it was **paid** is the other closed
vocabulary on an offering, and it is an enum rather than a table, see §5.6.

### 5.3 Add a new user role

1. Add the role to the `CHECK` constraint on `users.role` in
   `server/db/schema.sql` **and** in `server/db/migrate.js`, schema.sql only runs
   on a fresh database, so a running church needs the migrate.js statement.
2. Add `requireRole('yourrole', ...)` to whichever routes it should reach.
3. Decide which app (or a new one) it belongs in, and wire up its
   navigation/home-route mapping there.

### 5.4 Rehearsals vs services (ibada)

Every service type is one of two kinds (`service_types.kind`):

- **`service`**, a church service (ibada). May record attendance and offerings.
- **`rehearsal`**, a practice session (choir, worship team). Records **attendance
  only**, a headcount plus names, where the names may be handwritten for people
  who are not registered yet or picked from the member list, and is **reported
  separately**, so practice numbers never inflate the church's service figures.

The invariant the API enforces in both directions: **money is never filed against
a rehearsal.** Recording an offering at one is refused, and turning a type that
has already collected offerings into a rehearsal is refused too (409) until those
records are dealt with. Attendance aggregates are service-scoped everywhere
(`/reports/summary`, `/reports/breakdown`, `/attendance/trends`, the exports);
offering aggregates are deliberately *not* filtered, so money that was recorded
keeps appearing in reports wherever it was filed.

To mark an existing type as a rehearsal, change its kind in **Settings → Service
types** (or `PATCH /api/service-types/:id {"kind":"rehearsal"}`). New rehearsals
default to headcount + names. Rehearsal attendance is available alongside the
service breakdown (`breakdown.rehearsals`), on its own via
`GET /api/reports/breakdown?groupBy=rehearsal`, and as its own CSV export
(`GET /api/reports/attendance.csv?kind=rehearsal`).

### 5.5 Receipt verification (the QR code on every receipt)

An offering receipt is the one record that leaves the building, so each one is
verifiable on its own:

- `offerings.verification_token` (UNIQUE) is the credential the QR encodes, and
  `offerings.verification_status` is its state. Both are added to
  `db/schema.sql` **and** `db/migrate.js` (see 5.3), the columns reach a running
  church on the next boot, and every receipt that predates them is given a token
  there too.
- The token is minted in the same transaction as the receipt number
  (`routes/offerings.js`), so a receipt cannot exist without one. It is **not**
  derived from the id or the receipt number: an id is printed in reports and
  counts up from one, which would let anyone walk the church's giving history
  from outside.
- `utils/verificationToken.js` mints and shapes the credential and builds the
  public URL from `RECEIPT_VERIFY_BASE_URL`; `utils/qr.js` renders the code
  (inline SVG for HTML, PNG for the PDF); `utils/receiptVerification.js` resolves
  a token and renders the public page; `utils/receipt.js` puts the block on the
  receipt itself.
- `routes/verification.js` serves both public faces, the page at
  `/verify/receipt/:token` and the JSON at `/api/verify/receipt/:token`. Neither
  is authenticated (the scanner has no account) and neither exposes donor
  details, the recording staff member or the internal row id.
- **One receipt, one identity.** A correction that reuses the receipt number
  (`POST /api/offerings/:id/adjust`) carries the token across with it, so the
  paper already in a member's hands keeps working; reprinting
  (`POST /api/offerings/:id/verification/regenerate`) returns the SAME token and
  only mints one for a receipt that never had it.
- Admins manage it from **Receipts** in the admin app: status, the receipt's own
  audit history (`GET /api/offerings/:id/audit`), revoke/restore
  (`PATCH /api/offerings/:id/verification/revoke|restore`) and the separate daily
  audit-chain check (`GET /api/reports/audit/verify`).

Do **not** point a receipt's QR at the audit chain. They answer different
questions, and only one of them belongs to a member.

### 5.6 Payment methods and how a gift was paid

Every offering can say how the money arrived, in a closed four-value vocabulary
(`offerings.payment_method`): `cash`, `mobile_money`, `bank`, `cheque`. Beside
it, `offerings.payment_reference` holds the number that came with the payment:
an M-Pesa confirmation, a bank slip number, a cheque number.

- The vocabulary is an enum, not free text, for the same reason a service type's
  `kind` is: every method is **labelled** in both languages, on a receipt a
  member reads and in the reports a treasurer runs, and free text ("mpesa",
  "M-PESA", "simu") would translate to nothing and split one method across three
  report lines. `utils/payments.js` normalizes and validates it, the labels are
  `payment.method_*` in `server/i18n/*.json` and are printed through
  `enumLabel`, never as the stored key. The enum sweep in
  `test/generated-text-i18n.test.js` fails if a value has no label.
- **`NULL` means "not recorded", never "cash".** Every offering recorded before
  this existed has no method on file, and defaulting those rows would invent
  money-handling data the church never entered. The reports show that state as
  its own line ("Not recorded") instead of folding it into cash.
- Nothing already present was duplicated: there is no payments table and no
  payment id. The offering **is** the transaction, its `receipt_number` is the
  receipt identity and the reference the audit entries quote; the payment
  reference is a different fact (how the money moved), not a second identifier
  for the gift.
- The front desk picks the method on the offering form, and nothing is
  pre-selected: the method is printed on the receipt a donor takes home, so it is
  one explicit tap rather than a guess the church later reports on. The reference
  field appears only for the methods that have one, and it is cleared after each
  record so one confirmation code never lands on two gifts. The API enforces the
  same rules: a method it cannot label is refused, and so is a reference with no
  method to place it (and anything past 64 characters).
- The receipt (HTML and PDF) and the public verification page print both lines,
  translated, and print neither when nothing was recorded. A correction
  (`POST /api/offerings/:id/adjust`) carries both across, the money did not
  change hands a second time, and may restate a method that was typed wrong.
- Reporting: `GET /api/reports/breakdown?groupBy=payment` totals giving by method
  (Admin → **Reports → By payment method**, drillable into the records), the
  offerings list takes `?paymentMethod=` for that drill-down, and
  `offerings.csv` carries both columns as stored keys, a spreadsheet has no
  interface language.
- The Pastor PWA answers the same question for whatever period is on screen
  (**Records → "How giving came in"**, in the day report and for a selected
  range alike). It totals the rows that screen already loaded, so its figures
  cannot contradict the totals beside them, and it is deliberately
  **aggregate-only**: no payment reference and no giver, how the money arrived
  is a total, not a ledger of people. `client-pastor/src/paymentMethods.js` keeps
  the vocabulary's fixed order, so a month reads against a month instead of
  re-sorting itself by amount, and a gift whose method nobody recorded is listed
  as "Not recorded", never as cash.

`server/test/payment-methods.test.js` pins all of it, including that the label
on a Kiswahili receipt is translated and that a corrected entry keeps the payment
facts. The Pastor PWA's split is pinned by
`client-pastor/src/paymentMethods.test.js`,
`client-pastor/src/components/GivingByPayment.test.jsx` and
`client-pastor/src/pages/Records.test.jsx`, the last of which also asserts that
no payment reference reaches the screen.

### 5.7 Church payment accounts and reconciling incoming payments

Money that reaches the church's own bank or mobile-money account is not giving
until somebody says whose it is and what it was given for. This is that
workflow, and it is the only place in the system where money arrives from
outside the building:

```
church account → incoming payments → automatic matching → matched / unmatched
→ admin review → confirmed giving record → receipt + reports
```

**There is no fake bank connection.** Nothing here pretends to hold a bank login
or open a socket into a provider nobody has integrated. `utils/paymentProviders.js`
is a registry of the two integration shapes a church can genuinely run today
against the providers it already has:

- **`statement_import`**, the church exports the statement its bank or provider
  portal already offers (CSV, comma- or tab-separated) and uploads it, in the
  browser, into **Reconciliation → Import a statement**. The rows are real, and
  there is no credential to leak at all.
- **`webhook`**, the provider POSTs its transaction notifications to
  `POST /api/payment-webhooks/:accountId`, signed with that account's secret
  (HMAC-SHA256 of the raw body in `X-VRT-Signature`, verified timing-safe). The
  URL is shown on the account row once it exists.

A provider with a documented API (open-banking endpoints, a specific gateway) is
added by writing **one adapter** with the same three parts, `capabilities`,
`credentialFields`, and a normalizer returning the canonical transaction
(`{ provider_transaction_id?, provider_reference?, amount, currency?,
occurred_at, payer_name?, payer_phone?, payer_account_ref?, description?,
status? }`), and registering it in `PROVIDERS`. Accounts, deduplication,
matching, confirmation, receipts, reports and the admin screen all speak only
that canonical shape, so none of them change when a real provider is plugged in.

- **Idempotency is a database guarantee, not a convention.**
  `payment_transactions` is UNIQUE on `(account_id, provider_transaction_id)`, so
  re-uploading an overlapping statement (or a provider re-delivering an event)
  inserts nothing and answers with the counts. When a provider sends no id,
  `utils/paymentIntake.js` derives one from the fields it did send; where even
  that is impossible (two identical credits with no reference at all) the second
  row is inserted but flagged `possible_duplicate_of`, a genuine second gift of
  the same amount must not be silently swallowed.
- **A payer is not assumed to be the giver.** Matching fills `matched_member_id`
  only for the strongest signals: the church's own member number, or a phone
  number that matches exactly one member. A name that matches exactly one member
  produces `review` with a *suggestion* a human confirms; a name two members
  share produces `review` with no suggestion at all. `utils/identityMatch.js`
  compares whole names, order-insensitively, and never substrings.
- **The giving code is what makes an automatic match safe.** A member's number
  (`VRT-0042`) is not internal bookkeeping: it is the code they quote when they
  pay, and it is read out of the reference, the description or the payer's account
  field *however it was written*: `vrt 9`, `VRT0042`,
  `ZAKA/VRT-0009/2026-06` all resolve, because both sides are put into canonical
  form first (a row stored as `vrt-9` matches too). A payment quoting a member's
  code is matched outright rather than queued for review, **unless the statement
  names somebody else**. A code is four digits: a payer meaning to write their own
  `VRT-0020` and writing `VRT-0010` has quoted a colleague's code, and from this
  side that is indistinguishable from a correct one, so the code's owner is
  proposed and a person decides (`payment_transactions.match_note =
  'code_vs_payer_name'`, rendered in the reader's language on the row and in the
  review panel). A payer nobody on the roll is *not* a contradiction. That is the
  ordinary relative-or-employer case, and the code still says whose gift it is.
  The note is cleared the moment a person decides. A **bare number is never
  read as a code**, a statement is full of amounts, dates and slip numbers, and
  treating one of them as an identity would book a stranger's money to a member.
  `utils/memberNumbers.js` is the one allocator, so the number the member form
  hands out is one the matcher recognises; `db/migrate.js` gives a code to any
  member who has none on the next boot (the column has always allowed NULL) and
  leaves a member who has one alone, because a code already written on a giving
  envelope must keep working. The receipt prints it beside the giver with the line
  that makes it useful, *"Quote this code when you pay by bank or mobile money…"*
  in both languages, on the HTML and the PDF, and only for a gift that has a
  member behind it (a hand-signed cash gift has nobody to give a code to). The
  public verification page prints no code at all: the person scanning a receipt is
  holding the paper, not the member's record.
  `server/test/giving-codes.test.js` pins every one of those rules, including that
  a payment matching only on a name is a suggestion and never an attribution, and
  that a code the payer's name disputes reaches a human rather than the ledger.
  Both note keys are also the reason `POST /:id/unmatch` re-derives the rules
  (`reprocess` in `utils/paymentIntake.js`): the matcher leaves a hand-made match
  alone on every later sync, and the one thing that may reverse it is another
  person asking, pinning that is how a disputed payment gets back to the queue.
- **Nothing becomes giving without a person.** Importing and matching only fill
  suggestions; `POST /api/payment-transactions/:id/confirm` is the single act
  that writes an offering, through the same writer the front desk uses
  (`utils/offeringRecord.js`), so the receipt, QR token, payment method and
  reference are the same ones. `offerings.payment_transaction_id` is UNIQUE, so
  confirming twice answers with the receipt that already exists instead of
  issuing a second one, even under a double-click or two admins racing. A payment
  the provider reports as **failed or reversed** is refused outright; a **pending**
  one may be recorded (a church can hold money the provider has not settled) but
  the audit entry says it was still pending.
- **The provider's verdict and the church's are two different columns**: `status`
  (`pending | successful | reversed | failed`) and `match_status`
  (`unmatched | review | matched | confirmed | ignored`). A payment can be
  matched and still have been reversed, so the screen shows both.
- **Reports re-use the one transaction model.** `GET /api/reports/breakdown`
  gains `groupBy=account` and `groupBy=reconciliation` (both admin-only, 403 for
  anyone else), the offerings list takes `?accountId=` to drill into one account,
  and `offerings.csv` carries `account`, `provider_reference` and
  `reconciliation_status` beside the columns it already had. Cash counted at the
  desk has no account and never appears in those breakdowns: it is its own
  method, not a row pretending to have arrived at a bank. The Pastor PWA's giving
  split reads the same offerings, so it needs no change at all.
- **`utils/paymentAccounts.js` refuses to store what it did not ask for**: only
  the fields the provider declares are kept, so a client cannot smuggle a
  `password` key into the column; an empty value clears a field; and credentials
  are re-encrypted in place on rotation. There is no endpoint that will show a
  stored secret again.
- The admin screen is **Admin → Reconciliation**: what each account is waiting on,
  the statement upload (with the lines it could not use, and why, reported back
  in the reader's language), the payments waiting, a per-payment review panel
  (match to a member, take the match back, set aside with a reason, bring the row
  back), and confirmation that records the offering type, service and date and
  issues the receipt. **Receipts** and **Reports** then show the result like any
  other gift, and **Receipts → Daily audit chain** stays the separate daily check
  it always was.

`server/test/payment-providers.test.js` pins the parsers (statement columns by
alias, day-first Tanzanian dates, debits and unreadable rows reported rather than
counted, provider statuses), `server/test/payment-reconciliation.test.js` pins
the workflow end to end (idempotent re-sync, the matching rules, match/unmatch,
confirmation writing one offering and one receipt, refusal to record a reversed
payment, the account endpoints and the webhook signature), and
`server/test/demo-giving.test.js` pins the demo data below.

### 5.8 Add a new emergency severity or field

Edit the `CHECK` constraint on `emergencies.severity` in `server/db/schema.sql`
**and** in `server/db/migrate.js` (see 5.3), then the
`SEVERITIES` array in `server/routes/emergencies.js`, and add the
matching `severity_<level>` translation key and style in both
`client-admin/src/pages/Emergencies.jsx` and
`client-pastor/src/pages/Emergencies.jsx`.

### 5.9 Micro-interactions (the motion system)

Both clients ship **one** animation library, `motion`, used for feedback and
nothing else: a confirmation the eye has to catch, a drawer whose direction says
where it came from, a row that was just created. It is the same code in each app:
  `src/motion.js` (durations, presets, the settled-state guarantee) and
`src/motionUi.jsx` (`MotionRoot`, `ExpandingPanel`), mounted once in `main.jsx`.

**The rules, in one place.** Anything that animates here has to obey all of them:

- **150–300ms, always.** Every duration lives in `DURATION` (`src/motion.js`) and
  `src/motion.test.jsx` fails the build if one leaves that band. This is a
  workflow tool: a receptionist must never wait for a transition to finish a
  click.
- **No page transitions and no scroll-linked motion.** Routes change instantly;
  nothing in either app animates on scroll. These are data-entry screens, not a
  landing page.
- **One animator per element.** The charts (Recharts) keep their own load
  animation and are never also driven from Motion, two systems writing the same
  transform is how a bar ends up fighting itself. `DURATION.chart` exists so the
  timing still comes from the one scale.
- **The pastor's home screen stays calm.** Only its notice and its chart animate.
- **`prefers-reduced-motion` is honoured three ways**: MotionConfig
  `reducedMotion="user"` for the animations Motion itself drives, the global
  `@media (prefers-reduced-motion: reduce)` rule in `index.css` for CSS
  transitions, and components that simply skip the animation (the new-row tint is
  not applied at all).

**Why `motion-settled` exists.** Motion animates by writing inline styles, so a
renderer that never advances its timeline, a throttled background webview, a
machine loading all cores, would leave an element parked where the animation
STARTED: a drawer off-screen, a banner invisible, a panel at zero height. So
every animated element also takes the `motion-settled` class once the animation
would be over (`useSettled`); that rule uses `!important` to assert the resting
state over whatever inline style is there. Where something rests never depends on
a frame having been painted, and `src/motion.test.jsx` pins both halves of that.

**Adding an animation.** Import `m`, never `motion`, so the lazy feature set
still covers it (`LazyMotion` with `domAnimation`, `strict`), add the duration to
`DURATION`, and give `useSettled` an identity that is fresh for each appearance
(the open token of a drawer, the text of a notice). `server`-side nothing is
involved: no animation may gate data entry.

**Those rules are enforced, not just written down.** Each client's
`.oxlintrc.json` restricts imports: the eager `motion` component, the `motion`
package root and everything under `framer-motion` are errors, so `npm run lint`
  which CI runs on both clients, fails on the one import that would quietly
pull the whole feature set back in. `src/motion.test.jsx` pins the same thing
from the other side: it scans every source file for such an import, fails if a
second animation library appears in `package.json`, and fails if the lint rule
itself is deleted. Each of the three was verified to fail when broken, not just
to pass when correct.

### 5.10 Add a destination to the navigation

`client-admin/src/nav.js` is the only place the navigation is described, and it
describes it as **clusters**, not as one row of equal choices, fourteen tabs
competing for the same attention is what that file exists to prevent. A screen
therefore does not just join a list; it names the cluster it belongs to:

- **`primary`**, in the bar and at the top of the drawer. The screens a role is
  in all day. Adding one here is a deliberate act: keep the bar under about eight
  top-level items, because past that nothing is scanned, everything is searched.
- **`manage`**, the “Manage” dropdown: structural and configuration screens.
- **`finance`**, the “Finance” dropdown: money oversight and record-pulling.
- **`settings`**, its own item, pinned to the far right of the bar and to the
  bottom of the drawer, apart from the functional groups.

`NAV_GROUPS` decides how each cluster is shown (inline link, dropdown, pinned),
and both presentations render through `groupedNav()`, so the bar and the drawer
cannot arrange the same role two different ways. Order within a cluster is the
order of the role's list, which is where the reasoning about sequence lives.

Which roles a destination is for is decided in two places that have to agree:
the role's list here, and the `ProtectedRoute` in `App.jsx`. A screen the API
lets the front desk use (Members: it registers people there) needs both, the
list entry to reach it and the route guard to stop the page redirecting. A
screen the front desk does not use needs neither in its list, which is why Front
Desk appears only under `receptionist`.

A cluster trigger opens on hover for a pointing device, and a click owns it: a
menu the pointer merely passed over goes when the pointer does (the bar is on the
way to Settings and the language switcher), while a clicked one stays until
Escape, a click outside, or a navigation closes it. Touch is ignored by the hover
path, because a tap that opened a menu would be the same tap that closed it.

**The bar is one tab stop, not eight.** Exactly one top-level item carries
`tabIndex="0"`, the last one that had focus, and Left/Right walk the rest, with
Home/End for its ends. Focus moving along the bar also closes the cluster it
walks away from, and focus leaving a menu by any other route (Tab, a click into
the page) closes it too. Focus inside a menu belongs to its trigger as far as the
bar is concerned, so Right walks out of a cluster to the next destination.

Which menu is open is the BAR's state, not each menu's, for two reasons: one slot
means one menu at a time for free, and it lets the bar close what its own arrows
move away from without depending on a focus event arriving, "focus left the
menu" is exactly the sort of thing a renderer or an embedded webview can decline
to report, and a rule that lives in a focus event is a rule you cannot test.

**A panel never hangs off the edge of the screen.** A dropdown sits under its
trigger, and while it is open it is measured against the viewport on every
render: if its right edge would pass the viewport's margin it is slid back by
exactly the overflow, landing on the margin instead of past it, and never
further left than the margin on the other side. The shift is derived (the
trigger's position, the panel's own width, the viewport) and never accumulated,
so re-measuring cannot feed back into the next measurement. Three things change
the room a panel has without re-rendering: a resize, a browser zoom, and a late
web font re-laying the labels out; the first two are watched directly, the third
through `document.fonts.ready`. And since a panel's width is its labels' width,
it is capped at `100vw - 1rem`: Kiswahili, whose words are longer, truncates its
labels rather than running off the page.

Inside a cluster, the keyboard has its own way through: Enter or Space opens it,
and so
do ArrowDown and ArrowUp, landing on the first or last item respectively, which
is the menu-button convention. The arrows then move through the items and wrap at
the ends, Home and End jump to them, and Escape closes the menu and hands focus
back to the trigger. Tab still walks the links in order, because these are links,
not actions. Every key the menu acts on is `preventDefault`-ed: an arrow must
move focus, never scroll the page out from under the menu it just moved in.

Active marking needs no second list of paths: `activeNavItem()` picks the
longest `to` the address sits under, so a detail route like `/groups/12` keeps
its section lit. A dropdown trigger carries `aria-current="true"` while one of
its pages is open, which is what tells a user “you are somewhere inside
Finance” once the menu is shut.

**What it costs.** Measured with the project's own bundler, the animation set
both apps render (the `m` component, `LazyMotion` + `domAnimation`,
`AnimatePresence`, `MotionConfig`, `useReducedMotion`) adds **~80 kB minified,
~28 kB gzipped** over the same tree without it, and using `domMax` instead would
add ~13 kB gzipped more, which is the layout-projection and drag code neither app
wants. The full admin bundle is 1.15 MB minified (327 kB gzipped).

---

## 6. Project layout reference

```
server/
├── db/
│   ├── schema.sql      Postgres schema, applied by `npm run seed`, but ONLY on a
│   │                    fresh database, so it is not where an existing church
│   │                    database gets a new column (see db/migrate.js)
│   ├── migrate.js      Schema + one-off data migrations, run on every boot (idempotent)
│   ├── pg.js           Postgres connection pool shared by every route
│   ├── testSafety.js     Keeps test runs off a real database (see 8.1)
│   ├── seed.pg.js       Bootstraps Super Admin, Pastor, service types, groups
│   └── canonicalize.js   Keeps offerings.type in step with offering_categories
├── middleware/auth.js    JWT auth, requireRole(), "today only" restriction
├── routes/
│   ├── auth.js            Login, session renewal, password change
│   ├── users.js            User CRUD (Super Admin): create, edit credentials,
│   │                       deactivate, delete
│   ├── services.js         Service session CRUD
│   ├── attendance.js        Attendance recording + trends
│   ├── verification.js      Public receipt verification (QR page + JSON)
│   ├── offerings.js         Offering recording, summaries, top contributors,
│   │                       receipt verification management
│   ├── paymentAccounts.js    The church's connected accounts (see 5.7)
│   ├── paymentTransactions.js  Reconciling an incoming payment into giving
│   ├── paymentWebhooks.js    The provider's signed notification endpoint
│   ├── emergencies.js       Emergency reporting + resolution
│   ├── notifications.js     Pastor's in-app notification feed
│   ├── push.js              Web Push subscribe/unsubscribe, VAPID key
│   └── reports.js           CSV export, audit-integrity check
├── scripts/
│   ├── backup.js         pg_dump snapshot + retention (see 8.2)
│   ├── sample-giving.js  Demo giving history: seed and purge (see 8.4)
│   └── purge-verification-data.js  Removes a QA walkthrough's rows (see 8.3)
├── test/
│   ├── helpers.js        One throwaway Postgres database per suite
│   ├── test-safety.test.js  Tests for the test-database guard
│   └── *.test.js         Regression suites (see 8.1)
└── utils/
    ├── crypto.js       AES-256-GCM field encryption
    ├── audit.js         Tamper-evident hash-chained audit logging
    ├── token.js         Session lifetime, renewal, credential revocation
    ├── userGuards.js   Who may be demoted/deactivated/deleted (see 3)
    ├── qr.js            QR rendering (inline SVG, PNG for the PDF)
    ├── verificationToken.js  The receipt QR's credential and public URL (see 5.5)
    ├── receiptVerification.js  Token lookup + the public verification page
    ├── payments.js      How a gift was paid: the enum and its normalizers (see 5.6)
    ├── memberNumbers.js  The member's giving code: one allocator for every writer
    ├── paymentProviders.js  Statement/webhook adapters + canonical transaction (see 5.7)
    ├── paymentAccounts.js   Account credentials: encryption, masking, signatures
    ├── paymentIntake.js     Idempotent ingest + the member-matching rules
    ├── statementCsv.js      Reads a bank/provider CSV or TSV export
    ├── identityMatch.js     Phone/name/giving-code comparison, shared with members
    ├── offeringRecord.js    The one writer that turns an amount into an offering
    └── notify.js         Email/SMS/in-app/push pastor notifications

client-admin/src/
├── i18n/                en.json, sw.json, common.js
├── paymentMethods.js   Payment-method labels shared by the desk, Receipts,
│                        Reports and Reconciliation (see 5.6)
├── pages/                Login, ReceptionistDashboard, AdminDashboard,
│                         Reconciliation, Receipts, Emergencies, Reports, Settings
└── components/           AppShell, StatCard, StatusBanner, etc.

client-pastor/src/
├── i18n/                 en.json, sw.json, common.js
├── pages/                 Login, Home, Records, Emergencies, Settings
├── components/            AppShell (bottom tab nav), StatusBanner, etc.
├── push.js                 Web Push subscribe/unsubscribe helpers
└── sw.js                   Custom service worker (push + offline cache)
```

---

## 7. Deploying

Any host with HTTPS support works (Render, Railway, DigitalOcean, Fly.io):

1. Deploy `server/` as a Node web service; set all `.env` variables as
   host secrets, including `DATABASE_URL` pointing at your managed
   Postgres, then run `npm run seed` once to create the schema and
   bootstrap accounts.
2. Deploy `client-admin/` as a static build (`npm run build` → `dist/`).
   Set `VITE_API_URL` before building to your deployed API's base URL.
3. Deploy `client-pastor/` the same way, as its own static site on its own
   URL (e.g. `pastor.yourchurch.org`). It must be served over HTTPS for
   push notifications and PWA install to work.
4. Set `CLIENT_URL` in the server's `.env`. If both apps need CORS access,
   adjust the CORS config in `server/index.js` to allow both origins.
5. Behind a reverse proxy (Nginx, Render, Railway), set `TRUST_PROXY=1` in
   the server's `.env` so rate limiting and audit logs see real client IPs.

---

## 8. Operations

### 8.1 Tests

The server has a zero-dependency regression suite (Node's built-in test
runner) covering notification integrity, security enforcement, and the
data model:

```bash
cd server && npm test
```

Each suite creates its own throwaway Postgres database, seeds it with the
real seeder, boots the API against it, drives it over HTTP, and asserts
against raw SQL, run it before every deploy (it needs the database from
`docker compose up -d` to be running).

The suite can never write to your development database. Each suite runs with
`NODE_ENV=test` against a throwaway database whose name carries a `_test` marker
(`vrt_cms_test_phase2_digest`), and `db/pg.js`, the pool every query goes
through, refuses to connect when a test process is aimed at anything that does
not match that marker (`db/testSafety.js`, covered by `test/test-safety.test.js`).
Creating and dropping those databases targets the `postgres` maintenance
database, so a test run never even opens a session on the app's own database. A
stray `DATABASE_URL` therefore fails loudly before the first query instead of
seeding over real data.

Two features that leave the building have contract suites of their own:
`test/receipt-verification.test.js` (a receipt's QR verifies that receipt, and
never the day's audit chain) and `test/payment-methods.test.js` (how a gift was
paid, from the front desk to the receipt, the verification page and the reports).
The payment-account work has three more: `test/payment-providers.test.js` (the
statement and webhook parsers), `test/payment-reconciliation.test.js` (the whole
workflow, including that a re-sync inserts nothing and that confirming a payment
twice yields one receipt) and `test/demo-giving.test.js` (the sample data and its
purge, see §8.4). The giving code has its own too,
`test/giving-codes.test.js`, because it is the single signal the system trusts
enough to attribute money on its own (§5.7).

The front desk's reach into `server/routes/groups.js` is a decision, not an
accident, so it has its own contract: `test/groups-access.test.js` proves a
receptionist can create, rename, deactivate and re-staff a group, and that the
roles which should not (a pastor's read-only feed) still get a 403.

CI (`.github/workflows/ci.yml`) runs the suite on Node 20/22 plus lint, both
clients' component tests, and builds for both clients on every push/PR.

Both clients have their own component suite (Vitest + Testing Library on
jsdom). Where the server suite proves the API's rules, these prove the UI's.
They exist because some of those rules can only break in the browser:

```bash
cd client-admin && npm test        # npm run test:watch while iterating
cd client-pastor && npm test
```

The admin suite locks in the interaction rules that are easy to regress: on
**Service Types** and **Groups** a collapsed row exposes only labelled actions
and no fields, only one row can be edited at a time (other rows refuse to open
while a draft is unsaved), and Save stays disabled and neutral until a field
genuinely differs, including going back to disabled when an edit is undone.
For Groups in particular it also pins the model that a whole edit, name,
type, description, active flag **and the membership diff**, is committed by
that one Save, so Cancel discards membership changes too. It also covers the
responsive **navigation** (receptionist destinations, the drawer, active
marking, the clustered bar: the primary links, what each of Manage and Finance
holds, that the parent stays marked on a child page and through a detail route,
and that the drawer shows the same clusters as labeled sections) and that pages
follow the app's language setting instead of hardcoding English. The pastor suite covers the PWA's shared navigation: the same six
destinations, in one order, with the same badges, in both the phone bottom bar
and the desktop tab bar.

Both suites need Node 22.12+ (Vitest 5's own requirement), which is what CI's
clients job runs.

### 8.2 Backups

The database is the church's financial memory, back it up daily:

```bash
cd server && npm run backup
```

This runs `pg_dump --format=custom`, a consistent online snapshot, safe
while the API is serving, into `server/db/backups/`, checks the archive is
really a Postgres dump, and keeps the last 14 files (`BACKUP_KEEP` to
change, `BACKUP_DIR`/`BACKUP_CONTAINER` to redirect). If `pg_dump` is not
installed on the host it falls back to running it inside the Postgres
container. Schedule it with cron/Task Scheduler, e.g. daily at 23:30:

```
30 23 * * * cd /path/to/server && npm run backup >> backup.log 2>&1
```

Copy backups off-machine (cloud storage, another disk), a backup on the
same disk as the database is not a backup. To restore, stop the API and
then:

```bash
cd server && pg_restore --clean --if-exists -d "$DATABASE_URL" db/backups/vrt_cms-<stamp>.dump
```

### 8.3 Purging verification / test residue

An end-to-end walkthrough (`Verify Group 1789252617569`, `Verify Receptionist`,
… ) writes real rows into whatever database it is pointed at. Point one at a
development database and the residue is indistinguishable from real data in the
UI. `npm run purge:verify` removes it:

```bash
cd server && npm run purge:verify              # dry run: prints the plan, commits nothing
cd server && npm run purge:verify -- --apply   # commit
```

It brackets the exercise in time, the span between its first `Verify …` marker
row and the last audit entry attributed to a verify account, then deletes
everything written inside that window, children before parents, and re-links the
audit hash chain afterwards so `GET /api/reports/audit/verify` still passes. It
refuses to run under `NODE_ENV=production`, and refuses to guess if it finds no
markers. **Run `npm run backup` first**, and read the dry-run output: anything
your team wrote while the exercise was running falls inside the window too.

### 8.4 Demo giving data (seed and purge)

A development database with three gifts in it makes every report look broken, a
method breakdown with one method, a trend line with one point, a reconciliation
queue with nothing in it, and those are exactly the failures worth seeing. So
`server/scripts/sample-giving.js` writes a plausible few months of a real
church's giving, and can take it all back out again:

```bash
cd server && npm run seed:giving               # write the sample data
cd server && npm run purge:giving              # dry run: prints what would be removed
cd server && npm run purge:giving -- --apply   # remove it (--force is the same)
```

What it writes, three complete months plus the month in progress, so daily,
weekly, monthly and month-to-date reports all have something to show:

- **Tithes that repeat** weekly from the same families (so a member's giving
  history has a shape), loose cash in the general offering that nobody signs for,
  a **monthly bank transfer** from a member on a standing order, **quarterly
  cheques** from a member and from a company, and a **building-fund campaign**.
- **Two church accounts with a real feed**: the bank rows are generated as a
  STATEMENT EXPORT and read by the same parser an uploaded file goes through; the
  mobile-money rows are generated as PROVIDER NOTIFICATIONS and read by the same
  webhook normalizer. Both then go through the same idempotent intake, the same
  matching rules and the same offering writer as a real import, so receipts, QR
  verification tokens, payment references and audit entries on the demo gifts are
the genuine articles, not fixtures that resemble them.
- Some payments are **confirmed** (they became offerings), some are left
  **awaiting review** with a suggested member, some are **unmatched** with no
  suggestion at all, one is **flagged as a possible duplicate**, and the provider
  reports a **pending**, a **reversed** and a **failed** payment, so the
  reconciliation screen has work to do and the refusals can be seen refusing.
- Amounts are plausible TZS figures (whole thousands), spread across all four
  methods and every offering type, with M-Pesa-style codes and bank slip numbers
  as references.

It is **deterministic**: seeded randomness means the same calendar and the same
amounts on every run, so a figure in a bug report still matches afterwards, and
it prints what it wrote plus what to look at (**Reports → breakdown by payment
method, account and reconciliation**, a sample receipt, the Pastor PWA's
*How giving came in*). It refuses to run at all under `NODE_ENV=production`.

The purge is exact because the data is **structurally identifiable**, never found
by date or by guesswork: the sample accounts carry `source = 'demo'`, every sample
service type has a `demo_` key, the members it had to create carry a marker in
`notes`, and its audit entries are flagged in `details`. So no real record can
ever be a candidate, including gifts recorded while the demo data was on screen.
It prints the plan and changes nothing unless `--apply` is passed. It removes
children before parents and keeps a sample member that real records now refer to
(rather than failing the whole purge), and it re-links the audit hash chain
afterwards so `GET /api/reports/audit/verify` still passes. It is safe to run
repeatedly: a second run reports *"Nothing to purge"*, and after an apply it
re-checks the markers and says whether the database is clean.
