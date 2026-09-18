const jwt = require('jsonwebtoken');
const pool = require('../db/pg');
const { todayISO } = require('../utils/date');
const { refreshIfAged, tokenMatchesPassword } = require('../utils/token');

/**
 * Verifies one token and returns the fresh user row, or null after answering
 * 401 itself. Both entry points below share this so the checks (account still
 * exists and is active, password unchanged since the token was minted, sliding
 * renewal) can never drift apart between them.
 */
async function resolveSession(req, res, token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1 AND is_active = 1', [payload.sub]);
  const user = rows[0];
  if (!user) {
    res.status(401).json({ error: 'errors.accountNotFoundDeactivated' });
    return null;
  }
  // Changing a password invalidates every token minted against the old one, so
  // an edited credential takes effect on other devices immediately instead of
  // when the (long) token finally expires.
  if (!tokenMatchesPassword(payload, user)) {
    res.status(401).json({ error: 'errors.passwordChangedLogAgain' });
    return null;
  }
  // Long sessions are renewed as they are used, so an active user never gets
  // signed out; the replacement travels in a response header the clients store.
  refreshIfAged(res, payload, user);
  req.user = user;
  return user;
}

/** Verifies the JWT and attaches the current user (fresh from DB) to req.user. */
async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'errors.authenticationRequired' });

  try {
    if (!(await resolveSession(req, res, token))) return;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'errors.invalidExpiredSessionLogAgain' });
  }
}

/** Restricts a route to one or more roles, e.g. requireRole('admin','superadmin'). */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'errors.notPermissionPerformAction' });
    }
    next();
  };
}

/**
 * Like authenticate, but also accepts ?token= in the query string. This lets
 * links opened in a new tab (receipts, PDFs, CSV downloads) carry credentials
 * without an Authorization header.
 */
async function authByHeaderOrQuery(req, res, next) {
  const header = req.headers.authorization || '';
  let token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token && typeof req.query.token === 'string' && req.query.token) token = req.query.token;
  if (!token) return res.status(401).json({ error: 'errors.authenticationRequired' });
  try {
    if (!(await resolveSession(req, res, token))) return;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'errors.invalidExpiredSessionLogAgain' });
  }
}

/**
 * Receptionists may only touch records for today's date. Admins/pastor/superadmin
 * are exempt. Expects req.body.date or falls back to "today" for creates.
 *
 * NOTE: this middleware alone is not sufficient for offerings, the handler can
 * also resolve a session via serviceId (an arbitrary existing session, possibly
 * dated in the past). routes/offerings.js re-checks the session's date for
 * receptionists after the session is resolved.
 */
function restrictReceptionistToToday(req, res, next) {
  if (req.user.role !== 'receptionist') return next();
  const today = todayISO();
  const targetDate = req.body.date || today;
  if (targetDate !== today) {
    return res.status(403).json({ error: 'errors.receptionistsOnlyRecordEntriesCurrentDay' });
  }
  next();
}

module.exports = { authenticate, requireRole, restrictReceptionistToToday, authByHeaderOrQuery };
