'use strict';
/**
 * A group's membership CHANGES, and the update built from them.
 *
 * The one place that knows what a membership change is (`added`, `removed`,
 * `role_changed`), where it is recorded, and how it is described to the pastor.
 * Routes write changes through this module and read pending ones through it, so
 * the wording of an update and the record it is built from cannot drift apart.
 *
 * WHAT THIS IS NOT: an answer to "who is in this group now". That is
 * group_members, and nothing here is joined into a roster, a count or a picker.
 * This module exists because a current membership list cannot say what CHANGED,
 * and an update that carries a snapshot of the roster instead contradicts itself
 * the moment anybody leaves: an older card claims more members than a newer one,
 * with no card anywhere saying someone left (see db/schema.sql).
 *
 * The update the pastor receives is therefore a line or two about the change,
 * plus a link to the group's own page: whoever wants the full membership follows
 * the link and reads it where it is true, which is the point.
 */
const ACTIONS = ['added', 'removed', 'role_changed'];

/**
 * Records membership changes on the caller's connection.
 *
 * Required rather than optional: a change is only ever written in the same
 * transaction as the membership write it describes, so the record cannot claim
 * something the roster never did (or miss something it did). Each change is
 * `{ action, memberId, name, role }`; `name` is stored on the row, so a change
 * stays readable after the member is deleted.
 */
async function recordChanges(client, { groupId, actorId, changes }) {
  const rows = (changes || []).filter((c) => c && ACTIONS.includes(c.action) && c.name);
  if (!rows.length) return 0;
  for (const change of rows) {
    await client.query(
      `INSERT INTO group_member_events (group_id, member_id, member_name, action, role, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [groupId, change.memberId || null, String(change.name), change.action, change.role || null, actorId || null]
    );
  }
  return rows.length;
}

/**
 * Claims this group's unreported changes, atomically, and returns them.
 *
 * One statement rather than a SELECT followed by an UPDATE: the row lock the
 * UPDATE takes means two updates triggered at the same moment cannot both be
 * handed the same changes, so the same change is never reported twice. A caller
 * that claims nothing has nothing to report and must send nothing at all.
 *
 * Called inside the transaction that writes the message, so a failure on the way
 * releases the claim with it and the changes stay unreported for the next try.
 */
async function claimPendingChanges(client, groupId) {
  const { rows } = await client.query(
    `UPDATE group_member_events
        SET reported_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      WHERE group_id = $1 AND reported_at IS NULL
     RETURNING id, member_id, member_name, action, role, at`,
    [groupId]
  );
  // RETURNING follows no particular order, and the line reads as a story, so the
  // changes are sorted the way they happened: oldest first, by id within the same
  // second (these rows are written in order).
  return rows.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id));
}

/**
 * The change as a phrase in the reader's language: "Bahati Yunus Mkwizu added",
 * "2 members added", "Asha M is now a leader".
 *
 * A single addition is named, because one name is the whole news. Several are
 * counted rather than listed: the names of everyone who joined are exactly the
 * roster this update no longer embeds, and the link is one tap away.
 */
function buildChangeLine(t, group, changes) {
  const of = (action) => changes.filter((c) => c.action === action);
  const added = of('added');
  const removed = of('removed');
  const phrases = [];

  if (added.length === 1) phrases.push(t('group.changeAdded', { member: added[0].member_name }));
  else if (added.length > 1) phrases.push(t('group.changeAddedMany', { count: added.length }));

  if (removed.length === 1) phrases.push(t('group.changeRemoved', { member: removed[0].member_name }));
  else if (removed.length > 1) phrases.push(t('group.changeRemovedMany', { count: removed.length }));

  for (const change of of('role_changed')) {
    phrases.push(t('group.changeRole', { member: change.member_name, role: t(`group.role_${change.role || 'member'}`) }));
  }

  return t('group.changeSummary', { name: group.name, changes: phrases.join(', ') });
}

/**
 * The message payload: WHICH group, and WHAT changed. Never who is in it.
 *
 * `changes` is the delta the line is built from, so a client can render the
 * update in the interface language rather than in the language the server
 * happened to write it in; `url` is the link to the group's own page, where the
 * current membership is read.
 */
function buildChangePayload(group, changes) {
  return {
    group: { id: group.id, name: group.name, kind: group.kind },
    changes: changes.map((c) => ({ action: c.action, name: c.member_name, role: c.role || null })),
    url: `/groups/${group.id}`,
  };
}

/**
 * Every group the given member currently belongs to, as `{ group_id, name }`.
 *
 * Read before their memberships are cleared, so a member who is being deleted
 * (which cascades their group_members rows away) can still be reported as having
 * left each group.
 */
async function groupsOfMember(client, memberId) {
  const { rows } = await client.query(
    `SELECT gm.group_id, g.name AS group_name FROM group_members gm
       JOIN "groups" g ON g.id = gm.group_id
      WHERE gm.member_id = $1`,
    [memberId]
  );
  return rows;
}

module.exports = { ACTIONS, buildChangeLine, buildChangePayload, claimPendingChanges, groupsOfMember, recordChanges };
