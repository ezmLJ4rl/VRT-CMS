const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const pool = require('../db/pg');
const { logAudit } = require('../utils/audit');
const { authenticate } = require('../middleware/auth');
const { REFRESH_HEADER, signToken, newSessionId } = require('../utils/token');

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

    // One server-side session record per device. The JWT carries this id as its
    // `sid` claim, so every device holds an independently revocable session and
    // logging in from a new device never disturbs the sessions already open.
    // Token lifetime IS the session lifetime: no separate expiry to keep in step.
    const sid = newSessionId();
    await pool.query('INSERT INTO user_sessions (user_id, sid) VALUES ($1, $2)', [user.id, sid]);

    const token = signToken(user, sid);
    await logAudit({ userId: user.id, action: 'login_success', table: 'users', recordId: user.id, details: { sessionId: sid }, ip: req.ip });
    res.json({ token, sessionId: sid, user: safeUser(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedSignTryAgain' });
  }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: safeUser(req.user), sessionId: req.sessionId || null });
});

// ---------------------------------------------------------------- sessions

// GET /api/auth/sessions: this account's signed-in devices, newest activity
// first. Returns only what a user needs to recognise a device: no tokens, no
// hashes. `current` marks the session making the request.
router.get('/sessions', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT sid, last_active_at
         FROM user_sessions
        WHERE user_id = $1 AND revoked_at IS NULL
        ORDER BY (sid = $2) DESC, last_active_at DESC, id DESC`,
      [req.user.id, req.sessionId || '']
    );
    res.json({
      sessions: rows.map((r) => ({
        id: r.sid,
        lastActiveAt: r.last_active_at,
        current: req.sessionId ? r.sid === req.sessionId : false,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadSessions' });
  }
});

// POST /api/auth/logout: end THIS device's session only. Every other signed-in
// device of the same account keeps working — that is the whole point of
// per-session identity. Idempotent: an already-revoked session stays revoked.
router.post('/logout', authenticate, async (req, res) => {
  try {
    if (req.sessionId) {
      await pool.query(
        "UPDATE user_sessions SET revoked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE sid = $1 AND user_id = $2 AND revoked_at IS NULL",
        [req.sessionId, req.user.id]
      );
      await logAudit({ userId: req.user.id, action: 'logout', table: 'user_sessions', recordId: null, details: { sessionId: req.sessionId }, ip: req.ip });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLogout' });
  }
});

// POST /api/auth/logout-all: revoke every active session of this account,
// including the device making the request (which clears its own token).
router.post('/logout-all', authenticate, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "UPDATE user_sessions SET revoked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE user_id = $1 AND revoked_at IS NULL",
      [req.user.id]
    );
    await logAudit({ userId: req.user.id, action: 'logout_all', table: 'user_sessions', recordId: null, details: { revoked: rowCount }, ip: req.ip });
    res.json({ success: true, revoked: rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLogout' });
  }
});

// POST /api/auth/sessions/:sid/revoke: end one OTHER device's session (for
// example a lost phone). Refuses the current session so the dedicated logout
// action stays the only way to end it, keeping the two operations distinct.
router.post('/sessions/:sid/revoke', authenticate, async (req, res) => {
  try {
    if (req.sessionId && req.params.sid === req.sessionId) {
      return res.status(400).json({ error: 'errors.cannotRevokeCurrentSession' });
    }
    const { rowCount } = await pool.query(
      "UPDATE user_sessions SET revoked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE sid = $1 AND user_id = $2 AND revoked_at IS NULL",
      [req.params.sid, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'errors.sessionNotFound' });
    await logAudit({ userId: req.user.id, action: 'session_revoked', table: 'user_sessions', recordId: null, details: { sessionId: req.params.sid }, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLogout' });
  }
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
    // Every OTHER device is signed out twice over: its token fails the password
    // fingerprint, and its session row is revoked so no re-minted copy works.
    // THIS device's row is deliberately left intact — the replacement token in
    // the refresh header carries the same sid, so the session continues.
    await pool.query(
      `UPDATE user_sessions SET revoked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
        WHERE user_id = $1 AND revoked_at IS NULL AND sid <> $2`,
      [req.user.id, req.sessionId || '']
    );
    res.setHeader(REFRESH_HEADER, signToken(rows[0], req.sessionId));
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedChangePassword' });
  }
});

module.exports = router;
