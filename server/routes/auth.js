const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pg');
const { logAudit } = require('../utils/audit');
const { authenticate } = require('../middleware/auth');
const { REFRESH_HEADER, signToken } = require('../utils/token');

const router = express.Router();

// Which app this login request came from. The two apps (Pastor PWA and the
// admin/receptionist app) are deliberately tracked as independent scopes: a
// lockout triggered on one must never affect the other.
function appKey(req) {
  return String(req.body && req.body.app) === 'pastor' ? 'pastor' : 'admin';
}

// Broad per-app + IP safety net (defense in depth). The user-facing lockout is
// the per-app + username counter below; this only stops brute-force hammering
// of the endpoint itself and is keyed per app so the apps stay independent.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 20),
  keyGenerator: (req) => `${appKey(req)}:${req.ip}`,
  message: { error: 'errors.tooManyLoginAttemptsTryAgainFewMinutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

const LOCKOUT_MAX = Math.max(1, Number(process.env.LOGIN_LOCKOUT_MAX || 5));
const LOCKOUT_MS = Math.max(1000, Number(process.env.LOGIN_LOCKOUT_SECONDS || 60) * 1000);

// In-memory per-account counters, keyed "app:email". Church-scale traffic; a
// simple Map is fine. Entries are pruned aggressively so stale state evaporates.
const attempts = new Map();

function accountKey(app, email) {
  return `${app}:${email.toLowerCase().trim()}`;
}

function lockedRemaining(key) {
  const entry = attempts.get(key);
  if (!entry || !entry.lockedUntil) return 0;
  const remaining = entry.lockedUntil - Date.now();
  if (remaining <= 0) {
    attempts.delete(key);
    return 0;
  }
  return remaining;
}

// Returns { locked, retryAfter } after recording one failed attempt.
function recordFailure(key) {
  const now = Date.now();
  // Prune stale entries so the map never grows unbounded.
  for (const [k, e] of attempts) {
    if (now - (e.lockedUntil || e.updated) > LOCKOUT_MS * 2) attempts.delete(k);
  }
  const entry = attempts.get(key) || { fails: 0, lockedUntil: 0, updated: now };
  entry.fails += 1;
  entry.updated = now;
  if (entry.fails >= LOCKOUT_MAX) {
    entry.lockedUntil = now + LOCKOUT_MS;
    entry.fails = 0;
    attempts.set(key, entry);
    return { locked: true, retryAfter: Math.ceil(LOCKOUT_MS / 1000) };
  }
  attempts.set(key, entry);
  return { locked: false, retryAfter: 0 };
}

function clearFailures(key) {
  attempts.delete(key);
}

function safeUser(u) {
  // Strip the password hash and the legacy 2FA columns (totp_secret/totp_enabled
  // still exist in old databases) so no secret material ever leaves the API.
  const { password_hash, totp_secret, totp_enabled, ...rest } = u;
  return rest;
}

// Login is deliberately a single step: email + password. There is no device
// pairing, QR scan, or authenticator-app requirement: any authorized user can
// sign in from any device they have. Brute-force protection is handled by the
// login rate limiter; per-session security (long but sliding token expiry, see
// utils/token.js, logout, role checks, activation checks) still applies
// independently on every device.
// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'errors.emailPasswordRequired' });

    const app = appKey(req);
    const key = accountKey(app, email);

    const remaining = lockedRemaining(key);
    if (remaining > 0) {
      const retryAfter = Math.ceil(remaining / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'errors.tooManyFailedAttemptsTryAgainShortly', retryAfter });
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1 AND is_active = 1', [email.toLowerCase().trim()]);
    const user = rows[0];
    if (!user) {
      const { locked, retryAfter } = recordFailure(key);
      if (locked) res.set('Retry-After', String(retryAfter));
      return res.status(locked ? 429 : 401).json(
        locked ? { error: 'errors.tooManyFailedAttemptsTryAgainShortly', retryAfter } : { error: 'errors.invalidEmailPassword' }
      );
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      await logAudit({ userId: user.id, action: 'login_failed', table: 'users', recordId: user.id, ip: req.ip });
      const { locked, retryAfter } = recordFailure(key);
      if (locked) res.set('Retry-After', String(retryAfter));
      return res.status(locked ? 429 : 401).json(
        locked ? { error: 'errors.tooManyFailedAttemptsTryAgainShortly', retryAfter } : { error: 'errors.invalidEmailPassword' }
      );
    }

    clearFailures(key);

    const token = signToken(user);
    await logAudit({ userId: user.id, action: 'login_success', table: 'users', recordId: user.id, ip: req.ip });
    res.json({ token, user: safeUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedSignTryAgain' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: safeUser(req.user) });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'errors.newPasswordLeast8Characters' });
    }
    const valid = bcrypt.compareSync(currentPassword || '', req.user.password_hash);
    if (!valid) return res.status(401).json({ error: 'errors.currentPasswordIncorrect' });
    const hash = bcrypt.hashSync(newPassword, 12);
    const { rows } = await pool.query(
      "UPDATE users SET password_hash = $1, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2 RETURNING *",
      [hash, req.user.id]
    );
    await logAudit({ userId: req.user.id, action: 'password_changed', table: 'users', recordId: req.user.id });
    // The new password invalidates every token minted against the old one:
    // including this device's, which would sign the user out of the session they
    // are standing in. Hand back a freshly minted one in the standard refresh
    // header so only the other devices are logged out.
    res.setHeader(REFRESH_HEADER, signToken(rows[0]));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedChangePassword' });
  }
});

module.exports = router;
