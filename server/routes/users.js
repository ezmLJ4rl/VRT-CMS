const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit, rebuildChain } = require('../utils/audit');
const {
  VALID_LANGUAGES,
  VALID_ROLES,
  authoredRecordCounts,
  isLastActiveSuperadmin,
} = require('../utils/userGuards');

const router = express.Router();
router.use(authenticate);

// Deliberately loose: the address is validated by being used, and overly clever
// email regexes reject real addresses. This only catches obvious typos.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PUBLIC_COLUMNS = 'id, name, email, phone, role, language_pref, is_active, created_at';

function normalizeEmail(email) {
  return String(email).toLowerCase().trim();
}

// GET /api/users: superadmin only
router.get('/', requireRole('superadmin'), async (req, res) => {
  try {
    const { rows: users } = await pool.query(
      `SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at DESC`
    );
    res.json({ users });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadUsers' });
  }
});

// POST /api/users: create a new user account of any role
router.post('/', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, email, phone, role, password, languagePref } = req.body;
    if (!name || !email || !password || !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'errors.nameEmailValidRolePasswordRequired' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'errors.passwordLeast8Characters' });
    if (languagePref !== undefined && !VALID_LANGUAGES.includes(languagePref)) {
      return res.status(400).json({ error: 'errors.unsupportedLanguage' });
    }

    const normalizedEmail = normalizeEmail(email);
    if (!EMAIL_RE.test(normalizedEmail)) return res.status(400).json({ error: 'errors.enterValidEmailAddress' });

    const { rows: existingRows } = await pool.query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
    if (existingRows[0]) return res.status(409).json({ error: 'errors.userEmailAlreadyExists' });

    const hash = bcrypt.hashSync(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, phone, role, password_hash, language_pref) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [String(name).trim(), normalizedEmail, phone || null, role, hash, languagePref || 'en']
    );
    const id = rows[0].id;

    await logAudit({ userId: req.user.id, action: 'user_created', table: 'users', recordId: id, details: { role }, ip: req.ip });
    res.status(201).json({ id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreateUser' });
  }
});

// PATCH /api/users/:id, full account edit: name, email, phone, role, active
// state, language, and the account's password. Only the keys present in the
// request are written, so a field can be cleared (an omitted field is left
// alone, which is why this is a PATCH and not a PUT).
router.patch('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const { name, email, phone, role, isActive, languagePref, password } = req.body;

    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'errors.userNotFound' });

    if (role !== undefined && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: 'errors.invalidRole' });
    }
    if (languagePref !== undefined && !VALID_LANGUAGES.includes(languagePref)) {
      return res.status(400).json({ error: 'errors.unsupportedLanguage' });
    }
    if (name !== undefined && !String(name).trim()) {
      return res.status(400).json({ error: 'errors.nameCannotEmpty' });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      return res.status(400).json({ error: 'errors.passwordLeast8Characters' });
    }

    let normalizedEmail;
    if (email !== undefined) {
      normalizedEmail = normalizeEmail(email);
      if (!EMAIL_RE.test(normalizedEmail)) return res.status(400).json({ error: 'errors.enterValidEmailAddress' });
      const { rows: clash } = await pool.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [
        normalizedEmail,
        user.id,
      ]);
      if (clash[0]) return res.status(409).json({ error: 'errors.anotherUserAlreadyEmailAddress' });
    }

    // Guard rails: a superadmin must not be able to lock themselves (or the
    // church) out of user management.
    if (user.id === req.user.id) {
      if ((role !== undefined && role !== 'superadmin') || isActive === false) {
        return res.status(400).json({ error: 'errors.cannotChangeOwnRoleDeactivateOwnAccount' });
      }
    }
    if (
      (role !== undefined && role !== 'superadmin') ||
      isActive === false
    ) {
      if (await isLastActiveSuperadmin(user)) {
        return res.status(400).json({
          error: 'errors.onlyActiveSuperAdminPromoteAnotherAccountFirstLocked',
        });
      }
    }

    // Column names come from this fixed list, never from the request body.
    const fields = [];
    if (name !== undefined) fields.push(['name', String(name).trim()]);
    if (normalizedEmail !== undefined) fields.push(['email', normalizedEmail]);
    if (phone !== undefined) fields.push(['phone', phone ? String(phone).trim() : null]);
    if (role !== undefined) fields.push(['role', role]);
    if (languagePref !== undefined) fields.push(['language_pref', languagePref]);
    if (isActive !== undefined) fields.push(['is_active', isActive ? 1 : 0]);
    if (password !== undefined) fields.push(['password_hash', bcrypt.hashSync(password, 12)]);

    if (!fields.length) return res.status(400).json({ error: 'errors.nothingUpdate' });

    const values = fields.map(([, value]) => value);
    const assignments = fields.map(([column], i) => `${column} = $${i + 1}`).join(', ');
    const { rows: updated } = await pool.query(
      `UPDATE users SET ${assignments}, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = $${values.length + 1}
       RETURNING ${PUBLIC_COLUMNS}`,
      [...values, user.id]
    );

    // The password itself must never reach the audit log: log which fields
    // changed, not their values.
    const changed = fields.map(([column]) => column).filter((column) => column !== 'password_hash');
    if (password !== undefined) changed.push('password');
    await logAudit({
      userId: req.user.id,
      action: 'user_updated',
      table: 'users',
      recordId: user.id,
      details: { email: user.email, changed },
      ip: req.ip,
    });
    if (password !== undefined) {
      // A new password changes the account's token fingerprint, so every session
      // that user has open is invalidated by this (see utils/token.js).
      await logAudit({
        userId: req.user.id,
        action: 'password_set_by_admin',
        table: 'users',
        recordId: user.id,
        details: { email: user.email },
        ip: req.ip,
      });
    }

    res.json({ success: true, user: updated[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateUser' });
  }
});

// DELETE /api/users/:id: removes an account that has never recorded anything.
// Accounts that did record data are refused (409) with the reason, because
// deleting them would strip the attribution off attendance, offering and
// emergency history; those are deactivated instead.
router.delete('/:id', requireRole('superadmin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'errors.invalidUserId' });
    if (id === req.user.id) return res.status(400).json({ error: 'errors.cannotDeleteOwnAccount' });

    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'errors.userNotFound' });

    if (await isLastActiveSuperadmin(user)) {
      return res.status(400).json({
        error: 'errors.onlyActiveSuperAdminPromoteAnotherAccountFirstLocked',
      });
    }

    const blocking = await authoredRecordCounts(id);
    if (blocking.length) {
      const labels = blocking.map((b) => b.label);
      return res.status(409).json({
        error: 'errors.accountRecordedDataCannotDelete',
        params: { labels: labels.join(', ') },
        blockedBy: labels,
      });
    }

    // One transaction for everything that has to disappear together, then the
    // hash chain is re-linked outside it (rebuildChain reads the surviving rows).
    const client = await pool.connect();
    let removedAuditRows = 0;
    try {
      await client.query('BEGIN');
      // Messages they received stay readable; they just lose the recipient.
      await client.query('UPDATE messages SET recipient_id = NULL WHERE recipient_id = $1', [id]);
      await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [id]);
      // Their own audit trail goes with the account (attribution to a deleted
      // account is meaningless and the FK forbids keeping it).
      const auditResult = await client.query('DELETE FROM audit_log WHERE user_id = $1', [id]);
      removedAuditRows = auditResult.rowCount;
      await client.query('DELETE FROM users WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Removing rows from the middle of the chain leaves the survivors pointing at
    // hashes that no longer exist, which would make /reports/audit/verify report
    // tampering. Re-link what is left so the log stays verifiable.
    if (removedAuditRows > 0) await rebuildChain();

    await logAudit({
      userId: req.user.id,
      action: 'user_deleted',
      table: 'users',
      recordId: id,
      details: { email: user.email, role: user.role, removedAuditRows },
      ip: req.ip,
    });

    res.json({ success: true, removedAuditRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedDeleteUser' });
  }
});

// POST /api/users/:id/reset-password: superadmin issues a one-time temporary
// password for a locked-out user. The plaintext exists only in the API
// response (delivered out-of-band by the caller); what is stored and audited
// is the bcrypt hash, never plaintext at rest or in log entries.
router.post('/:id/reset-password', requireRole('superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.params.id]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'errors.userNotFound' });

    // 12 random bytes → 16 base64url chars (letters, digits, - and _).
    const tempPassword = crypto.randomBytes(12).toString('base64url').slice(0, 16);
    const hash = bcrypt.hashSync(tempPassword, 12);
    await pool.query("UPDATE users SET password_hash = $1, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2", [hash, user.id]);

    await logAudit({
      userId: req.user.id,
      action: 'password_reset',
      table: 'users',
      recordId: user.id,
      details: { email: user.email }, // deliberately no plaintext here
      ip: req.ip,
    });

    // The reset changes the token fingerprint, so sessions the user already had
    // open are dead the moment this returns, which is the point of a reset.
    res.json({ id: user.id, tempPassword });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedResetPassword' });
  }
});

// Any authenticated user can update their own language preference.
router.patch('/me/language', async (req, res) => {
  try {
    const { languagePref } = req.body;
    if (!VALID_LANGUAGES.includes(languagePref)) return res.status(400).json({ error: 'errors.unsupportedLanguage' });
    await pool.query("UPDATE users SET language_pref = $1, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $2", [languagePref, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateLanguagePreference' });
  }
});

module.exports = router;
