import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Mail, MapPin, Phone, Search, ShieldCheck, UserRound } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import StatusBanner from './StatusBanner';
import GroupLogo from './GroupLogo';
import MemberProfile from './MemberProfile';
import MemberLink from './MemberLink';
import { leadersWithRoles, zoneMismatch } from '../zoneRoles';

// The roster is a read, never a write: every member field is registered and
// edited on the Members screen, which owns those facts. This panel exists so a
// center's row can answer "who is filed here?", each person down to their full
// profile, without sending the reader to another screen and back.
//
// Results are tagged with the center they came from (and the parent keys this
// panel by center), so a slow response for one center can never be drawn under
// another, and switching centers needs no state reset.
//
// A center is organised BY ZONE, registration files every member under a center
// and a zone, so the roster is grouped the same way rather than flattened into
// one list where a zone is a word repeated on every row. The rows themselves are
// unchanged: this is a grouping, not a second list design.
const ROSTER_LIMIT = 500;

/**
 * Who is in each zone of this center.
 *
 * Keyed by zone ID, not by name: a zone renamed last week still owns the members
 * it had, and two centers may legitimately have a zone of the same name.
 *
 * Every zone the center has gets a section whether or not anybody is in it. An
 * empty zone is a fact about the center, the zone exists and nobody is filed
 * there yet, and a section that silently disappears looks like a bug rather
 * than like an empty zone.
 *
 * A section made from a real zone also names the members who lead it and what
 * they are in charge of, which is the one thing about a zone the Members screen
 * cannot tell you: who is answerable for the people in it, and for what.
 */
function sectionsOf(members, zones) {
  const buckets = new Map(zones.map((z) => [z.id, []]));
  const unzoned = [];
  // A member whose zone is not in the center's list, assigned before the zone
  // was renamed out of the response, or filed with no zone at all, must still
  // be visible. Nobody is ever dropped from a roster.
  const strays = new Map();

  for (const m of members) {
    if (m.zone_id != null && buckets.has(m.zone_id)) {
      buckets.get(m.zone_id).push(m);
    } else if (m.zone_id != null) {
      const bucket = strays.get(m.zone_id) || [];
      bucket.push(m);
      strays.set(m.zone_id, bucket);
    } else {
      unzoned.push(m);
    }
  }

  return [
    // A section made from the center's own zone list carries the zone itself, so
    // it can say who leads it. The two catch-all sections below have no zone
    // record to read a leader from and so claim nothing about one.
    ...zones.map((z) => ({
      id: `zone-${z.id}`,
      name: z.name,
      inactive: !z.is_active,
      zone: z,
      leaders: z.leaders || [],
      members: buckets.get(z.id),
    })),
    ...[...strays].map(([zoneId, list]) => ({
      id: `zone-${zoneId}`,
      name: list[0].zone_name || null,
      inactive: false,
      zone: null,
      leaders: [],
      members: list,
    })),
    ...(unzoned.length
      ? [{ id: 'zone-none', name: null, inactive: false, zone: null, leaders: [], members: unzoned }]
      : []),
  ];
}

/**
 * 'Deacon: Elisha Makala · Treasurer: Bahati Mkwizu'.
 *
 * Each leader is labelled with the job they hold, because a bare list of names
 * leaves the reader unable to tell who is in charge of what, and a leader who
 * has since been deactivated is marked here, where a name could otherwise be
 * read as current.
 *
 * So is one filed in another zone: the roster lists this zone's members right
 * beneath the header, so a leader's name that appears nowhere in the list under
 * it is exactly the contradiction this roster exists to stop.
 */
function zoneLeaderLine(t, leaders, zoneId) {
  return leadersWithRoles(
    t,
    leaders.map((l) => ({
      ...l,
      name: [
        l.name,
        Number(l.is_active) === 0 ? `(${t('members.inactive')})` : null,
        zoneMismatch(t, l, zoneId) ? `(${zoneMismatch(t, l, zoneId)})` : null,
      ]
        .filter(Boolean)
        .join(' '),
    }))
  ).join(' · ');
}

export default function CenterRoster({ centerId, memberCount, zones = [] }) {
  const { t } = useTranslation();
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('');
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let alive = true;
    api
      .get('/members', { params: { centerId, limit: ROSTER_LIMIT } })
      .then(({ data }) => { if (alive) setResult({ centerId, members: data.members }); })
      .catch((err) => { if (alive) setResult({ centerId, error: apiErrorMessage(err) }); });
    return () => { alive = false; };
  }, [centerId]);

  const current = result && result.centerId === centerId ? result : null;

  if (current?.error) {
    return (
      <div className="border-t border-ink-100 p-4">
        <StatusBanner type="error" message={current.error} />
      </div>
    );
  }

  if (!current) {
    return <p className="border-t border-ink-100 p-4 text-sm text-ink-400">{t('common.loading')}</p>;
  }

  const members = current.members || [];
  const needle = filter.trim().toLowerCase();
  const searching = needle.length > 0;
  // The load is capped, so a center bigger than that cap must say so rather
  // than quietly showing a partial roster that looks complete.
  const truncated = Number(memberCount) > members.length;

  const label = (name) => (name || t('centers.rosterNoZone'));

  // Filtering narrows within each zone and drops a section with nothing left to
  // show, so a search does not scroll past five empty zones to reach a hit.
  const sections = sectionsOf(members, zones).map((section) => ({
    ...section,
    shown: searching ? section.members.filter((m) => m.name.toLowerCase().includes(needle)) : section.members,
  }));
  const visible = searching ? sections.filter((s) => s.shown.length > 0) : sections;

  return (
    <div className="border-t border-ink-100 p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">{t('centers.rosterTitle')}</h3>
          <span className="cat-chip category-people">{members.length}</span>
        </div>
        {members.length > 3 && (
          <div className="relative sm:w-56">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('centers.rosterFilter')}
              aria-label={t('centers.rosterFilter')}
              className="w-full rounded-md border border-ink-200 py-1.5 pl-8 pr-2 text-sm focus-visible:border-brand-600"
            />
          </div>
        )}
      </div>

      <p className="mb-2 text-xs text-ink-400">{t('centers.rosterHint')}</p>
      {truncated && (
        <p className="mb-2 text-xs font-medium text-amber-700">
          {t('centers.rosterTruncated', { shown: members.length, total: memberCount })}
        </p>
      )}

      {visible.length === 0 ? (
        // Only one of two things can empty the panel: a name that matches
        // nobody, or a center with no zones and nobody in it. There is no
        // "somebody is here but nothing is shown" state left to fall through.
        <p className="text-sm text-ink-400">
          {searching && members.length > 0 ? t('centers.rosterNoMatch') : t('centers.rosterEmpty')}
        </p>
      ) : (
        <div className="max-h-[32rem] space-y-3 overflow-y-auto pr-1">
          {visible.map((section) => (
            <section key={section.id} className="overflow-hidden rounded-lg border border-ink-200 bg-paper">
              <div className="flex flex-wrap items-center gap-2 border-b border-ink-100 bg-ink-50/60 px-3 py-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-700">{label(section.name)}</h4>
                <span aria-hidden="true" className="text-ink-300">·</span>
                {/* The zone's real size, not the number of rows a filter left
                    showing: a header that says "6 members" and then lists one is
                    a lie about the zone. */}
                <span className="cat-chip category-people">{t('centers.zoneMembers', { count: section.members.length })}</span>
                {section.inactive && <span className="cat-chip category-amber">{t('centers.disabled')}</span>}
                {/* Who is responsible for the people in this zone: several
                    people, if the zone is led by more than one. An unled zone
                    says so: that is a gap somebody should fill, not a fact to
                    hide by leaving the line out. */}
                {section.zone && (
                  <span className="inline-flex flex-wrap items-center gap-1 text-xs text-ink-500">
                    <ShieldCheck size={11} className="text-ink-400" />
                    {section.leaders.length
                      ? zoneLeaderLine(t, section.leaders, section.zone.id)
                      : t('centers.zoneNoLeader')}
                  </span>
                )}
              </div>

              {section.shown.length === 0 ? (
                <p className="px-3 py-2.5 text-sm text-ink-400">{t('centers.zoneEmpty', { zone: label(section.name) })}</p>
              ) : (
                <ul className="divide-y divide-ink-100">
                  {section.shown.map((m) => (
                    <li key={m.id}>
                      {/* Stacked rather than one long line: a roster is read on
                          phones at the front desk, where name + member number +
                          contact and a "view profile" action never fit side by
                          side without overlapping. */}
                      {openId !== m.id && (
                        <button
                          type="button"
                          onClick={() => setOpenId(openId === m.id ? null : m.id)}
                        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-ink-50"
                      >
                        <UserRound size={14} className="mt-0.5 shrink-0 text-ink-400" />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <MemberLink memberId={m.id} className="font-display text-sm font-semibold text-ink-900">{m.name}</MemberLink>
                            <span className="cat-chip category-people">{m.member_no}</span>
                            {!m.is_active && <span className="cat-chip category-amber">{t('members.inactive')}</span>}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-500">
                            <span className="inline-flex items-center gap-1">
                              <MapPin size={11} className="text-ink-400" /> {label(m.zone_name)}
                            </span>
                            {m.phone && <span className="inline-flex items-center gap-1"><Phone size={11} className="text-ink-400" /> {m.phone}</span>}
                            {m.email && <span className="inline-flex items-center gap-1 truncate"><Mail size={11} className="text-ink-400" /> {m.email}</span>}
                            {!m.phone && !m.email && <span>{t('common.none')}</span>}
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-1">
                            {(m.member_groups || []).length ? (
                              m.member_groups.map((g) => (
                                <span key={g.id} className="cat-chip category-ink">
                                  <GroupLogo groupId={g.id} name={g.name} has={g.has_logo} round size={14} />
                                  {g.name}
                                </span>
                              ))
                            ) : (
                              <span className="text-xs text-ink-400">{t('centers.rosterNoGroup')}</span>
                            )}
                          </span>
                        </span>
                        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand-800">
                          {openId === m.id ? t('memberProfile.close') : t('memberProfile.viewProfile')}
                          <ChevronDown size={13} className={openId === m.id ? 'rotate-180' : ''} />
                        </span>
                        </button>
                      )}
                      {/* MemberProfile fetches /members/:id itself, so the details
                          here are the same panel the Members screen shows: one
                          writer, one reader, no second rendering of a member's
                          history. */}
                      {openId === m.id && (
                        <div className="border-t border-ink-100 bg-ink-50/40">
                          <MemberProfile memberId={m.id} onClose={() => setOpenId(null)} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
