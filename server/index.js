require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const pool = require('./db/pg'); // Postgres connection pool shared by every route
const { canonicalizeOfferingTypes } = require('./db/canonicalize');
const { migrate } = require('./db/migrate');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const serviceRoutes = require('./routes/services');
const serviceTypeRoutes = require('./routes/serviceTypes');
const memberRoutes = require('./routes/members');
const groupRoutes = require('./routes/groups');
const revivalCenterRoutes = require('./routes/revivalCenters');
const attendanceRoutes = require('./routes/attendance');
const offeringRoutes = require('./routes/offerings');
const notificationRoutes = require('./routes/notifications');
const messageRoutes = require('./routes/messages');
const reportRoutes = require('./routes/reports');
const emergencyRoutes = require('./routes/emergencies');
const pushRoutes = require('./routes/push');
const eventRoutes = require('./routes/events');
const projectRoutes = require('./routes/projects');
const appointmentRoutes = require('./routes/appointments');
const paymentAccountRoutes = require('./routes/paymentAccounts');
const paymentTransactionRoutes = require('./routes/paymentTransactions');
const paymentWebhookRoutes = require('./routes/paymentWebhooks');
const { pageRouter: receiptVerificationPage, apiRouter: receiptVerificationApi } = require('./routes/verification');

const { todayISO, TIMEZONE } = require('./utils/date');
const localeMiddleware = require('./middleware/locale');
const app = express();

// Self-repair on every boot: first bring an existing database up to the current
// schema (db/migrate.js: schema.sql only ever runs on an empty database), then
// keep offerings.type aligned with offering_categories so no report splits a
// total by legacy spelling. Both are no-ops once applied, and neither may stop
// the server from serving traffic.
migrate()
  .then(() => canonicalizeOfferingTypes())
  .catch((err) => console.error('startup self-repair skipped:', err.message));

// Behind a reverse proxy (Nginx, Render, Railway, Fly.io...), trust exactly
// TRUST_PROXY hops so req.ip is the real client IP. This matters twice:
//  - express-rate-limit would otherwise key on the proxy's IP, so ALL logins
//    share one bucket and the whole church gets locked out after max attempts.
//  - audit-log rows would record the proxy IP instead of the actual client.
const trustProxy = Number(process.env.TRUST_PROXY || 0);
if (Number.isInteger(trustProxy) && trustProxy > 0) app.set('trust proxy', trustProxy);

// Supports one or more allowed origins, comma-separated, so both the admin
// app and the Pastor PWA (served from different URLs) can reach this API.
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173,http://localhost:5174')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// This server also serves the built admin app and Pastor PWA (see the static
// mounts below), so requests that originate from ITS OWN origin must be allowed
// regardless of the hostname the deployment happens to use. Without this, the
// self-hosted build breaks: browsers send no Origin header for same-origin
// subresources, but embedded webviews (and some fetch modes) do, and the
// allowlist above only knows about the separate dev-server origins.
function isSameOrigin(req, origin) {
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  // Behind a reverse proxy the public host arrives in x-forwarded-host.
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  return originHost === req.headers.host || (!!forwardedHost && originHost === forwardedHost);
}

app.use(helmet());
// A cors() instance is built per request so the origin check can compare against
// THAT request's own host. The upstream package invokes the origin callback
// without the request, so a single shared instance cannot see it.
app.use((req, res, next) => {
  cors({
    origin(origin, callback) {
      // Allow non-browser requests (no Origin header, e.g. curl/health checks),
      // any configured origin, and this server's own origin.
      if (!origin || allowedOrigins.includes(origin) || isSameOrigin(req, origin)) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    // Sessions renew on use: the replacement token travels in a response header
    // (see utils/token.js). Cross-origin deployments (CLIENT_URL pointing at a
    // separate host) only expose it to the browser once it is listed here.
    exposedHeaders: ['X-Refreshed-Token'],
  })(req, res, next);
});
// `verify` keeps the EXACT bytes of the request. A payment provider signs those
// bytes, and re-serializing the parsed object can reorder keys and break a valid
// signature, so the raw buffer is kept for the webhook receiver (see
// routes/paymentWebhooks.js). Nothing else reads it, and the buffer is the same
// one express already parsed, not a second copy of the payload.
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    if (buf && buf.length) req.rawBody = buf;
  },
}));

// Every API answer is current state, never a cached copy. Express would otherwise
// let a browser hold a heuristic/ETag copy of a list endpoint, so a service type
// created or renamed in the Service Types screen could keep showing the old name
// on the front desk until a cache clear: exactly the staleness the front desk
// must never have. Config lists (service types, groups, centers, categories) are
// small and read on demand, so re-fetching them is cheaper than being wrong.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Answers in the caller's language: resolves it once per request and translates
// outgoing error/message keys (see i18n/index.js). Registered before every route
// so no handler has to think about language.
app.use(localeMiddleware);

// Force HTTPS in production (behind a reverse proxy that sets x-forwarded-proto)
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(`https://${req.headers.host}${req.url}`);
  }
  next();
});

// Health check hits Postgres so a broken/misconfigured connection surfaces here
// instead of as a 500 on the first real request.
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');
    res.json({ status: 'ok', database: 'postgres', time: new Date().toISOString() });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(503).json({ status: 'error', database: 'postgres', error: 'errors.databaseUnavailable' });
  }
});

// Single source of truth for "today": clients never trust their own clock.
app.get('/api/time', (req, res) => {
  const now = new Date();
  res.json({ now: now.toISOString(), date: todayISO(), timezone: TIMEZONE });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/services', serviceRoutes);
app.use('/api/service-types', serviceTypeRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/revival-centers', revivalCenterRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/offerings', offeringRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/emergencies', emergencyRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/appointments', appointmentRoutes);
// Connected church payment accounts and the payments that arrive in them. Both
// are admin/superadmin (financial detail: see the route headers); the webhook
// receiver is public by necessity and authenticates with the account's own HMAC
// secret instead of a session.
app.use('/api/payment-accounts', paymentAccountRoutes);
app.use('/api/payment-transactions', paymentTransactionRoutes);
app.use('/api/payment-webhooks', paymentWebhookRoutes);
// Public, unauthenticated receipt verification: the member holding a printed
// receipt scans its QR code, so there is no session to authenticate. The page
// mount is registered HERE, before the static/SPA fallback below, because the
// root path belongs to the Pastor PWA: without this, `/verify/...` would be
// answered with the PWA's index.html. (The separate, admin-only daily
// audit-chain check lives at /api/reports/audit/verify.)
app.use('/verify', receiptVerificationPage);
app.use('/api/verify', receiptVerificationApi);

// 404 for unknown API routes (JSON, not the default HTML page)
app.use('/api', (req, res) => res.status(404).json({ error: 'errors.notFound' }));

// Serve the production builds of both client apps from this API server, so the
// heavy Vite dev servers are optional. The Pastor PWA lives at the root and the
// admin app lives under /admin/ (it is built with base '/admin/').
const PASTOR_DIST = path.join(__dirname, '..', 'client-pastor', 'dist');
const ADMIN_DIST = path.join(__dirname, '..', 'client-admin', 'dist');

const spaFallback = (dist) => (req, res, next) => {
  if (req.method === 'GET' && req.accepts('html')) {
    return res.sendFile(path.join(dist, 'index.html'));
  }
  next();
};

app.use('/admin', express.static(ADMIN_DIST));
app.use('/admin', spaFallback(ADMIN_DIST));
app.use(express.static(PASTOR_DIST));
app.use(spaFallback(PASTOR_DIST));

// Generic error handler, never leak stack traces to the client.
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'errors.originNotAllowed' });
  }
  console.error(err);
  res.status(500).json({ error: 'errors.unexpectedServerError' });
});

// Port precedence is environment first, then .env, then 4000.
// Hosts (Render, Railway, Fly.io, Docker) inject PORT and it MUST win, but a
// stray export in a shell or CI sandbox (PORT=0 binds a random port, making the
// health check unreachable) is indistinguishable from that, so only a usable
// value counts and .env covers the rest. Note dotenv does not override an
// already-exported variable, so `PORT=... npm start` intentionally beats .env.
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 4000;
const server = app.listen(PORT, () => {
  console.log(`VRT CMS API running on port ${PORT}`);
});

// A second copy of this process (or any other program) holding the port used to
// crash with an unhandled 'error' event and a raw stack trace, which hid the
// real problem. Report it in plain language and exit non-zero so supervisors
// (pm2, systemd, Docker) restart cleanly instead of looping on a crash dump.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Another copy of the server is probably running:\n` +
        `  - find it:  netstat -ano | findstr :${PORT}   (Windows)\n` +
        `              lsof -i :${PORT}                  (macOS/Linux)\n` +
        `  - or set a different PORT in server/.env`
    );
  } else {
    console.error('Failed to start server:', err);
  }
  process.exit(1);
});
