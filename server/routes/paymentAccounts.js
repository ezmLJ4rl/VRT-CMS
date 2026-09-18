'use strict';
/**
 * The church's payment accounts: connecting one, and what an admin may do with
 * it.
 *
 * WHO MAY SEE THIS: admins and superadmins, only. A connected account is the
 * church's banking detail and its transaction feed, which is a narrower thing
 * than "the church's giving totals" (a pastor sees those; a pastor does not need
 * the church's account numbers or its webhook secret). Every read and write here
 * is audit-logged, and every write is refused for anybody else.
 *
 * WHAT AN ADMIN CANNOT DO: read a secret back. The API never returns
 * `credentials_enc`, decrypts nothing into a response, and shows only the NAMES
 * of the fields that are set. A webhook secret is returned exactly once, at the
 * moment it is created or rotated, because that is the only time anybody needs
 * it (they paste it into the provider's portal). Losing it means rotating it,
 * which is the correct recovery anyway.
 *
 * WHAT CONNECTING ACTUALLY DOES: nothing magical, and nothing fake. Creating a
 * `statement_import` account enables the statement upload below; creating a
 * `webhook` account publishes a URL plus a secret the provider posts to. No
 * request is made to any bank, because no bank has been integrated: see
 * utils/paymentProviders.js for how a real provider adapter is added without
 * touching this file, the schema, or anything downstream.
 */

const express = require('express');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { getProvider, listProviders } = require('../utils/paymentProviders');
// A provider is an enum stored in the database, so it is LABELLED, never printed
// raw in a sentence (see i18n/index.js enumLabel and the enum sweep in
// test/generated-text-i18n.test.js).
const { translator, enumLabel } = require('../i18n');
const {
  generateWebhookSecret,
  publicAccount,
  validateAccountInput,
  writeCredentials,
} = require('../utils/paymentAccounts');
const { ingestTransactions, matchPendingTransactions } = require('../utils/paymentIntake');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('admin', 'superadmin'));

/** The URL a provider posts its notifications to (empty for providers that do
 *  not use webhooks). Built from the request, so a self-hosted install shows its
 *  own host rather than the project's production one. */
function webhookUrlFor(req, account) {
  const provider = getProvider(account.provider);
  if (!provider || !provider.capabilities.webhook) return null;
  return `${req.protocol}://${req.get('host')}/api/payment-webhooks/${account.id}`;
}

/** Unreconciled counts per account, so the screen can say what needs attention
 *  without the admin opening every account in turn. */
async function pendingCounts() {
  const { rows } = await pool.query(
    `SELECT account_id, match_status, COUNT(*)::int AS n,
            COALESCE(SUM(CASE WHEN match_status IN ('unmatched','review') THEN amount ELSE 0 END), 0) AS awaiting_amount
       FROM payment_transactions GROUP BY account_id, match_status`
  );
  const byAccount = new Map();
  for (const row of rows) {
    const entry = byAccount.get(row.account_id) || { awaiting: 0, matched: 0, confirmed: 0, ignored: 0, awaitingAmount: 0 };
    if (row.match_status === 'unmatched') entry.awaiting += row.n;
    else if (row.match_status === 'review') entry.awaiting += row.n;
    else if (row.match_status === 'matched') entry.matched += row.n;
    else if (row.match_status === 'confirmed') entry.confirmed += row.n;
    else if (row.match_status === 'ignored') entry.ignored += row.n;
    if (row.match_status === 'unmatched' || row.match_status === 'review') entry.awaitingAmount += Number(row.awaiting_amount) || 0;
    byAccount.set(row.account_id, entry);
  }
  return byAccount;
}

// GET /api/payment-accounts: the accounts, plus what each one is waiting on.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM payment_accounts ORDER BY status, name');
    const pending = await pendingCounts();
    res.json({
      accounts: rows.map((row) => ({
        ...publicAccount(row),
        webhookUrl: webhookUrlFor(req, row),
        pending: pending.get(row.id) || { awaiting: 0, matched: 0, confirmed: 0, ignored: 0, awaitingAmount: 0 },
      })),
      providers: listProviders(),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadPaymentAccounts' });
  }
});

/**
 * POST /api/payment-accounts: connect one.
 *
 * A webhook account with no secret supplied gets one generated, returned in this
 * response only (see the header comment). The secret is stored encrypted; there
 * is no endpoint that will show it again.
 */
router.post('/', async (req, res) => {
  try {
    const { name, provider, method, accountRef, currency, credentials, status } = req.body || {};
    const invalid = validateAccountInput({ name, provider, method });
    if (invalid) return res.status(400).json({ error: invalid });

    const providerDef = getProvider(provider);
    const incoming = { ...(credentials || {}) };
    let generatedSecret = null;
    if (providerDef.credentialFields.includes('webhook_secret') && !incoming.webhook_secret) {
      generatedSecret = generateWebhookSecret();
      incoming.webhook_secret = generatedSecret;
    }
    const { credentialsEnc } = writeCredentials(provider, incoming, null);

    let id;
    try {
      const { rows } = await pool.query(
        `INSERT INTO payment_accounts (name, provider, method, account_ref, currency, status, credentials_enc, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8) RETURNING id`,
        [
          String(name).trim(),
          provider,
          method,
          accountRef ? String(accountRef).trim() : null,
          (currency ? String(currency).toUpperCase() : 'TZS'),
          status === 'disabled' ? 'disabled' : 'active',
          credentialsEnc,
          req.user.id,
        ]
      );
      id = rows[0].id;
    } catch (err) {
      // The unique key on (provider, account_ref) is the real guard against
      // connecting one account twice; report it as the ordinary mistake it is.
      if (err.code === '23505') return res.status(409).json({ error: 'errors.paymentAccountAlreadyConnected' });
      throw err;
    }

    await logAudit({
      userId: req.user.id,
      action: 'payment_account_created',
      table: 'payment_accounts',
      recordId: id,
      // Which fields were set, never their values: an audit trail that recorded
      // a secret would be a second place to leak it from.
      details: { name: String(name).trim(), provider, method, accountRef: accountRef || null, credentialFields: generatedSecret ? ['webhook_secret'] : [] },
      ip: req.ip,
    });

    const { rows: created } = await pool.query('SELECT * FROM payment_accounts WHERE id = $1', [id]);
    res.status(201).json({
      account: { ...publicAccount(created[0]), webhookUrl: webhookUrlFor(req, created[0]) },
      // Shown once, here, and never again.
      issuedCredentials: generatedSecret ? { webhook_secret: generatedSecret } : null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreatePaymentAccount' });
  }
});

// PATCH /api/payment-accounts/:id: rename, restate, disable, or rotate the secret.
router.patch('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM payment_accounts WHERE id = $1', [req.params.id]);
    const account = rows[0];
    if (!account) return res.status(404).json({ error: 'errors.paymentAccountNotFound' });

    const body = req.body || {};
    const name = body.name !== undefined ? String(body.name).trim() : account.name;
    const method = body.method !== undefined ? body.method : account.method;
    const invalid = validateAccountInput({ name, provider: account.provider, method });
    if (invalid) return res.status(400).json({ error: invalid });

    let credentialsEnc = account.credentials_enc;
    let rotated = null;
    let credentialFields = [];
    const providerDef = getProvider(account.provider);
    if (body.rotateWebhookSecret && providerDef.credentialFields.includes('webhook_secret')) {
      rotated = generateWebhookSecret();
      const written = writeCredentials(account.provider, { webhook_secret: rotated }, account.credentials_enc);
      credentialsEnc = written.credentialsEnc;
      credentialFields = written.fields;
    } else if (body.credentials) {
      const written = writeCredentials(account.provider, body.credentials, account.credentials_enc);
      credentialsEnc = written.credentialsEnc;
      credentialFields = written.fields;
    }

    await pool.query(
      `UPDATE payment_accounts
          SET name = $1, method = $2, account_ref = $3, currency = $4, status = $5, credentials_enc = $6,
              updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE id = $7`,
      [
        name,
        method,
        body.accountRef !== undefined ? (body.accountRef ? String(body.accountRef).trim() : null) : account.account_ref,
        body.currency !== undefined ? String(body.currency).toUpperCase() : account.currency,
        body.status === 'disabled' || body.status === 'active' ? body.status : account.status,
        credentialsEnc,
        account.id,
      ]
    );

    await logAudit({
      userId: req.user.id,
      action: rotated ? 'payment_account_secret_rotated' : 'payment_account_updated',
      table: 'payment_accounts',
      recordId: account.id,
      details: { name, method, status: body.status || account.status, credentialFields },
      ip: req.ip,
    });

    const { rows: updated } = await pool.query('SELECT * FROM payment_accounts WHERE id = $1', [account.id]);
    res.json({
      account: { ...publicAccount(updated[0]), webhookUrl: webhookUrlFor(req, updated[0]) },
      issuedCredentials: rotated ? { webhook_secret: rotated } : null,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'errors.paymentAccountAlreadyConnected' });
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdatePaymentAccount' });
  }
});

/**
 * DELETE /api/payment-accounts/:id: disconnect, but only if nothing came in
 * through it. An account with history is disabled instead: deleting it would
 * take its transactions (and the evidence behind confirmed gifts) with it, which
 * a bookkeeping system must never do to make a form tidier.
 */
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM payment_accounts WHERE id = $1', [req.params.id]);
    const account = rows[0];
    if (!account) return res.status(404).json({ error: 'errors.paymentAccountNotFound' });
    const { rows: used } = await pool.query('SELECT COUNT(*)::int AS n FROM payment_transactions WHERE account_id = $1', [account.id]);
    if (used[0].n > 0) {
      return res.status(409).json({ error: 'errors.paymentAccountHasTransactions', params: { count: used[0].n } });
    }
    await pool.query('DELETE FROM payment_accounts WHERE id = $1', [account.id]);
    await logAudit({
      userId: req.user.id,
      action: 'payment_account_deleted',
      table: 'payment_accounts',
      recordId: account.id,
      details: { name: account.name, provider: account.provider },
      ip: req.ip,
    });
    res.json({ success: true, message: 'messages.paymentAccountDisconnected' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedDeletePaymentAccount' });
  }
});

/**
 * POST /api/payment-accounts/:id/sync: read a statement the church downloaded.
 *
 * Idempotent on purpose: the same file twice inserts nothing the second time
 * (`inserted: 0, duplicates: n`), which is what makes it safe for an admin to
 * re-upload a statement they are unsure about. Whatever is new is then run
 * through the matching rules, so the screen opens on work that is already
 * narrowed down rather than on a wall of raw rows.
 */
router.post('/:id/sync', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM payment_accounts WHERE id = $1', [req.params.id]);
    const account = rows[0];
    if (!account) return res.status(404).json({ error: 'errors.paymentAccountNotFound' });
    if (account.status !== 'active') return res.status(409).json({ error: 'errors.paymentAccountDisabled' });

    const provider = getProvider(account.provider);
    if (!provider) return res.status(400).json({ error: 'errors.unknownPaymentProvider' });
    if (!provider.capabilities.statement) {
      const t = translator(req.locale);
      return res.status(400).json({
        error: 'errors.providerTakesNoStatement',
        params: { provider: enumLabel(t, 'payment.provider_', provider.key) },
      });
    }

    const text = typeof req.body?.statement === 'string' ? req.body.statement : '';
    if (!text.trim()) return res.status(400).json({ error: 'errors.statementFileEmpty' });
    if (text.length > 2_000_000) return res.status(413).json({ error: 'errors.statementFileTooLarge' });

    const parsed = provider.parseStatement(text, { account });
    const importNote = req.body?.fileName ? String(req.body.fileName).slice(0, 200) : 'statement upload';

    const client = await pool.connect();
    let summary;
    try {
      await client.query('BEGIN');
      const ingested = await ingestTransactions(client, {
        account,
        transactions: parsed.transactions,
        source: 'statement',
        userId: req.user.id,
        importNote,
      });
      const matches = await matchPendingTransactions(client, ingested.inserted.map((t) => t.id), { userId: req.user.id });
      // The outcome is stored as JSON, not as a sentence: the admin screen words
      // these counts in its own language (see utils/paymentAccounts.js).
      await client.query(
        `UPDATE payment_accounts SET last_synced_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), last_sync_summary = $1 WHERE id = $2`,
        [JSON.stringify({
          inserted: ingested.inserted.length,
          duplicates: ingested.duplicates.length,
          rejected: parsed.rejected.length + ingested.rejected.length,
          fileName: importNote,
        }), account.id]
      );
      await client.query('COMMIT');
      // `rejected` carries BOTH kinds of row the admin needs to see: the ones the
      // statement reader could not use (a line with no readable amount or date)
      // and the ones the intake refused. Reporting only the second kind would
      // tell an admin "1 row skipped" with no way to find out which, or why,
      // and silently dropping a line from a church's statement is exactly what a
      // reconciliation must never do.
      summary = {
        inserted: ingested.inserted.length,
        duplicates: ingested.duplicates.length,
        rejected: [...parsed.rejected, ...ingested.rejected],
        matched: matches.filter((m) => m.status === 'matched').length,
        review: matches.filter((m) => m.status === 'review').length,
        unmatched: matches.filter((m) => m.status === 'unmatched').length,
        columns: parsed.columns,
      };
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit({
      userId: req.user.id,
      action: 'payment_statement_imported',
      table: 'payment_accounts',
      recordId: account.id,
      details: { account: account.name, inserted: summary.inserted, duplicates: summary.duplicates, rejected: summary.rejected.length, fileName: importNote },
      ip: req.ip,
    });

    res.json({ ...summary, message: 'messages.statementImported' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedImportStatement' });
  }
});

module.exports = router;
