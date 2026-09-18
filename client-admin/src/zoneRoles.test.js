import { describe, it, expect } from 'vitest';
import i18n from './i18n';
import { ROLE_SUGGESTIONS, roleLabel, leadersWithRoles, zoneMismatch } from './zoneRoles';

// The real catalogs, so this fails if a suggestion is offered that the reader
// would see as a raw key.
const t = (key, params) => i18n.t(key, params);

describe('zone roles', () => {
  it('offers the offices a church most often needs, and no raw keys', () => {
    expect(ROLE_SUGGESTIONS).toEqual(['deacon', 'treasurer', 'secretary', 'leader']);
    for (const role of ROLE_SUGGESTIONS) {
      const label = t(`centers.roleSuggestion_${role}`);
      expect(label).not.toMatch(/^centers\./);
      expect(label.trim().length).toBeGreaterThan(0);
    }
  });

  it('shows a role exactly as the church wrote it, including one nobody coded', () => {
    // Roles are free text: a church that calls the job something else typed it,
    // and that is what it must read back.
    expect(roleLabel(t, 'Deacon')).toBe('Deacon');
    expect(roleLabel(t, 'Youth coordinator')).toBe('Youth coordinator');
    expect(roleLabel(t, '  Treasurer  ')).toBe('Treasurer');
  });

  it('calls a bearer with no recorded role a plain Leader rather than inventing a job', () => {
    // Rows written before roles existed carry ''. Naming a job they were never
    // given would be a lie about a real person.
    expect(roleLabel(t, '')).toBe('Leader');
    expect(roleLabel(t, null)).toBe('Leader');
    expect(roleLabel(t, undefined)).toBe('Leader');
    expect(roleLabel(t, '   ')).toBe('Leader');
  });

  it('labels each leader with their office', () => {
    const leaders = [
      { name: 'Elisha Makala', role_name: 'Deacon' },
      { name: 'Asha Kiongozi', role_name: '' },
    ];
    expect(leadersWithRoles(t, leaders)).toEqual(['Deacon: Elisha Makala', 'Leader: Asha Kiongozi']);
    expect(leadersWithRoles(t, [])).toEqual([]);
    expect(leadersWithRoles(t, undefined)).toEqual([]);
  });

  it('marks an office held by somebody filed outside the zone, and only then', () => {
    // A leader belongs to the zone they lead. Rows written before that rule can
    // still disagree with it, and every surface marks them the same way.
    expect(zoneMismatch(t, { name: 'X', memberZoneId: 11 }, 11)).toBe('');
    expect(zoneMismatch(t, { name: 'X', memberZoneId: 12 }, 11)).toBe('not in this zone');
    // Ids arrive as strings over JSON at least as often as numbers.
    expect(zoneMismatch(t, { name: 'X', member_zone_id: '12' }, 11)).toBe('not in this zone');
    // Filed nowhere, or a leader read before the zone is known: there is nothing
    // to compare, and claiming a conflict the data does not show is worse than
    // saying nothing.
    expect(zoneMismatch(t, { name: 'X', memberZoneId: null }, 11)).toBe('');
    expect(zoneMismatch(t, { name: 'X' }, null)).toBe('');
  });

  it('answers in the reader’s language', async () => {
    await i18n.changeLanguage('sw');
    try {
      expect(t('centers.roleSuggestion_treasurer')).toBe('Mweka hazina');
      expect(roleLabel(t, '')).toBe('Kiongozi');
      expect(leadersWithRoles(t, [{ name: 'Ruth Mwenza', role_name: 'Katibu' }])).toEqual(['Katibu: Ruth Mwenza']);
      expect(zoneMismatch(t, { memberZoneId: 12 }, 11)).toBe('hayupo katika eneo hili');
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});
