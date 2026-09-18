/**
 * The jobs a zone leader can hold.
 *
 * These are SUGGESTIONS, not a fixed set: a leader's role is free text in the
 * database (center_zone_leaders.role_name), so a church that calls the job
 * something else types it and it works, with no migration and no deploy. What
 * this list buys is that the roles a church is most likely to need are offered
 * in the reader's own language instead of having to be spelled out by hand.
 *
 * The trade-off worth knowing: a role is stored as the words the admin chose, so
 * a church that assigns roles in Kiswahili and reads the app in English sees the
 * Kiswahili words. Making one role read as "Deacon" in one language and "Shemasi"
 * in the other would mean storing a canonical code per role instead, a roles
 * table, or slugs like these keys, which is the upgrade path if it is ever
 * wanted. Custom roles are untranslatable in any design.
 */
export const ROLE_SUGGESTIONS = ['deacon', 'treasurer', 'secretary', 'leader'];

/** What holds a role to put in front of a name. */
export function roleLabel(t, roleName) {
  const text = String(roleName || '').trim();
  // Rows written before roles existed carry no role. Saying "Leader" is honest;
  // inventing a job for somebody would not be.
  return text || t('centers.zoneRoleUnnamed');
}

/**
 * The label a person's role should be shown under: 'Deacon: Elisha Makala'.
 *
 * Kept here rather than in one screen because the zone header, the assign chips
 * and the center roll-up must agree word for word: this is one fact.
 */
export function leadersWithRoles(t, leaders) {
  return (leaders || []).map((l) => `${roleLabel(t, l.roleName ?? l.role_name)}: ${l.name}`);
}

/**
 * '' when this office is held by somebody filed in the zone, or by somebody the
 * API does not place anywhere, otherwise the words to mark the mismatch.
 *
 * An office is supposed to be held by a member OF the zone it is held in, and
 * the app no longer lets a new one be handed to anybody else. Rows written
 * before that rule existed can still be out of step with it, though, and the
 * honest response is to show the admin rather than to either hide it or quietly
 * rewrite their assignment. This is why the API reports each leader's own
 * member_zone_id: so every surface can say the same thing about it.
 *
 * Null (a member filed nowhere, or a leader read before the zone was known) is
 * not a mismatch: there is nothing to compare, and claiming a conflict that the
 * data does not show would be worse than saying nothing.
 */
export function zoneMismatch(t, leader, zoneId) {
  const filed = leader.memberZoneId ?? leader.member_zone_id;
  if (filed == null || zoneId == null || Number(filed) === Number(zoneId)) return '';
  return t('centers.leaderNotInZone');
}
