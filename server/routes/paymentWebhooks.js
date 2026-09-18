'use strict';
/**
 * Where a payment provider tells this system that money arrived.
 *
 * THE ONLY PUBLIC WRITE PATH IN THE APP, so it is built to be boring:
 *
 *   - it authenticates the CALLER, not a user. The account's own signing secret
 *     (encrypted at rest, never readable through the API) must produce a matching
 *     HMAC over the raw request body. No reusable login is stored, no bank
 *     password exists anywhere, and rotating the secret is how a leak is closed.
 *     A body that does not match is refused before a single row is written.
 *   - it writes PAYMENT TRANSACTIONS, never offerings. Whatever arrives is
 *     unconfirmed money awaiting a human decision, exactly like a statement line
 *     (see routes/paymentTransactions.js): an anonymous POST cannot create giving,
 *     a receipt, or a figure in a report.
 *   - it is idempotent. Providers retry, and some deliver the same event twice;
 *     the unique key on (account, provider transaction id) means a repeat adds
 *     nothing and answers `inserted: 0` (see utils/paymentIntake.js).
 *
 * The raw body matters for the signature: `express.json({ verify })` in index.js
 * keeps the exact bytes the provider signed, because re-serializing a parsed
 * object can reorder keys and break a perfectly valid signature.
 */

const express = require('express');
const pool = require('../db/pg');
const { logAudit } = require('../utils/audit');
const { getProvider, SIGNATURE_HEADER } = require('../utils/paymentProviders');
const { readCredentialValues, verifyWebhookSignature } = require('../utils/paymentAccounts');
const { ingestTransactions, matchPendingTransactions } = require('../utils/paymentIntake');

const router = express.Router();

// POST /api/payment-webhooks/:accountId: the provider's notification endpoint.
router.post('/:accountId', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM payment_accounts WHERE id = $1', [req.params.accountId]);
    const account = rows[0];
    // A 404 for an unknown account is deliberate: an integrator wiring this up at
    // 2am needs to know they copied the wrong id. Account ids are small integers
    // and knowing one exists reveals nothing about the church's money: the
    // secret is what protects the endpoint, and it is checked next.
    if (!account) return res.status(404).json({ error: 'errors.paymentAccountNotFound' });

    const provider = getProvider(account.provider);
    if (!provider || !provider.capabilities.webhook) {
      return res.status(400).json({ error: 'errors.providerTakesNoWebhook' });
    }
    if (account.status !== 'active') {
      return res.status(409).json({ error: 'errors.paymentAccountDisabled' });
    }

    const secret = readCredentialValues(account.credentials_enc).webhook_secret;
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    if (!verifyWebhookSignature({ rawBody, header: req.get(SIGNATURE_HEADER), secret })) {
      // Audited even though no user is behind it: a stream of rejected posts is
      // exactly what an admin needs to see when an integration stops working (and
      // what a security review needs to see when somebody tries one).
      await logAudit({
        userId: null,
        action: 'payment_webhook_rejected',
        table: 'payment_accounts',
        recordId: account.id,
        details: { reason: secret ? 'signature_mismatch' : 'no_secret_configured', ip: req.ip },
        ip: req.ip,
      });
      return res.status(401).json({ error: 'errors.paymentWebhookSignatureInvalid' });
    }

    const parsed = provider.parseWebhook(req.body, { account });
    const client = await pool.connect();
    let summary;
    try {
      await client.query('BEGIN');
      const ingested = await ingestTransactions(client, {
        account,
        transactions: parsed.transactions,
        source: 'webhook',
        userId: null,
        importNote: 'webhook',
      });
      const matches = await matchPendingTransactions(client, ingested.inserted.map((t) => t.id), { userId: null });
      const nextSummary = {
        inserted: ingested.inserted.length,
        duplicates: ingested.duplicates.length,
        rejected: ingested.rejected.length,
        fileName: 'webhook',
      };
      await client.query(
        `UPDATE payment_accounts SET last_synced_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'), last_sync_summary = $1 WHERE id = $2`,
        [JSON.stringify(nextSummary), account.id]
      );
      await client.query('COMMIT');
      summary = {
        received: parsed.transactions.length,
        inserted: ingested.inserted.length,
        duplicates: ingested.duplicates.length,
        rejected: parsed.rejected,
        matched: matches.filter((m) => m.status === 'matched').length,
        review: matches.filter((m) => m.status === 'review').length,
        unmatched: matches.filter((m) => m.status === 'unmatched').length,
      };
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // 200 for a duplicate too: the provider's retry did its job, and answering
    // with an error would make it retry forever over a payment it already sent.
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedReceivePaymentWebhook' });
  }
});

module.exports = router;
