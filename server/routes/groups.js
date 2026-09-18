const express = require('express');
const multer = require('multer');
const pool = require('../db/pg');
const { authenticate, requireRole } = require('../middleware/auth');
const { decryptField } = require('../utils/crypto');
const { logAudit } = require('../utils/audit');
const { recordChanges } = require('../utils/groupMembership');

const router = express.Router();
router.use(authenticate);

// Logo uploads arrive in memory only: nothing is written to disk (the bytes go
// straight into the group's row), and the 2MB cap matches MAX_LOGO_BYTES below;
// multer rejects a bigger part before the handler runs.
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

/**
 * Multer failures would otherwise fall through to the generic 500 handler.
 * They are the client's doing: too big, malformed multipart, so they are
 * answered here, in the same key-based idiom as every other refusal.
 */
function logoUploadError(err, req, res, next) {
  if (!(err instanceof multer.MulterError)) return next(err);
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'errors.logoTooLarge' });
  return res.status(400).json({ error: 'errors.logoMultipartRequired' });
}

const GROUP_KINDS = ['small_group', 'choir', 'worship_team', 'fellowship'];
const MEMBER_ROLES = ['member', 'leader', 'co-leader'];

// Logos are stored in the row (see db/schema.sql), so `SELECT *` would hand a
// megabyte of bytes to every list and detail read. Everything except the logo
// endpoint itself selects through this projection and reports only `has_logo`:
// the bytes travel exactly once, when the browser asks for the image.
const GROUP_COLUMNS = 'id, name, kind, description, sort_order, is_active, created_at, logo_mime, logo_updated_at';
function withHasLogo(g) {
  return { ...g, has_logo: g.logo_mime != null };
}

// GET /api/groups: reference list for attendance/offerings/notifications + member counts.
router.get('/', async (req, res) => {
  try {
    const { rows: groups } = await pool.query(
      `SELECT g.id, g.name, g.kind, g.description, g.sort_order, g.is_active, g.created_at, g.logo_mime, g.logo_updated_at,
              (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
       FROM "groups" g
       ORDER BY g.sort_order, g.name`
    );
    res.json({ groups: groups.map(withHasLogo) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadGroups' });
  }
});

// POST /api/groups: create a group.
// The Groups section is part of the front desk's job too, so a receptionist has
// the same reach here as an admin (see test/groups-access.test.js).
router.post('/', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { name, kind, description, sortOrder, isActive } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'errors.nameRequired' });
    if (kind && !GROUP_KINDS.includes(kind)) return res.status(400).json({ error: 'errors.unknownGroupKind' });
    const { rows: maxRows } = await pool.query('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM "groups"');
    const nextOrder = maxRows[0].n;
    const { rows } = await pool.query(
      `INSERT INTO "groups" (name, kind, description, sort_order, is_active) VALUES ($1, $2, $3, $4, $5) RETURNING ${GROUP_COLUMNS}`,
      [String(name).trim(), kind || 'small_group', description || null, sortOrder !== undefined ? Number(sortOrder) : nextOrder, isActive === false ? 0 : 1]
    );

    await logAudit({ userId: req.user.id, action: 'group_created', table: 'groups', recordId: rows[0].id, details: { name }, ip: req.ip });
    res.status(201).json({ group: withHasLogo(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreateGroup' });
  }
});

// PATCH /api/groups/:id: update a group.
router.patch('/:id', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM "groups" WHERE id = $1', [req.params.id]);
    const existing = rows[0];
    if (!existing) return res.status(404).json({ error: 'errors.groupNotFound' });
    const { name, kind, description, sortOrder, isActive } = req.body;
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'errors.nameCannotEmpty' });
    if (kind !== undefined && !GROUP_KINDS.includes(kind)) return res.status(400).json({ error: 'errors.unknownGroupKind' });

    const { rows: updated } = await pool.query(
      `UPDATE "groups" SET name = $1, kind = $2, description = $3, sort_order = $4, is_active = $5 WHERE id = $6 RETURNING ${GROUP_COLUMNS}`,
      [
        name !== undefined ? String(name).trim() : existing.name,
        kind !== undefined ? kind : existing.kind,
        description !== undefined ? description : existing.description,
        sortOrder !== undefined ? Number(sortOrder) : existing.sort_order,
        isActive !== undefined ? (isActive === false ? 0 : 1) : existing.is_active,
        existing.id,
      ]
    );
    await logAudit({ userId: req.user.id, action: 'group_updated', table: 'groups', recordId: existing.id, details: { name: name || existing.name }, ip: req.ip });
    res.json({ group: withHasLogo(updated[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateGroup' });
  }
});

// DELETE /api/groups/:id: remove a group, or deactivate it when it has history.
//
// The same rule as member deletion (see routes/members.js): attendance and
// offerings reference a group by id because past records must keep naming the
// group they belong to, so a group that ever recorded either is NOT deleted:
// deactivating takes it off pickers and new records while keeping every past
// figure attributed. A group with no history is genuinely removable: its
// current membership list is not history, so it is cleared in the same
// transaction rather than blocking the delete (its logo bytes go with the row).
//
// Deleting is a step beyond editing, so it is admin-gated even though the front
// desk may create and rename groups.
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM "groups" WHERE id = $1', [req.params.id]);
    const group = rows[0];
    if (!group) return res.status(404).json({ error: 'errors.groupNotFound' });

    const history = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM attendance WHERE group_id = $1', [group.id]),
      pool.query('SELECT COUNT(*)::int AS n FROM offerings WHERE group_id = $1', [group.id]),
    ]);
    const counts = { attendance: history[0].rows[0].n, offerings: history[1].rows[0].n };
    if (counts.attendance + counts.offerings > 0) {
      await pool.query('UPDATE "groups" SET is_active = 0 WHERE id = $1', [group.id]);
      await logAudit({ userId: req.user.id, action: 'group_deactivated', table: 'groups', recordId: group.id, details: { name: group.name, reason: 'has_history', counts }, ip: req.ip });
      return res.json({ success: true, deactivated: true, history: counts });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM group_members WHERE group_id = $1', [group.id]);
      await client.query('DELETE FROM "groups" WHERE id = $1', [group.id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
    await logAudit({ userId: req.user.id, action: 'group_deleted', table: 'groups', recordId: group.id, details: { name: group.name }, ip: req.ip });
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedDeleteGroup' });
  }
});

/**
 * A group's roster, in the order a reader wants it: leaders first, then everyone
 * else, each alphabetical. Phone numbers are encrypted at rest, so they are
 * fetched in ONE batched query (never a round-trip per member) and decrypted
 * into `phone`; the ciphertext itself never reaches the response.
 */
async function loadGroupMembers(groupId) {
  const { rows: memberRows } = await pool.query(
    `SELECT m.id, m.member_no, m.name, m.email, m.is_active, gm.role,
            rc.name AS center_name, cz.name AS zone_name
     FROM group_members gm
     JOIN members m ON m.id = gm.member_id
     LEFT JOIN revival_centers rc ON rc.id = m.revival_center_id
     LEFT JOIN center_zones cz ON cz.id = m.zone_id
     WHERE gm.group_id = $1
     ORDER BY CASE gm.role WHEN 'leader' THEN 0 WHEN 'co-leader' THEN 1 ELSE 2 END, m.name ASC`,
    [groupId]
  );
  const members = [];
  if (memberRows.length) {
    const ids = memberRows.map((m) => m.id);
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rows: phoneRows } = await pool.query(`SELECT id, phone_enc FROM members WHERE id IN (${ph})`, ids);
    const byId = new Map(phoneRows.map((p) => [p.id, p.phone_enc]));
    for (const m of memberRows) members.push({ ...m, phone: decryptField(byId.get(m.id)) || '' });
  }
  return members;
}

// GET /api/groups/:id: one group with its roster and the counts derived from
// it. The Groups list is a count because membership is written on the member
// (see routes/members.js); this is where the people behind that count are read.
router.get('/:id', async (req, res) => {
  try {
    const { rows: groupRows } = await pool.query(`SELECT ${GROUP_COLUMNS} FROM "groups" WHERE id = $1`, [req.params.id]);
    const group = groupRows[0] && withHasLogo(groupRows[0]);
    if (!group) return res.status(404).json({ error: 'errors.groupNotFound' });
    const members = await loadGroupMembers(group.id);
    const leaders = members.filter((m) => m.role === 'leader' || m.role === 'co-leader').length;
    res.json({
      group,
      members,
      counts: { total: members.length, leaders, members: members.length - leaders },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadGroupMembers' });
  }
});

// GET /api/groups/:id/members: the roster on its own (kept for callers that
// only need the list, e.g. the front desk's member pickers).
router.get('/:id/members', async (req, res) => {
  try {
    const { rows: groupRows } = await pool.query(`SELECT ${GROUP_COLUMNS} FROM "groups" WHERE id = $1`, [req.params.id]);
    const group = groupRows[0] && withHasLogo(groupRows[0]);
    if (!group) return res.status(404).json({ error: 'errors.groupNotFound' });
    res.json({ group, members: await loadGroupMembers(group.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadGroupMembers' });
  }
});

// POST /api/groups/:id/members: add one or more members.
//
// Every membership that actually lands is recorded as a change (see
// utils/groupMembership.js) in the same transaction, which is what lets a later
// update say who joined instead of re-sending the whole roster.
router.post('/:id/members', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { rows: groupRows } = await pool.query('SELECT * FROM "groups" WHERE id = $1', [req.params.id]);
    const group = groupRows[0];
    if (!group) return res.status(404).json({ error: 'errors.groupNotFound' });
    const ids = (req.body.memberIds || []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'errors.memberidsRequired' });

    // Real transaction: every membership insert and the change it implies commit
    // together.
    // ON CONFLICT (group_id, member_id) DO NOTHING is Postgres's equivalent of
    // SQLite's INSERT OR IGNORE: rowCount is the number actually added, exactly
    // like the old `.changes` total. A member who was already in the group is
    // therefore not a change, and is not recorded as one.
    let added = 0;
    const changes = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const memberId of ids) {
        const { rows: memberRows } = await client.query('SELECT id, name FROM members WHERE id = $1', [memberId]);
        if (!memberRows[0]) continue;
        const result = await client.query(
          'INSERT INTO group_members (group_id, member_id, role) VALUES ($1, $2, $3) ON CONFLICT (group_id, member_id) DO NOTHING',
          [group.id, memberId, 'member']
        );
        if (result.rowCount) {
          added += result.rowCount;
          changes.push({ action: 'added', memberId, name: memberRows[0].name, role: 'member' });
        }
      }
      await recordChanges(client, { groupId: group.id, actorId: req.user.id, changes });
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit({ userId: req.user.id, action: 'group_members_added', table: 'group_members', recordId: group.id, details: { added, ids }, ip: req.ip });
    res.json({ added });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedAddGroupMembers' });
  }
});

// DELETE /api/groups/:id/members/:memberId: remove a member from a group.
//
// The member's name is read BEFORE the row goes and stored on the change, so the
// removal stays reportable even after the member themselves is deleted (which
// cascades this row away): the update can then say who left instead of leaving a
// smaller count to be noticed later.
router.delete('/:id/members/:memberId', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { rows: groupRows } = await pool.query('SELECT * FROM "groups" WHERE id = $1', [req.params.id]);
    const group = groupRows[0];
    if (!group) return res.status(404).json({ error: 'errors.groupNotFound' });

    let removed = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: memberRows } = await client.query('SELECT id, name FROM members WHERE id = $1', [req.params.memberId]);
      const result = await client.query('DELETE FROM group_members WHERE group_id = $1 AND member_id = $2', [group.id, req.params.memberId]);
      removed = result.rowCount > 0;
      if (removed && memberRows[0]) {
        await recordChanges(client, {
          groupId: group.id,
          actorId: req.user.id,
          changes: [{ action: 'removed', memberId: Number(req.params.memberId), name: memberRows[0].name, role: null }],
        });
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit({ userId: req.user.id, action: 'group_member_removed', table: 'group_members', recordId: group.id, details: { memberId: req.params.memberId }, ip: req.ip });
    res.json({ success: true, removed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRemoveGroupMember' });
  }
});

// PATCH /api/groups/:id/members/:memberId: set role (leader/co-leader/member).
// A promotion is a change the pastor is told about, like a join or a departure:
// who leads a group is the part of a roster that is usually wanted first.
router.patch('/:id/members/:memberId', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!role || !MEMBER_ROLES.includes(role)) return res.status(400).json({ error: 'errors.invalidRole' });
    const { rows: groupRows } = await pool.query('SELECT * FROM "groups" WHERE id = $1', [req.params.id]);
    const group = groupRows[0];
    if (!group) return res.status(404).json({ error: 'errors.groupNotFound' });

    let changed = false;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: gmRows } = await client.query(
        'SELECT gm.id, gm.role, m.name FROM group_members gm JOIN members m ON m.id = gm.member_id WHERE gm.group_id = $1 AND gm.member_id = $2',
        [group.id, req.params.memberId]
      );
      const gm = gmRows[0];
      if (!gm) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'errors.memberNotGroup' });
      }
      // Re-assigning the role a member already has is not a change, and is not
      // recorded as one: the update would otherwise announce nothing.
      if (gm.role !== role) {
        await client.query('UPDATE group_members SET role = $1 WHERE id = $2', [role, gm.id]);
        await recordChanges(client, {
          groupId: group.id,
          actorId: req.user.id,
          changes: [{ action: 'role_changed', memberId: Number(req.params.memberId), name: gm.name, role }],
        });
        changed = true;
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ success: true, changed });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateGroupMemberRole' });
  }
});

// POST /api/groups/:id/notify-pastor: tell the pastor WHAT CHANGED in a group.
//
// What is sent: the changes recorded since the last update (see
// utils/groupMembership.js), as one factual line, and a link to the group's own
// page. What is deliberately NOT sent: the roster. A snapshot embedded in a
// message is stale the moment somebody leaves, and two updates from different
// days then contradict each other about how many members the group has, with
// nothing anywhere saying anyone left: the group's page is the single place that
// answers "who is in this group now", and the link goes there.
//
// TWO RECORDS, ONE EVENT, exactly like the daily digest: a broadcast message the
// pastor's Messages screen renders as a compact notice, and the in-app feed entry
// that drives the badge. The feed entry is therefore NOT counted twice when the
// badge is computed (see routes/messages.js: 'group_update' rows are excluded
// there for the same reason 'summary' rows are).
//
// ONE UPDATE, NOT A STREAM. Everything recorded before the press is reported
// together, and a press with nothing new writes NOTHING at all: claiming the
// changes and writing the message are one transaction, so a change is reported
// once and only once, and pressing twice cannot stack two permanent cards in the
// pastor's feed.
router.post('/:id/notify-pastor', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  // Group membership is administrative housekeeping, not a Pastor notification.
  // Keep this compatibility response so older clients fail closed rather than
  // creating a message, push, email, SMS, or in-app feed entry.
  return res.json({ sent: false, reason: 'membership_changes_are_not_pastor_notifications' });
  /* legacy notification path intentionally disabled
  try {
    const { rows: groupRows } = await pool.query('SELECT id, name, kind FROM "groups" WHERE id = $1', [req.params.id]);
    const group = groupRows[0];
    if (!group) return res.status(404).json({ error: 'errors.groupNotFound' });

    const { rows: pastors } = await pool.query("SELECT * FROM users WHERE role = 'pastor' AND is_active = 1 ORDER BY id ASC");
    // No pastor to tell: nothing is claimed and nothing is written. Marking the
    // changes as reported here would lose them silently: they were never sent.
    if (!pastors.length) {
      return res.json({ sent: false, reason: 'no_pastor', group: { id: group.id, name: group.name } });
    }

    let claimed = [];
    const written = [];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      claimed = await claimPendingChanges(client, group.id);
      if (claimed.length) {
        // One payload for every pastor: it is the RECORD (which group, what
        // changed), not the wording, so it reads the same in any language and the
        // app renders the line itself.
        const payload = JSON.stringify(buildChangePayload(group, claimed));
        for (const pastor of pastors) {
          // The change is sent by the front desk but read by the pastor, so the
          // words are the pastor's: an app set to Kiswahili gets a Kiswahili
          // update whoever sent it.
          const t = translator(pastor.language_pref || req.locale);
          const summary = buildChangeLine(t, group, claimed);
          const subject = t('group.subject', { name: group.name });
          // The message id comes back so the in-app entry can name it: an update
          // sent by mistake is then recallable as a whole, message and
          // notification together, see POST /api/messages/:id/recall.
          const { rows: sentRows } = await client.query(
            `INSERT INTO messages (sender_id, recipient_role, category, subject, body, payload)
             VALUES ($1, 'pastor', 'member_alert', $2, $3, $4) RETURNING id`,
            [req.user.id, subject, summary, payload]
          );
          await pushInApp(
            {
              to: pastor.email,
              message: summary,
              recordType: 'group_update',
              recordId: group.id,
              url: `/groups/${group.id}`,
              messageId: sentRows[0].id,
            },
            client
          );
          written.push({ pastor, subject, summary });
        }
      }
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    if (!claimed.length) {
      // Nothing has changed since the last update: no message, no feed card, and
      // the desk is told so rather than shown a "sent" that sent nothing.
      return res.json({ sent: false, reason: 'no_changes', group: { id: group.id, name: group.name } });
    }

    // External, non-transactional channels, after the commit: a slow or failed
    // gateway must never delay or undo an update the database has accepted. A
    // push failure just means the pastor is not pinged about a message they can
    // still read in the app.
    for (const { pastor, subject, summary } of written) {
      if (pastor.email) {
        sendEmail({ to: pastor.email, subject, text: summary, recordType: 'group_update', recordId: group.id }).catch(() => {});
      }
      if (pastor.phone) {
        sendSms({ to: pastor.phone, message: summary, recordType: 'group_update', recordId: group.id }).catch(() => {});
      }
      sendWebPush({ userId: pastor.id, title: subject, body: summary, url: `/groups/${group.id}`, recordType: 'group_update', recordId: group.id }).catch(() => {});
    }

    const summaryForSender = buildChangeLine(translator(req.locale), group, claimed);
    await logAudit({
      userId: req.user.id,
      action: 'group_notify_pastor',
      table: 'groups',
      recordId: group.id,
      details: { groupName: group.name, changeCount: claimed.length, actions: claimed.map((c) => c.action), pastors: pastors.length },
      ip: req.ip,
    });
    res.json({
      sent: true,
      group: { id: group.id, name: group.name },
      summary: summaryForSender,
      changeCount: claimed.length,
      changes: claimed.map((c) => ({ action: c.action, name: c.member_name, role: c.role || null })),
      url: `/groups/${group.id}`,
      pastors: pastors.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedNotifyPastor' });
  }
  */
});

// ---------------------------------------------------------------- logos ----

/**
 * What a logo file is allowed to be: decided by the file's own bytes, not by
 * its name or the browser's claimed content type. A renamed `.exe` whose first
 * bytes say PNG is still checked as PNG; a PNG with a `.jpg` name is accepted,
 * because the bytes are what will be served back.
 */
const LOGO_MIMES = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/webp': [0x52, 0x49, 0x46, 0x46], // 'RIFF': WEBP confirmed by bytes 8-11
  'image/gif': [0x47, 0x49, 0x46, 0x38], // 'GIF8'
};
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

function sniffLogoMime(buf) {
  for (const [mime, sig] of Object.entries(LOGO_MIMES)) {
    if (sig.every((byte, i) => buf[i] === byte)) {
      if (mime === 'image/webp') {
        return buf.length > 11 && buf.toString('ascii', 8, 12) === 'WEBP' ? mime : null;
      }
      return mime;
    }
  }
  return null;
}

async function logoTarget(req, res) {
  const { rows } = await pool.query('SELECT id FROM "groups" WHERE id = $1', [req.params.id]);
  if (!rows[0]) {
    res.status(404).json({ error: 'errors.groupNotFound' });
    return null;
  }
  return rows[0];
}

// PUT /api/groups/:id/logo: replace the group's logo with the uploaded bytes.
// Multipart rather than base64-in-JSON: a 1.5MB PNG inflated to base64 would
// sail past the 1mb express.json limit and triple in memory for nothing.
router.put('/:id/logo', logoUpload.single('logo'), logoUploadError, requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    if (!req.is('multipart/form-data')) return res.status(400).json({ error: 'errors.logoMultipartRequired' });
    const group = await logoTarget(req, res);
    if (!group) return;
    const file = req.file;
    if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ error: 'errors.logoFileRequired' });
    if (file.buffer.length > MAX_LOGO_BYTES) return res.status(413).json({ error: 'errors.logoTooLarge' });
    const mime = sniffLogoMime(file.buffer);
    if (!mime) return res.status(400).json({ error: 'errors.logoUnsupportedType' });

    await pool.query('UPDATE "groups" SET logo_data = $1, logo_mime = $2, logo_updated_at = $3 WHERE id = $4', [
      file.buffer,
      mime,
      new Date().toISOString(),
      group.id,
    ]);
    await logAudit({ userId: req.user.id, action: 'group_logo_set', table: 'groups', recordId: group.id, details: { mime, bytes: file.buffer.length }, ip: req.ip });
    res.json({ success: true, mime, bytes: file.buffer.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedSetGroupLogo' });
  }
});

// DELETE /api/groups/:id/logo: remove it. The three columns are nulled
// together, so `has_logo` can never disagree with the bytes.
router.delete('/:id/logo', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const group = await logoTarget(req, res);
    if (!group) return;
    await pool.query('UPDATE "groups" SET logo_data = NULL, logo_mime = NULL, logo_updated_at = NULL WHERE id = $1', [group.id]);
    await logAudit({ userId: req.user.id, action: 'group_logo_removed', table: 'groups', recordId: group.id, details: {}, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedRemoveGroupLogo' });
  }
});

// GET /api/groups/:id/logo: the bytes themselves, inlined for an <img>.
// Same auth as every other groups read (the logos belong to the members area),
// and immutable caching keyed on logo_updated_at, so a fresh upload is a new URL
// and every other device picks it up without a cache clear.
router.get('/:id/logo', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT logo_data, logo_mime, logo_updated_at FROM "groups" WHERE id = $1', [req.params.id]);
    const group = rows[0];
    if (!group || !group.logo_data) return res.status(404).json({ error: 'errors.groupLogoNotFound' });
    res.set('Content-Type', group.logo_mime || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(group.logo_data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadGroupLogo' });
  }
});

module.exports = router;
