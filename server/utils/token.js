'use strict';
/**
 * Session tokens: how long they last, how they are renewed, and how a credential
 * change invalidates them.
 *
 * Sessions are deliberately long-lived (30 days by default): the people using
 * this run it from a shared office machine during services, and being bounced to
 * the login screen mid-morning is a real cost. Three mechanisms make that
 * lifetime safe:
 *
 *   1. Sliding renewal: a token that is past half its life is re-issued on the
 *      next authenticated request and handed back in the X-Refreshed-Token
 *      response header, so an actively used session never expires at all.
 *   2. Password fingerprint (`pv`): the token carries a short hash of the
 *      password hash it was minted against. Any credential change (self-service
 *      change, superadmin edit, or temporary-password reset) changes that hash,
 *      so every token issued before the change stops working immediately: a
 *      30-day token can never outlive the password it was issued for.
 *   3. Env override: hosts can still dial the lifetime down (or up) with
 *      JWT_EXPIRES_IN, including for a single emergency deployment.
 *
 * Tokens minted before the fingerprint existed carry no `pv` claim; they are
 * left to expire naturally rather than signing every user out on deploy.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const DEFAULT_EXPIRES_IN = '30d';

/** The response header carrying a renewed token (exposed via CORS). */
const REFRESH_HEADER = 'X-Refreshed-Token';

function expiresIn() {
  return process.env.JWT_EXPIRES_IN || DEFAULT_EXPIRES_IN;
}

/** Short, stable digest of the stored password hash (never of the password). */
function passwordFingerprint(passwordHash) {
  if (!passwordHash) return null;
  return crypto.createHash('sha256').update(String(passwordHash)).digest('hex').slice(0, 16);
}

/**
 * The identity of ONE device's session.
 *
 * Every login mints its own random `sid` and every renewal preserves it, so
 * concurrent devices each carry their own revocable identity while remaining
 * fully independent: a token for session A never becomes a token for session B.
 * The id is random, so it cannot be guessed from a user id or a timestamp.
 */
function newSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

function signToken(user, sessionId) {
  return jwt.sign(
    { sub: user.id, role: user.role, pv: passwordFingerprint(user.password_hash), sid: sessionId },
    process.env.JWT_SECRET,
    { expiresIn: expiresIn() }
  );
}

/**
 * True when the token was issued against the account's current password.
 * Missing `pv` (a pre-fingerprint token) is accepted.
 */
function tokenMatchesPassword(payload, user) {
  if (!payload || !payload.pv) return true;
  return payload.pv === passwordFingerprint(user.password_hash);
}

/**
 * Sliding renewal. Re-issues the token once it is past half its lifetime and
 * exposes the replacement in a response header; a fresh token is a no-op.
 * The session id is PRESERVED, so renewal never turns one device's session
 * into another's, and never resurrects a session that was revoked mid-life.
 * Returns the new token, or null when nothing was renewed.
 */
function refreshIfAged(res, payload, user) {
  if (!payload || !payload.iat || !payload.exp) return null;
  const lifetime = payload.exp - payload.iat;
  const age = Math.floor(Date.now() / 1000) - payload.iat;
  if (lifetime <= 0 || age < lifetime / 2) return null;

  const token = signToken(user, payload.sid);
  res.setHeader(REFRESH_HEADER, token);
  return token;
}

module.exports = {
  DEFAULT_EXPIRES_IN,
  REFRESH_HEADER,
  expiresIn,
  newSessionId,
  passwordFingerprint,
  refreshIfAged,
  signToken,
  tokenMatchesPassword,
};
