'use strict';
/**
 * The credential behind every receipt QR code.
 *
 * What the QR carries is a token, never the receipt: the paper only has to say
 * "look this up", and the verification page holds the details. That shapes this
 * module in three ways:
 *
 *   - the token must not be derivable. It is 192 bits from crypto.randomBytes,
 *     base64url-encoded, which is why a sequential offering id can never stand
 *     in for it: ids are printed in reports, listed in URLs and easy to count
 *     up from one, so an id would let anybody walk the church's whole giving
 *     history from the outside.
 *   - the URL must be stable for the life of the receipt. It is built from
 *     RECEIPT_VERIFY_BASE_URL (see .env.example), so reprinting a receipt from
 *     a different deployment cannot invalidate the QR already on the paper a
 *     member is holding.
 *   - it must be cheap and dependency-free, because db/migrate.js mints tokens
 *     for existing receipts on boot.
 *
 * The token is deliberately NOT a secret from the church's own staff: it is
 * printed on the receipt they hand out. It is only unguessable from outside.
 */
const crypto = require('crypto');

// 24 bytes -> 32 url-safe characters. Long enough that guessing is hopeless,
// short enough that the resulting QR code stays at QR version 3-4 (so the
// modules print large and scan easily at receipt size).
const TOKEN_BYTES = 24;

/**
 * The public base URL the QR codes point at, without a trailing slash.
 *
 * Defaults to the church's production host so a receipt printed from any
 * environment still verifies against the real page; set
 * RECEIPT_VERIFY_BASE_URL to the deployment's own URL (staging, a LAN install)
 * when that is not the canonical one.
 */
function verificationBaseUrl() {
  const configured = String(process.env.RECEIPT_VERIFY_BASE_URL || '').trim().replace(/\/+$/, '');
  return configured || 'https://cms.vrtchurch.org';
}

/** The host alone: printed on the receipt as a trust cue beside the QR code. */
function verificationHost() {
  try {
    return new URL(verificationBaseUrl()).host;
  } catch {
    return verificationBaseUrl();
  }
}

/** A fresh, unguessable verification token. */
function generateVerificationToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Shape check for a token that arrived over HTTP.
 *
 * A value that cannot be one of ours is rejected before it reaches the
 * database, so junk in the URL never becomes a query. Tokens minted by other
 * means (a shorter legacy backfill, a future scheme) still pass: the length
 * bound is generous, and the database lookup is the real answer.
 */
function isVerificationToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

/** The absolute URL a receipt's QR code encodes. */
function verificationUrl(token) {
  return `${verificationBaseUrl()}/verify/receipt/${encodeURIComponent(token)}`;
}

/** The path (no host) the API server serves the public verification page on. */
const VERIFICATION_PATH = '/verify/receipt';

module.exports = {
  generateVerificationToken,
  isVerificationToken,
  verificationBaseUrl,
  verificationHost,
  verificationUrl,
  VERIFICATION_PATH,
  TOKEN_BYTES,
};
