const express = require('express');
const pool = require('../db/pg');
const { toParams } = require('../utils/sqlParams');
const { authenticate, requireRole } = require('../middleware/auth');
const { encryptField, decryptField } = require('../utils/crypto');
const { logAudit } = require('../utils/audit');
const { recordChanges } = require('../utils/groupMembership');
// The "is this the same person?" rules live in one module because the payment
// reconciliation workflow asks the same question of a bank statement line (see
// utils/identityMatch.js).
const { phoneDigits, samePhone, nameKey, sameName } = require('../utils/identityMatch');
// The number itself is shared with the boot migration and the matcher: it is the
// giving code a member quotes when they pay (see utils/memberNumbers.js).
const { nextMemberNo } = require('../utils/memberNumbers');

const router = express.Router();
router.use(authenticate);

const SELECT_BASE = `
  SELECT m.id, m.member_no, m.name, m.email, m.gender, m.date_joined, m.is_active, m.notes,
         m.revival_center_id, m.zone_id,
         rc.name AS center_name,
         cz.name AS zone_name,
         (SELECT string_agg(g.name, ', ' ORDER BY g.name)
            FROM group_members gm JOIN "groups" g ON g.id = gm.group_id
           WHERE gm.member_id = m.id) AS group_names,
         (SELECT COUNT(*) FROM group_members gm WHERE gm.member_id = m.id) AS group_count,
         (SELECT COALESCE(json_agg(json_build_object('id', g.id, 'name', g.name, 'has_logo', g.logo_mime IS NOT NULL) ORDER BY g.name), '[]'::json)
            FROM group_members gm JOIN "groups" g ON g.id = gm.group_id
           WHERE gm.member_id = m.id) AS member_groups
  FROM members m
  LEFT JOIN revival_centers rc ON rc.id = m.revival_center_id
  LEFT JOIN center_zones cz ON cz.id = m.zone_id
`;

/**
 * Reconciles one member's group memberships against the ids the caller sent.
 *
 * Membership is a property of the member, so it is written from here (the
 * Members screen) rather than group-by-group on the Groups screen, that screen
 * only reads the counts this produces. The rules are deliberately forgiving of
 * what already exists:
 *
 *   - a membership that stays keeps its role, so re-saving a member's details
 *     can never silently demote a group leader to a plain member;
 *   - a new membership starts as 'member';
 *   - a membership left out of the list is removed;
 *   - ids that are not real groups are ignored rather than failing the save, so
 *     a stale checkbox (a group deactivated in another tab) cannot block a
 *     member registration.
 *
 * Runs on the caller's connection so a member is never inserted with a roster
 * that only half applied.
 *
 * Every membership that actually appears or disappears is also recorded as a
 * group membership change (see utils/groupMembership.js), on the same
 * connection: this is the screen the front desk registers people from, so it is
 * where most of a group's changes really happen, and a change that was not
 * recorded here would be missing from the next update to the pastor.
 */
async function syncMemberGroups(client, memberId, groupIds, actorId) {
  const wanted = [...new Set((groupIds || []).map(Number).filter(Boolean))];
  let keep = [];
  if (wanted.length) {
    const ph = wanted.map((_, i) => `$${i + 1}`).join(',');
    const { rows: valid } = await client.query(`SELECT id FROM "groups" WHERE id IN (${ph})`, wanted);
    keep = valid.map((r) => r.id);
  }

  // The name is read here rather than passed in: this runs in the middle of a
  // registration or an edit, and the record must carry the member's name as it
  // stands: a rename and a roster change in one save must not disagree.
  const { rows: nameRows } = await client.query('SELECT name FROM members WHERE id = $1', [memberId]);
  const name = nameRows[0] ? nameRows[0].name : '';
  const { rows: before } = await client.query('SELECT group_id FROM group_members WHERE member_id = $1', [memberId]);
  const had = new Set(before.map((r) => r.group_id));

  const byGroup = new Map();
  const note = (groupId, change) => byGroup.set(groupId, [...(byGroup.get(groupId) || []), change]);
  for (const groupId of had) {
    if (!keep.includes(groupId)) note(groupId, { action: 'removed', memberId, name, role: null });
  }

  await client.query(
    'DELETE FROM group_members WHERE member_id = $1 AND group_id NOT IN (SELECT unnest($2::int[]))',
    [memberId, keep]
  );
  for (const groupId of keep) {
    const result = await client.query(
      'INSERT INTO group_members (group_id, member_id, role) VALUES ($1, $2, $3) ON CONFLICT (group_id, member_id) DO NOTHING',
      [groupId, memberId, 'member']
    );
    // rowCount 0 means they were already in it, which is not a change.
    if (result.rowCount) note(groupId, { action: 'added', memberId, name, role: 'member' });
  }

  for (const [groupId, changes] of byGroup) {
    await recordChanges(client, { groupId, actorId, changes });
  }
  return keep.length;
}

/**
 * Adds the decrypted `phone` to each row. The encrypted values are fetched for
 * all ids in one query (instead of a round-trip per row) and phone_enc never
 * reaches the response: only the decrypted `phone` field is added.
 */
async function decorateMany(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows: phoneRows } = await pool.query(`SELECT id, phone_enc FROM members WHERE id IN (${ph})`, ids);
  const byId = new Map(phoneRows.map((p) => [p.id, p.phone_enc]));
  return rows.map((r) => ({ ...r, phone: decryptField(byId.get(r.id)) || '' }));
}

async function validateZone(revivalCenterId, zoneId) {
  if (!zoneId) return true;
  const { rows } = await pool.query('SELECT * FROM center_zones WHERE id = $1', [zoneId]);
  const zone = rows[0];
  if (!zone) return 'errors.selectedZoneNotFound';
  if (revivalCenterId && zone.revival_center_id !== Number(revivalCenterId)) return 'errors.zoneNotInSelectedRevivalCenter';
  return true;
}

// ---- duplicate detection ---------------------------------------------------
//
// Registering the same person twice is the front desk's most common data-entry
// mistake, and the two identifiers are not equally trustworthy:
//
//   - an email address and a phone number belong to one person, so a repeat is
//     refused outright (see guardDuplicate below);
//   - a NAME does not. Two real, different members can share a common name, so
//     a name that matches an existing member is reported as a question the
//     caller must answer ('is this the same person?') rather than a wall. The
//     refusal lives on the server so a client cannot skip the question by
//     posting again, it has to send confirmNameDuplicate: true, which is what
//     the confirm dialog in the UI does.

/**
 * The member holding this email, if any. Email is stored normalized (lowercase,
 * trimmed), so this is a direct indexed comparison.
 */
async function findMemberByEmail(email, excludeId) {
  if (!email || !String(email).trim()) return null;
  const { rows } = await pool.query(
    'SELECT id, name, member_no FROM members WHERE email = $1 AND ($2::int IS NULL OR id <> $2)',
    [String(email).trim().toLowerCase(), excludeId ? Number(excludeId) : null]
  );
  return rows[0] || null;
}

/**
 * The member holding this phone number, if any. Phone numbers are encrypted at
 * rest, so they cannot be compared by an indexed equality: every stored number is
 * decrypted and compared with samePhone above. The set of numbers is small (the
 * church's own members), and only the id/name/number and ciphertext are read,
 * never more than one member's worth of profile data.
 */
async function findMemberByPhone(phone, excludeId) {
  if (!phoneDigits(phone)) return null;
  const { rows } = await pool.query(
    'SELECT id, name, member_no, phone_enc FROM members WHERE phone_enc IS NOT NULL ORDER BY id'
  );
  for (const row of rows) {
    if (excludeId && row.id === Number(excludeId)) continue;
    if (samePhone(decryptField(row.phone_enc), phone)) {
      return { id: row.id, name: row.name, member_no: row.member_no };
    }
  }
  return null;
}

/** Every active member whose name matches, for the soft 'is this the same person?' warning. */
async function findMembersByName(name, excludeId) {
  if (!nameKey(name)) return [];
  const { rows } = await pool.query(
    'SELECT id, name, member_no, is_active FROM members WHERE ($1::int IS NULL OR id <> $1) ORDER BY id',
    [excludeId ? Number(excludeId) : null]
  );
  return rows.filter((row) => row.is_active && sameName(row.name, name));
}

/**
 * The email/phone uniqueness wall. Returns the error payload to send, or null
 * when the caller may proceed.
 *
 * Order matters for the message the user reads: when BOTH identifiers point at
 * the same existing record this is a near-certain duplicate, so that case is
 * reported first and names the record found (the front desk can then go and look
 * the person up) instead of making the caller discover it one field at a time.
 */
async function duplicateIdentifierError({ email, phone, excludeId }) {
  const byEmail = await findMemberByEmail(email, excludeId);
  const byPhone = await findMemberByPhone(phone, excludeId);
  if (byEmail && byPhone) {
    return { status: 409, body: { error: 'errors.memberEmailPhoneAlreadyExists', code: 'duplicate_member', params: { name: byEmail.name, memberNo: byEmail.member_no || '' } } };
  }
  if (byEmail) {
    return { status: 409, body: { error: 'errors.memberEmailAlreadyExists', code: 'duplicate_email', params: { name: byEmail.name, memberNo: byEmail.member_no || '' } } };
  }
  if (byPhone) {
    return { status: 409, body: { error: 'errors.memberPhoneAlreadyExists', code: 'duplicate_phone', params: { name: byPhone.name, memberNo: byPhone.member_no || '' } } };
  }
  return null;
}

// GET /api/members?search=&centerId=&zoneId=&groupId=&active=&limit=
/**
 * The orderings the directory may ask for. A whitelist rather than interpolating
 * the caller's string: ORDER BY is the one part of this query PostgreSQL cannot
 * parameterize, so the value has to be chosen from a fixed set. An unknown key
 * falls back to the default instead of erroring: a stale client link should
 * still show a list.
 */
const MEMBER_SORTS = {
  recent: 'm.created_at DESC, m.id DESC',
  name: 'm.name ASC',
  name_desc: 'm.name DESC',
  number: 'm.member_no ASC NULLS LAST, m.name ASC',
};
const DEFAULT_MEMBER_SORT = 'recent';

router.get('/', async (req, res) => {
  try {
    const { search, centerId, zoneId, groupId, active, gender, limit, sort } = req.query;
    const clauses = [];
    const params = [];
    if (search && String(search).trim()) {
      const term = String(search).trim();
      const q = `%${term}%`;
      // ILIKE preserves the case-insensitive search SQLite's LIKE gave us.
      const parts = ['m.name ILIKE ?', 'm.member_no ILIKE ?', 'm.email ILIKE ?'];
      params.push(q, q, q);
      // A phone number is encrypted at rest, so it cannot be pattern-matched in
      // SQL, yet looking someone up by number is the front desk's most common
      // search. Anything carrying at least three digits is matched against the
      // decrypted numbers too, by the same scan the duplicate check uses (see
      // phoneDigits/samePhone). Three digits keeps a plain name from triggering
      // a full scan, and still narrows a directory to a handful of rows.
      const digits = phoneDigits(term);
      if (digits.length >= 3) {
        const { rows: phoneRows } = await pool.query('SELECT id, phone_enc FROM members WHERE phone_enc IS NOT NULL');
        const ids = phoneRows.filter((r) => phoneDigits(decryptField(r.phone_enc)).includes(digits)).map((r) => r.id);
        if (ids.length) {
          parts.push('m.id = ANY(?)');
          params.push(ids);
        }
      }
      clauses.push(`(${parts.join(' OR ')})`);
    }
    if (centerId) { clauses.push('m.revival_center_id = ?'); params.push(centerId); }
    if (zoneId) { clauses.push('m.zone_id = ?'); params.push(zoneId); }
    if (groupId) { clauses.push('m.id IN (SELECT member_id FROM group_members WHERE group_id = ?)'); params.push(groupId); }
    if (active === '1' || active === 'true') { clauses.push('m.is_active = 1'); }
    if (active === '0' || active === 'false') { clauses.push('m.is_active = 0'); }
    if (gender === 'male' || gender === 'female' || gender === 'other') {
      clauses.push('m.gender = ?');
      params.push(gender);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sortKey = MEMBER_SORTS[sort] ? sort : DEFAULT_MEMBER_SORT;
    const sql = toParams(`${SELECT_BASE} ${where} ORDER BY ${MEMBER_SORTS[sortKey]} LIMIT ${Math.min(Number(limit) || 200, 500)}`);
    const { rows } = await pool.query(sql, params);

    // Two counts, both honest about what they measure: `total` is what matches
    // the filters currently applied (the number of rows the list is showing,
    // however the limit truncates them) and `grandTotal` is the whole
    // directory. The header shows "N of M" when they differ, so a filtered
    // count can never read as the size of the church.
    const { rows: countRows } = await pool.query(toParams(`SELECT COUNT(*)::int AS n FROM members m ${where}`), params);
    const { rows: allRows } = await pool.query('SELECT COUNT(*)::int AS n FROM members');
    res.json({ members: await decorateMany(rows), total: countRows[0].n, grandTotal: allRows[0].n, sort: sortKey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadMembers' });
  }
});

// POST /api/members: create a member. Receptionists register members at the
// front desk / at a revival center, so they are allowed here alongside admins.
router.post('/', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { name, phone, email, gender, dateJoined, revivalCenterId, zoneId, notes, isActive, groupIds, confirmNameDuplicate } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'errors.nameRequired' });

    // Strict on the identifiers that belong to exactly one person.
    const dup = await duplicateIdentifierError({ email, phone });
    if (dup) return res.status(dup.status).json(dup.body);

    // Soft on the name. Answered once: the caller resends with
    // confirmNameDuplicate: true after the front desk says "yes, a different
    // person", and the member is then registered normally.
    if (!confirmNameDuplicate) {
      const nameMatches = await findMembersByName(name);
      if (nameMatches.length) {
        return res.status(409).json({
          error: nameMatches.length === 1 ? 'errors.memberNameSimilarExists' : 'errors.memberNameSimilarExistsPlural',
          code: 'duplicate_name',
          params: { name: nameMatches[0].name, count: nameMatches.length },
          duplicates: nameMatches.map((m) => ({ id: m.id, name: m.name, memberNo: m.member_no || '' })),
        });
      }
    }

    const zoneErr = await validateZone(revivalCenterId, zoneId);
    if (zoneErr !== true) return res.status(400).json({ error: zoneErr });
    if (revivalCenterId) {
      const { rows: centerRows } = await pool.query('SELECT id FROM revival_centers WHERE id = $1', [revivalCenterId]);
      if (!centerRows[0]) return res.status(400).json({ error: 'errors.revivalCenterNotFound' });
    }
    if (zoneId) {
      const { rows: zoneRows } = await pool.query('SELECT id FROM center_zones WHERE id = $1', [zoneId]);
      if (!zoneRows[0]) return res.status(400).json({ error: 'errors.zoneNotFound' });
    }

    // Allocated from the shared allocator (utils/memberNumbers.js), so the code
    // the form hands out is one the reconciliation matcher recognises.
    const memberNo = await nextMemberNo();
    // The member row and the groups chosen with it are one unit of work: a
    // member registered into "Harvest Choir" must not exist without the choir.
    let id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: inserted } = await client.query(
        `INSERT INTO members (member_no, name, phone_enc, email, gender, date_joined, revival_center_id, zone_id, notes, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          memberNo,
          String(name).trim(),
          phone ? encryptField(String(phone).trim()) : null,
          email ? String(email).trim().toLowerCase() : null,
          gender || null,
          dateJoined || null,
          revivalCenterId || null,
          zoneId || null,
          notes || null,
          isActive === false ? 0 : 1,
        ]
      );
      id = inserted[0].id;
      if (Array.isArray(groupIds)) await syncMemberGroups(client, id, groupIds, req.user.id);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    await logAudit({ userId: req.user.id, action: 'member_created', table: 'members', recordId: id, details: { name, groupIds: Array.isArray(groupIds) ? groupIds : undefined }, ip: req.ip });
    const { rows: created } = await pool.query(`${SELECT_BASE} WHERE m.id = $1`, [id]);
    const [member] = await decorateMany(created);
    res.status(201).json({ member });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedCreateMember' });
  }
});

// GET /api/members/:id: one member with attendance/offering/group activity.
// Feeding a full member profile (summary, groups, attendance and giving
// history) from one request keeps the roster's row click a single call.
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(`${SELECT_BASE} WHERE m.id = $1`, [req.params.id]);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'errors.memberNotFound' });

    const { rows: groups } = await pool.query(
      'SELECT g.id, g.name, g.logo_mime IS NOT NULL AS has_logo, gm.role, gm.joined_at FROM group_members gm JOIN "groups" g ON g.id = gm.group_id WHERE gm.member_id = $1 ORDER BY g.name',
      [row.id]
    );
    // The 90-day window mirrors SQLite's date('now','-90 days'), kept as the
    // same TEXT 'YYYY-MM-DD' comparison against the services.date column.
    const { rows: attendanceRows } = await pool.query(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(a.count), 0) AS total
       FROM (
         SELECT DISTINCT a.id, a.count
         FROM attendance a
         JOIN attendance_attendees aa ON aa.attendance_id = a.id
         JOIN services s ON s.id = a.service_id
         WHERE aa.member_id = $1 AND s.date >= to_char(now() - interval '90 days', 'YYYY-MM-DD') AND a.voided_at IS NULL
       ) a`,
      [row.id]
    );
    const { rows: offeringRows } = await pool.query(
      'SELECT COUNT(*) AS gifts, COALESCE(SUM(amount),0) AS total FROM offerings WHERE member_id = $1 AND voided_at IS NULL',
      [row.id]
    );

    // The last handful of real records behind the totals above, so the member
    // profile can show history rather than only counts. DISTINCT mirrors the
    // stats query: one row per attendance record however many attendee rows
    // point at it.
    const { rows: attendanceHistory } = await pool.query(
      `SELECT DISTINCT a.id, s.date, s.name AS service_name, st.name AS service_type_name,
              a.count, a.mode, g.name AS group_name
       FROM attendance a
       JOIN attendance_attendees aa ON aa.attendance_id = a.id
       JOIN services s ON s.id = a.service_id
       LEFT JOIN service_types st ON st.id = s.service_type_id
       LEFT JOIN "groups" g ON g.id = a.group_id
       WHERE aa.member_id = $1 AND a.voided_at IS NULL
       ORDER BY s.date DESC, a.id DESC
       LIMIT 20`,
      [row.id]
    );
    const { rows: offeringHistory } = await pool.query(
      `SELECT o.id, o.timestamp, o.type, o.amount, o.currency, o.receipt_number,
              oc.name AS category_name, s.date AS service_date, s.name AS service_name
       FROM offerings o
       LEFT JOIN offering_categories oc ON oc.id = o.category_id
       LEFT JOIN services s ON s.id = o.service_id
       WHERE o.member_id = $1 AND o.voided_at IS NULL
       ORDER BY o.timestamp DESC, o.id DESC
       LIMIT 20`,
      [row.id]
    );

    const [member] = await decorateMany([row]);
    res.json({
      member,
      groups,
      stats: { attendance: attendanceRows[0], offerings: offeringRows[0] },
      history: { attendance: attendanceHistory, offerings: offeringHistory },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedLoadMember' });
  }
});

// PATCH /api/members/:id: update fields. Receptionists may correct the details
// of a member they registered, but member lifecycle (activate/deactivate) stays
// with admins: enforced below, not just hidden in the UI.
router.patch('/:id', requireRole('receptionist', 'admin', 'superadmin'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
    const existing = rows[0];
    if (!existing) return res.status(404).json({ error: 'errors.memberNotFound' });

    const { name, phone, email, gender, dateJoined, revivalCenterId, zoneId, notes, isActive, groupIds } = req.body;
    if (req.user.role === 'receptionist' && isActive !== undefined) {
      return res.status(403).json({ error: 'errors.onlyAdminActivateDeactivateMember' });
    }
    if (name !== undefined && !String(name).trim()) return res.status(400).json({ error: 'errors.nameCannotEmpty' });
    // An edit must not be a way around the wall: moving member B onto member A's
    // email or phone number would create exactly the duplicate the registration
    // form refuses. The member's own current values are excluded (excludeId).
    const dup = await duplicateIdentifierError({
      email: email !== undefined ? email : existing.email,
      phone: phone !== undefined ? phone : decryptField(existing.phone_enc),
      excludeId: existing.id,
    });
    if (dup) return res.status(dup.status).json(dup.body);
    const newCenter = revivalCenterId !== undefined ? revivalCenterId : existing.revival_center_id;
    const newZone = zoneId !== undefined ? zoneId : existing.zone_id;
    const zoneErr = await validateZone(newCenter, newZone);
    if (zoneErr !== true) return res.status(400).json({ error: zoneErr });

    // An office is held IN a zone, and the API refuses to hand one to somebody
    // filed elsewhere. Moving a member OUT of the zone they lead, or out of its
    // center, or unfiling them, would produce that same state by another door,
    // so a move cannot silently strand an office either. The admin removes the
    // office first; the app will not decide for them whose office to drop.
    const asId = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    if (asId(newZone) !== asId(existing.zone_id)) {
      const { rows: offices } = await pool.query(
        `SELECT z.name AS zone, c.name AS center
           FROM center_zone_leaders l
           JOIN center_zones z ON z.id = l.zone_id
           JOIN revival_centers c ON c.id = z.revival_center_id
          WHERE l.member_id = $1 AND ($2::int IS NULL OR z.id <> $2::int)
          ORDER BY z.id`,
        [existing.id, asId(newZone)]
      );
      if (offices.length) {
        return res.status(400).json({
          error: 'errors.memberLeadsZone',
          params: { zone: offices[0].zone, center: offices[0].center },
        });
      }
    }

    await pool.query(
      `UPDATE members SET
         name = $1, phone_enc = $2, email = $3, gender = $4, date_joined = $5,
         revival_center_id = $6, zone_id = $7, notes = $8, is_active = $9,
         updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = $10`,
      [
        name !== undefined ? String(name).trim() : existing.name,
        phone !== undefined ? (phone ? encryptField(String(phone).trim()) : null) : existing.phone_enc,
        email !== undefined ? (email ? String(email).trim().toLowerCase() : null) : existing.email,
        gender !== undefined ? gender : existing.gender,
        dateJoined !== undefined ? dateJoined : existing.date_joined,
        newCenter,
        newZone,
        notes !== undefined ? notes : existing.notes,
        isActive !== undefined ? (isActive === false ? 0 : 1) : existing.is_active,
        existing.id,
      ]
    );

    // Only touched when the caller actually sent a group list, so the activate/
    // deactivate toggle (which posts just isActive) cannot wipe a roster.
    if (Array.isArray(groupIds)) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await syncMemberGroups(client, existing.id, groupIds, req.user.id);
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK');
        throw txErr;
      } finally {
        client.release();
      }
    }

    await logAudit({ userId: req.user.id, action: 'member_updated', table: 'members', recordId: existing.id, details: { name: name || existing.name, groupIds: Array.isArray(groupIds) ? groupIds : undefined }, ip: req.ip });
    const { rows: updatedRows } = await pool.query(`${SELECT_BASE} WHERE m.id = $1`, [existing.id]);
    const [member] = await decorateMany(updatedRows);
    res.json({ member });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedUpdateMember' });
  }
});

// DELETE /api/members/:id: remove a member, or deactivate them when they have
// history.
//
// Attendance, offerings and pledges all reference a member by id, and that is
// the point: the records must keep naming the person they belong to. So a member
// who has ever attended, given or pledged is NOT deleted: deactivating keeps
// every past figure attributed while taking them off the active roster (the
// Members list already shows inactive members dimmed, and every picker filters
// on is_active). A member with no history at all is genuinely removable, and is
// removed outright, which is the only case where nothing can be orphaned.
//
// The response says which of the two happened, so the UI can report it honestly
// rather than claiming a deletion that did not occur.
router.delete('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'errors.invalidMemberId' });

    const { rows } = await pool.query('SELECT * FROM members WHERE id = $1', [id]);
    const member = rows[0];
    if (!member) return res.status(404).json({ error: 'errors.memberNotFound' });

    // Everything that would be orphaned by a hard delete, counted in one place
    // so the reason reported to the user is the real one.
    const history = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS n FROM attendance_attendees WHERE member_id = $1', [id]),
      pool.query('SELECT COUNT(*)::int AS n FROM offerings WHERE member_id = $1', [id]),
      pool.query('SELECT COUNT(*)::int AS n FROM project_pledges WHERE member_id = $1', [id]),
    ]);
    const counts = {
      attendance: history[0].rows[0].n,
      offerings: history[1].rows[0].n,
      pledges: history[2].rows[0].n,
    };
    const total = counts.attendance + counts.offerings + counts.pledges;

    if (total > 0) {
      // Soft delete: deactivate, keep every record pointing at the member.
      await pool.query(
        "UPDATE members SET is_active = 0, updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS') WHERE id = $1",
        [id]
      );
      await logAudit({ userId: req.user.id, action: 'member_deactivated', table: 'members', recordId: id, details: { name: member.name, reason: 'has_history', counts }, ip: req.ip });
      return res.json({ success: true, deactivated: true, history: counts });
    }

    // No history anywhere: the FK-safe case, so the row can go. Group rosters are
    // not history: they are a current membership list, so they are cleared in
    // the same transaction rather than blocking the delete.
    //
    // Deleting a member is also the one way a group can lose somebody WITHOUT
    // anybody editing the group: their group_members rows cascade away with them.
    // So the groups they were in are read first and each one gets a 'removed'
    // change, otherwise the group silently shrinks and the next update to the
    // pastor has nothing to explain why (which is exactly how a feed ends up
    // claiming a group had more members last week than it has now).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: memberships } = await client.query('SELECT group_id FROM group_members WHERE member_id = $1', [id]);
      for (const membership of memberships) {
        await recordChanges(client, {
          groupId: membership.group_id,
          actorId: req.user.id,
          changes: [{ action: 'removed', memberId: id, name: member.name, role: null }],
        });
      }
      await client.query('DELETE FROM group_members WHERE member_id = $1', [id]);
      await client.query('DELETE FROM members WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }
    await logAudit({ userId: req.user.id, action: 'member_deleted', table: 'members', recordId: id, details: { name: member.name, memberNo: member.member_no }, ip: req.ip });
    res.json({ success: true, deleted: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'errors.failedDeleteMember' });
  }
});

module.exports = router;
