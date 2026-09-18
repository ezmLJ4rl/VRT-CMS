'use strict';
/**
 * Turning a provider's payment notification into a row, and deciding, carefully
 * whether it belongs to a church member.
 *
 * THREE THINGS THIS MODULE REFUSES TO DO
 * -------------------------------------
 * 1. Assume the payer is the giver. A bank statement line names whoever sent the
 *    money, which may be a relative, an employer settling a pledge, or somebody
 *    paying on a member's behalf. So the matching below classifies, and only the
 *    strongest signals (the church's own member number, or a phone number that
 *    matches exactly one member) are allowed to fill `matched_member_id`. A name
 *    that matches exactly one member produces 'review', a SUGGESTION a human
 *    confirms, and a name shared by two members produces 'review' with no
 *    suggestion at all. "Do not automatically assign ambiguous payments based on
 *    a similar name" is implemented literally: `sameName` compares whole names
 *    order-insensitively and never substrings (utils/identityMatch.js).
 *
 *    AND EVEN THE MEMBER NUMBER IS CHECKED AGAINST THE NAME. A code is four
 *    digits: a payer who means to write their own `VRT-0010` and writes
 *    `VRT-0020` has quoted a code that belongs to somebody else, and from this
 *    side that is indistinguishable from a correct one. So when the statement
 *    carries a payer name that is a DIFFERENT member's, the code's owner becomes
 *    the suggestion and a human decides (`match_note = 'code_vs_payer_name'`). A
 *    name belonging to nobody does NOT contradict anything, that is the ordinary
 *    case of a relative or an employer paying on a member's behalf, and the code
 *    still says whose gift it is.
 *
 * 2. Record money that arrived twice. Idempotency is enforced twice over: the
 *    provider's own transaction id is unique per account
 *    (`ux_payment_transactions_provider`, a database constraint rather than a
 *    check-then-insert race), and because some providers send no id, a
 *    deterministic id is derived from the fields that WERE sent. Where even that
 *    is impossible (two identical cash-like credits with no reference at all),
 *    the second row is inserted but flagged in `import_note` as a possible
 *    duplicate, because a genuine second gift of the same amount on the same day
 *    must not be silently swallowed.
 *
 * 3. Count a payment as giving before a person confirms it. Ingest, matching and
 *    confirmation are three separate states (payment_transactions.match_status),
 *    and only confirmation writes an offering: with the same receipt, QR code
 *    and audit trail the front desk produces (see routes/paymentTransactions.js).
 */

const crypto = require('crypto');
const { encryptField, decryptField } = require('./crypto');
const { TRANSACTION_STATUSES, parseStatementDate } = require('./paymentProviders');
const { samePhone, sameName, canonicalMemberNo, findMemberNumber } = require('./identityMatch');

/** The states a transaction's reconciliation may be in, in workflow order. */
const MATCH_STATUSES = ['unmatched', 'review', 'matched', 'confirmed', 'ignored'];

/** Where an intake row came from. 'demo' is written by scripts/sample-giving.js. */
const INTAKE_SOURCES = ['statement', 'webhook', 'demo'];

const REJECT = {
  noDate: 'payment.reject_noDate',
  noAmount: 'payment.reject_noAmount',
  noAccount: 'payment.reject_noAccount',
};

/** Timestamps are stored the way every other timestamp in this schema is. */
function stamp(value) {
  const parsed = parseStatementDate(value, '');
  if (parsed) return parsed;
  const date = new Date(String(value || ''));
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * The dedup key for a provider that sends no transaction id.
 *
 * Built from what identifies THE PAYMENT rather than the payer: its date, amount
 * and reference. Two identical gifts genuinely exist (two members handing in the
 * same amount on the same Sunday) which is exactly why the reference is part of
 * the key: a payment with a provider reference is identified by it, and why a
 * row with no reference at all falls back to naming the payer too, with the
 * possible-duplicate flag below as the safety net for the rest.
 */
function deriveProviderTransactionId({ occurredAt, amount, currency, reference, payerName, payerPhone }) {
  const parts = reference
    ? [occurredAt, Number(amount).toFixed(2), currency, String(reference)]
    : [occurredAt, Number(amount).toFixed(2), currency, String(payerName || ''), String(payerPhone || '')];
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
  return `derived-${digest}`;
}

/**
 * One provider row as a storable transaction, or a reason it cannot be stored.
 * The transaction shape is the canonical one from utils/paymentProviders.js.
 */
function normalizeTransaction(raw, { account } = {}) {
  if (!account) return { reason: REJECT.noAccount };
  const amount = Number(raw?.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { reason: REJECT.noAmount };
  const occurredAt = stamp(raw?.occurred_at);
  if (!occurredAt) return { reason: REJECT.noDate };

  const currency = String(raw?.currency || account.currency || 'TZS').trim().toUpperCase();
  const reference = raw?.provider_reference ? String(raw.provider_reference).trim().slice(0, 128) : null;
  const payerName = raw?.payer_name ? String(raw.payer_name).replace(/\s+/g, ' ').trim().slice(0, 128) : null;
  const payerPhone = raw?.payer_phone ? String(raw.payer_phone).replace(/\s+/g, '').trim().slice(0, 32) : null;
  const providerTransactionId = raw?.provider_transaction_id
    ? String(raw.provider_transaction_id).trim().slice(0, 128)
    : deriveProviderTransactionId({ occurredAt, amount, currency, reference, payerName, payerPhone });
  const status = TRANSACTION_STATUSES.includes(raw?.status) ? raw.status : 'pending';

  return {
    transaction: {
      provider_transaction_id: providerTransactionId,
      provider_reference: reference,
      amount,
      currency,
      occurred_at: occurredAt,
      payer_name: payerName,
      // The payer's number is personal data, encrypted at rest exactly as a
      // member's is; the matcher decrypts it for comparison and nothing else.
      payer_phone_enc: payerPhone ? encryptField(payerPhone) : null,
      payer_phone: payerPhone,
      payer_account_ref: raw?.payer_account_ref ? String(raw.payer_account_ref).trim().slice(0, 64) : null,
      description: raw?.description ? String(raw.description).replace(/\s+/g, ' ').trim().slice(0, 500) : null,
      status,
      import_line: raw?.import_line || null,
    },
  };
}

/**
 * Writes a batch of provider rows, skipping any the account has already seen.
 *
 * The insert is `ON CONFLICT DO NOTHING` on the (account, provider transaction id)
 * key, so re-syncing an overlapping statement, last month's file downloaded
 * again, a webhook delivered twice by a retrying provider, adds nothing. The
 * count of skipped rows is returned rather than hidden: "12 already known" is how
 * an admin can tell a working sync from a broken one.
 */
async function ingestTransactions(client, { account, transactions, source, userId, importNote }) {
  const inserted = [];
  const duplicates = [];
  const rejected = [];

  for (const raw of transactions || []) {
    const { transaction, reason } = normalizeTransaction(raw, { account });
    if (reason) {
      rejected.push({ line: raw?.import_line || null, reason, detail: raw?.provider_reference || null });
      continue;
    }
    const { rows } = await client.query(
      `INSERT INTO payment_transactions
         (account_id, provider_transaction_id, provider_reference, amount, currency, occurred_at,
          payer_name, payer_phone_enc, payer_account_ref, description, status, source, import_note, imported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (account_id, provider_transaction_id) DO NOTHING
       RETURNING id`,
      [
        account.id, transaction.provider_transaction_id, transaction.provider_reference, transaction.amount,
        transaction.currency, transaction.occurred_at, transaction.payer_name, transaction.payer_phone_enc,
        transaction.payer_account_ref, transaction.description, transaction.status,
        INTAKE_SOURCES.includes(source) ? source : 'statement',
        importNote ? String(importNote).slice(0, 200) : null,
        userId || null,
      ]
    );
    if (rows[0]) inserted.push({ id: rows[0].id, ...transaction });
    else duplicates.push({ reason: 'payment.skippedAlreadyImported', detail: transaction.provider_transaction_id });
  }

  // The second, softer duplicate signal: a DIFFERENT provider id describing the
  // same payment (some banks issue a new id per statement run). Recorded as a
  // POINTER, never a deletion: the amount may honestly have been given twice,
  // so the admin screen can say "possible duplicate of #41" and open that row,
  // in the reader's own language, instead of the system silently double-counting
  // or silently discarding a real gift.
  for (const row of inserted) {
    if (!row.provider_reference) continue;
    const { rows: twins } = await client.query(
      `SELECT id FROM payment_transactions
        WHERE account_id = $1 AND id <> $2 AND provider_reference = $3
          AND amount = $4 AND date_trunc('day', occurred_at::timestamp) = date_trunc('day', $5::timestamp)
        ORDER BY id LIMIT 1`,
      [account.id, row.id, row.provider_reference, row.amount, row.occurred_at]
    );
    if (twins[0]) {
      await client.query('UPDATE payment_transactions SET possible_duplicate_of = $1 WHERE id = $2', [twins[0].id, row.id]);
      row.possibleDuplicateOf = twins[0].id;
    }
  }

  return { inserted, duplicates, rejected };
}

/**
 * Every member a payment could belong to, with the phone number decrypted for
 * comparison only. The set is the church's own membership: small enough to
 * compare in process, and the only way to match an encrypted column without
 * storing a searchable copy of everybody's number.
 */
async function memberCandidates(client) {
  const { rows } = await client.query(
    'SELECT id, name, member_no, phone_enc, is_active FROM members ORDER BY id'
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    member_no: row.member_no,
    is_active: row.is_active,
    phone: decryptField(row.phone_enc) || '',
  }));
}

/**
 * The matching rules, as a pure function, so what the system claims about a
 * payment is testable without a database, and so the rules read as the policy
 * they are.
 *
 * Returns `{ status, memberId, method, note }` where status is one of
 * 'matched' (safe to treat as this member's gift),
 * 'review'  (a human must decide; `memberId` is the suggestion, if any),
 * 'unmatched' (nothing to go on),
 * and `note` is a stored reason key ('code_vs_payer_name') for the reviews that
 * need explaining, or null where the state is the whole story.
 */

/**
 * The one member, other than `owner`, whose whole name the statement's payer is.
 * Returns null when the payer is the owner, is nobody on the roll, or is nobody
 * at all: only a name that belongs to a DIFFERENT member contradicts a code.
 */
function payerNameOfAnotherMember(owner, payerName, list) {
  if (!payerName) return null;
  if (sameName(owner.name, payerName)) return null;
  return list.find((c) => c.id !== owner.id && sameName(c.name, payerName)) || null;
}
function classifyMatch(transaction, candidates) {
  const trx = transaction || {};
  const list = (candidates || []).filter((c) => c.is_active !== 0 && c.is_active !== false);
  const haystack = [trx.provider_reference, trx.description, trx.payer_account_ref]
    .filter(Boolean)
    .join(' ');

  // 1. The church's own member number, quoted by the payer. Unique, the church's
  //    identifier, and impossible to share with another person. Both sides are
  //    canonicalised, so a payer who writes 'vrt 9' still finds the member whose
  //    stored code is 'VRT-0009' (and a row stored as 'vrt-9' is found too).
  const memberNo = findMemberNumber(haystack);
  if (memberNo) {
    const owner = list.find((c) => canonicalMemberNo(c.member_no) === memberNo);
    if (owner) {
      // …unless the statement names somebody else. The code is still the best
      // evidence there is, so its owner is what gets proposed, but a proposal is
      // all it is, because a mistyped code points at a real member too.
      const other = payerNameOfAnotherMember(owner, trx.payer_name, list);
      if (other) {
        return { status: 'review', memberId: owner.id, method: 'member_no', note: 'code_vs_payer_name' };
      }
      return { status: 'matched', memberId: owner.id, method: 'member_no' };
    }
  }

  // 2. The payer's phone number matching exactly one member's. Two members
  //    sharing a number (a family phone) is ambiguity, not a match.
  const phone = trx.payer_phone || decryptField(trx.payer_phone_enc) || '';
  if (String(phone).replace(/\D+/g, '')) {
    const byPhone = list.filter((c) => c.phone && samePhone(c.phone, phone));
    if (byPhone.length === 1) return { status: 'matched', memberId: byPhone[0].id, method: 'phone' };
    if (byPhone.length > 1) return { status: 'review', memberId: null, method: null, candidates: byPhone.map((c) => c.id) };
  }

  // 3. A whole-name match. Never a match on its own: names are not unique (the
  //    member form itself treats a repeated name as a question: see
  //    routes/members.js), and attributing money to the wrong person is a
  //    mistake the church would have to explain to two families.
  if (trx.payer_name) {
    const byName = list.filter((c) => sameName(c.name, trx.payer_name));
    if (byName.length === 1) return { status: 'review', memberId: byName[0].id, method: 'name' };
    if (byName.length > 1) return { status: 'review', memberId: null, method: null, candidates: byName.map((c) => c.id) };
  }

  return { status: 'unmatched', memberId: null, method: null };
}

/**
 * Applies the rules to one stored transaction and records the verdict.
 *
 * A transaction that has been confirmed, ignored, or matched BY A PERSON is left
 * alone: re-running the matcher must never overwrite a human decision (that is
 * what makes the sync safe to repeat on every visit to the screen).
 *
 * `reprocess` is that rule's one exception, and it exists for the admin asking to
 * take a match back (routes/paymentTransactions.js): the request IS a person
 * reversing a person, so the rules are re-derived instead of the row being
 * parked at a status nobody chose.
 */
async function matchTransaction(client, transactionId, { userId, reprocess = false } = {}) {
  const { rows } = await client.query('SELECT * FROM payment_transactions WHERE id = $1', [transactionId]);
  const trx = rows[0];
  if (!trx) return null;
  if (trx.match_status === 'confirmed' || trx.match_status === 'ignored') return { id: trx.id, status: trx.match_status, skipped: true };
  if (trx.match_method === 'manual' && !reprocess) return { id: trx.id, status: trx.match_status, skipped: true };

  const verdict = classifyMatch(trx, await memberCandidates(client));
  await client.query(
    `UPDATE payment_transactions
        SET match_status = $1, matched_member_id = $2, suggested_member_id = $3, match_method = $4,
            match_note = $5,
            matched_at = CASE WHEN $2::int IS NULL THEN NULL ELSE to_char(now(), 'YYYY-MM-DD HH24:MI:SS') END,
            matched_by = CASE WHEN $2::int IS NULL THEN NULL ELSE $6::int END
      WHERE id = $7`,
    [
      verdict.status,
      verdict.status === 'matched' ? verdict.memberId : null,
      verdict.status === 'review' ? verdict.memberId : null,
      verdict.status === 'matched' ? verdict.method : verdict.status === 'review' ? verdict.method : null,
      verdict.note || null,
      userId || null,
      trx.id,
    ]
  );
  return { id: trx.id, status: verdict.status, memberId: verdict.memberId, method: verdict.method };
}

/**
 * The same, for a batch: after an import, the sync finishes by attempting to
 * attribute what just arrived, so the admin screen opens on a list where the
 * obvious ones are already matched and the rest are marked for review.
 */
async function matchPendingTransactions(client, ids, { userId } = {}) {
  const results = [];
  const candidates = await memberCandidates(client);
  const list = (ids || []).filter(Boolean);
  for (const id of list) {
    const { rows } = await client.query('SELECT * FROM payment_transactions WHERE id = $1', [id]);
    const trx = rows[0];
    if (!trx || trx.match_status === 'confirmed' || trx.match_status === 'ignored' || trx.match_method === 'manual') continue;
    const verdict = classifyMatch(trx, candidates);
    await client.query(
      `UPDATE payment_transactions
          SET match_status = $1, matched_member_id = $2, suggested_member_id = $3, match_method = $4,
              match_note = $5,
              matched_at = CASE WHEN $2::int IS NULL THEN NULL ELSE to_char(now(), 'YYYY-MM-DD HH24:MI:SS') END,
              matched_by = CASE WHEN $2::int IS NULL THEN NULL ELSE $6::int END
        WHERE id = $7`,
      [
        verdict.status,
        verdict.status === 'matched' ? verdict.memberId : null,
        verdict.status === 'review' ? verdict.memberId : null,
        verdict.status === 'matched' ? verdict.method : verdict.status === 'review' ? verdict.method : null,
        verdict.note || null,
        userId || null,
        trx.id,
      ]
    );
    results.push({ id: trx.id, status: verdict.status, memberId: verdict.memberId, method: verdict.method });
  }
  return results;
}

module.exports = {
  MATCH_STATUSES,
  INTAKE_SOURCES,
  REJECT,
  deriveProviderTransactionId,
  normalizeTransaction,
  ingestTransactions,
  memberCandidates,
  classifyMatch,
  matchTransaction,
  matchPendingTransactions,
};
