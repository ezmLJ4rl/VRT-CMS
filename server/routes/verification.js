'use strict';
/**
 * Receipt verification, from the outside.
 *
 * Two public faces of one lookup, and neither of them is authenticated: the
 * whole point is that the member holding a printed receipt can open it, from a
 * phone, without an account:
 *
 *   GET /verify/receipt/:token        the page the QR code points at
 *   GET /api/verify/receipt/:token    the same answer as JSON (apps, tests)
 *
 * Both resolve the token to ONE offering (utils/receiptVerification.js) and
 * report that receipt's own status. The church's daily audit-chain check is a
 * separate, admin-only feature (`GET /api/reports/audit/verify`, mounted under
 * /admin in the UI) and is deliberately not reachable from here: a receipt's QR
 * code verifies that receipt, never a day's books.
 *
 * This module exports two routers because the page lives at the site root (the
 * URL printed on paper has to be short and stable) while the JSON API lives
 * under /api like every other endpoint. See index.js for both mounts: the page
 * mount is registered BEFORE the SPA fallback so `/verify/...` is never answered
 * with the Pastor PWA's index.html.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  findReceiptByToken,
  receiptVerificationResult,
  renderVerificationPage,
  NOT_FOUND,
} = require('../utils/receiptVerification');

/**
 * A backstop, not a security boundary: guessing a 192-bit token is not a threat
 * the rate limiter addresses (and the endpoint exposes nothing personal for a
 * successful guess anyway). What it stops is a flood of junk paths. The ceiling
 * is deliberately high because a whole congregation scans on the church's wifi
 * one shared public IP: in the minutes after a service, and a member being
 * told "too many requests" instead of whether their receipt is valid would be a
 * worse outcome than a script probing pointless URLs slowly.
 */
const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.VERIFY_RATE_LIMIT_MAX || 1000),
  keyGenerator: (req) => req.ip,
  message: { error: 'errors.tooManyVerificationRequests' },
  standardHeaders: true,
  legacyHeaders: false,
});

const pageRouter = express.Router();
const apiRouter = express.Router();

// Every answer here is about the CURRENT state of a receipt, so it must never
// be cached (a browser holding a copy would keep showing "Verified" after the
// receipt was revoked).
function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

pageRouter.use(noStore, verificationLimiter);
apiRouter.use(verificationLimiter);

/** The page the QR code opens, in the reader's own language. */
pageRouter.get('/receipt/:token', async (req, res) => {
  try {
    const row = await findReceiptByToken(req.params.token);
    const result = receiptVerificationResult(row, req.locale);
    // 404 for a code that matches nothing, 200 for a receipt that exists but is
    // revoked: the member's receipt IS found in the second case, and the page
    // has to show what it says about it.
    res.status(row ? 200 : 404).type('html').send(renderVerificationPage(result, req.locale));
  } catch (err) {
    console.error('receipt verification failed:', err);
    res.status(500).type('html').send(renderVerificationPage({ status: NOT_FOUND, receipt: null }, req.locale));
  }
});

// A scan of a badly printed code can lose the token, or a member can type the
// path by hand from memory. Explain that rather than returning a bare 404 page.
pageRouter.get('/receipt', (req, res) => {
  res.status(404).type('html').send(
    renderVerificationPage({ status: NOT_FOUND, receipt: null }, req.locale)
  );
});

/** The same result as JSON. */
apiRouter.get('/receipt/:token', async (req, res) => {
  try {
    const row = await findReceiptByToken(req.params.token);
    const result = receiptVerificationResult(row, req.locale);
    res.status(row ? 200 : 404).json(result);
  } catch (err) {
    console.error('receipt verification failed:', err);
    res.status(500).json({ verified: false, status: NOT_FOUND, error: 'errors.failedVerifyReceipt', receipt: null });
  }
});

module.exports = { pageRouter, apiRouter };
