'use strict';
/**
 * The church's connected payment accounts: what may be stored about them, and
 * what may never leave the server.
 *
 * WHAT IS NEVER STORED, EVER
 * --------------------------
 * A bank username and password. An internet-banking PIN. A mobile-money PIN. A
 * card number. A "one-time password" scheme. None of these are columns, none are
 * accepted by the API, and no screen asks for them. They are credentials that can
 * MOVE money, and holding them in a church office database turns a reporting tool
 * into a target.
 *
 * WHAT MAY BE STORED
 * ------------------
 * Exactly what a machine-to-machine integration needs, which is a secret that
 * only lets THIS system READ what a provider already posted: today, one webhook
 * signing secret per account (see utils/paymentProviders.js). It is encrypted at
 * rest with the same AES-256-GCM helper that protects member phone numbers
 * (utils/crypto.js, keyed by FIELD_ENCRYPTION_KEY), it is never included in any
 * response body, not even for a superadmin, and an admin who wants a new one
 * rotates it rather than reads it back.
 *
 * The account number itself (the church's own till or account) is not a secret
 * from the church, but it is still masked in every response: a screenshot of the
 * admin screen should not carry the church's full account number.
 */

const crypto = require('crypto');
const { encryptField, decryptField } = require('./crypto');
const { getProvider } = require('./paymentProviders');
const { PAYMENT_METHODS } = require('./payments');

/** The credential field names an account may carry, per provider. */
function credentialFieldsFor(providerKey) {
  const provider = getProvider(providerKey);
  return provider ? provider.credentialFields : [];
}

/** A fresh signing secret: prefixed so a value seen in a log is identifiable, and
 *  base64url so it survives being pasted into a webhook form field. */
function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

/**
 * Encrypts the credential values to store, and reports which fields are set.
 *
 * Only the provider's own declared fields are kept: an admin cannot smuggle a
 * bank password into the column even by posting a key called `password`, because
 * the key is not in the provider's list and is dropped here rather than stored.
 * An empty string CLEARS the field (that is how a webhook secret is removed),
 * and a field omitted from the body is left exactly as it was.
 */
function writeCredentials(providerKey, incoming, previousEnc) {
  const allowed = credentialFieldsFor(providerKey);
  const existing = readCredentialValues(previousEnc);
  const next = { ...existing };
  let changed = false;

  for (const field of allowed) {
    if (!incoming || incoming[field] === undefined || incoming[field] === null) continue;
    const value = String(incoming[field]).trim();
    if (value === '') {
      if (next[field] !== undefined) { delete next[field]; changed = true; }
      continue;
    }
    // A caller re-posting an unchanged masked value must not overwrite the real
    // secret with the mask ('whsec_••••'). The API never returns the secret, so
    // this only guards against a client that echoes whatever it was shown.
    if (value.includes('•')) continue;
    if (next[field] !== value) { next[field] = value; changed = true; }
  }

  const enc = Object.keys(next).length ? encryptField(JSON.stringify(next)) : (changed ? null : previousEnc || null);
  return { credentialsEnc: enc, fields: Object.keys(next) };
}

/** The stored credential VALUES (server-side only), {} when there are none. */
function readCredentialValues(stored) {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(decryptField(stored) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A value that will not decrypt (rotated key, truncated column) is treated as
    // absent rather than fatal: the admin rotates the secret and carries on, and
    // nothing else in the account stops working.
    return {};
  }
}

/** Where an account's own reference (till/account number) is kept readable. */
function maskAccountRef(ref) {
  const text = String(ref || '').trim();
  if (!text) return null;
  const digits = text.replace(/\s+/g, '');
  const tail = digits.slice(-4);
  return tail.length === digits.length && digits.length <= 4 ? `••••${digits}` : `••••${tail}`;
}

/**
 * The account as every response carries it: no ciphertext, no secret, no full
 * account number. `credential_fields` names what is SET (never the values), which
 * is all an admin screen needs to render "signing secret: configured".
 */
function publicAccount(row) {
  if (!row) return null;
  const fields = readCredentialValues(row.credentials_enc);
  const provider = getProvider(row.provider);
  const out = {
    id: row.id,
    name: row.name,
    provider: row.provider,
    providerLabelKey: provider ? provider.labelKey : null,
    providerHelpKey: provider ? provider.helpKey : null,
    capabilities: provider ? provider.capabilities : { statement: false, webhook: false, liveSync: false },
    credentialFields: provider ? provider.credentialFields : [],
    method: row.method,
    accountRefMasked: maskAccountRef(row.account_ref),
    currency: row.currency,
    status: row.status,
    source: row.source,
    lastSyncedAt: row.last_synced_at,
    // Parsed back into the counts the import produced, so the admin screen can
    // word them in its own language (a stored sentence could not be translated).
    lastSyncSummary: (() => {
      if (!row.last_sync_summary) return null;
      try {
        const parsed = JSON.parse(row.last_sync_summary);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    })(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    credentialFieldsSet: Object.keys(fields),
  };
  return out;
}

/** Validation for the account form. Returns a catalog key, or null when fine. */
function validateAccountInput({ name, provider, method }) {
  if (!String(name || '').trim()) return 'errors.accountNameRequired';
  if (!getProvider(provider)) return 'errors.unknownPaymentProvider';
  if (!PAYMENT_METHODS.includes(String(method || ''))) return 'errors.invalidPaymentMethod';
  return null;
}

/**
 * Checks a webhook's HMAC signature against the account's stored secret.
 *
 * Timing-safe, and tolerant of the two shapes providers use ('sha256=<hex>' and a
 * bare hex/base64 digest). A missing secret means the account cannot accept
 * webhooks at all, which must return false, never true: an account that has not
 * been given a secret cannot be allowed to accept unauthenticated payments.
 */
function verifyWebhookSignature({ rawBody, header, secret }) {
  if (!secret) return false;
  const provided = String(header || '').trim();
  if (!provided) return false;
  const digest = String(provided).replace(/^sha256=/i, '');
  const expected = crypto.createHmac('sha256', secret).update(rawBody || '').digest();
  const candidates = [];
  if (/^[0-9a-f]{64}$/i.test(digest)) candidates.push(Buffer.from(digest, 'hex'));
  try { candidates.push(Buffer.from(digest, 'base64')); } catch { /* not base64 */ }
  return candidates.some((candidate) => candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected));
}

/** The HMAC a provider (or a test, or the admin's own script) would send. */
function signWebhookBody(rawBody, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(rawBody || '').digest('hex')}`;
}

module.exports = {
  credentialFieldsFor,
  generateWebhookSecret,
  writeCredentials,
  readCredentialValues,
  maskAccountRef,
  publicAccount,
  validateAccountInput,
  verifyWebhookSignature,
  signWebhookBody,
};
