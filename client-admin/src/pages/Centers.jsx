import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, ArrowUp, ArrowDown, Power, Pencil, Trash2, Users, MapPin, TrendingUp, X } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import CenterRoster from '../components/CenterRoster';
import CenterTrend from '../components/CenterTrend';
import StatusBanner from '../components/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { DEFAULT_CURRENCY } from '../i18n/common';
import { monthLabel } from '../centerTrends';
import { ROLE_SUGGESTIONS, roleLabel, zoneMismatch } from '../zoneRoles';
import { ExpandingPanel } from '../motionUi.jsx';
import RowMenu, { RowMenuItem } from '../components/RowMenu';
import { EMPTY_VALUE } from '../emptyValue';
import MemberLink from '../components/MemberLink';

// Six complete months: enough to see a direction, few enough that every bar of
// the sparkline is a period a leader still remembers.
const TREND_MONTHS = 6;

/** Money short enough to sit beside a sparkline: 'TZS 1.2M' where 'TZS 1,234,567' cannot. */
function compactMoney(amount) {
  const value = Number(amount) || 0;
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${DEFAULT_CURRENCY} ${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${DEFAULT_CURRENCY} ${Math.round(value / 1e3)}k`;
  return `${DEFAULT_CURRENCY} ${value.toLocaleString()}`;
}

/**
 * Whether a center has anything to report at all.
 *
 * A row earns its trend line by having one. "Attendance: no activity / Giving:
 * no activity" repeated down eight centers is not a reading, it is six months of
 * nothing said eight times; the centers that DO have a story are the ones that
 * deserve the space. The silent case is not hidden: it is answered in the
 * open row, where someone has actually asked about that one center.
 */
function hasActivity(series) {
  if (!series) return false;
  const values = [...(series.attendance || []), ...(series.offering || [])];
  return values.some((value) => Number(value) !== 0);
}

/**
 * Revival Centers manages the centers and their zones, and nothing else.
 *
 * Registering people used to live here as well, which meant member records were
 * written from two screens and the front desk had to remember which one to use.
 * All member registration now happens on the Members screen (center, zone,
 * groups and all, in one form); this screen only creates, renames, reorders and
 * deactivates the centers and zones that registration points at. The member
 * COUNTS stay here, because they are what a center's row is for, and each row
 * can open its own read-only roster (see CenterRoster) so "who is filed here?"
 * is answerable without leaving the screen.
 *
 * Rows are CLOSED by default, exactly as on Service Types: a center shows its
 * name, its two counts and the actions you take on a center. The management
 * surface, the zone chips with their rename/delete controls, the add-zone
 * input, the reorder arrows, belongs to the one center currently open, so
 * scanning the list is not the same act as editing it. Opening a second center
 * closes the first, and nothing that can be edited is ever on screen twice.
 */
export default function Centers() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  // Managing centers and zones is admin work; the server enforces it too.
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';

  const [centers, setCenters] = useState([]);
  const [banner, setBanner] = useState(null);

  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // The create form is hidden until asked for: the page leads with the list of
  // centers, and adding one is a deliberate act, not a permanent fixture
  // claiming the top of the screen. Same model as Add type / Add group / Add member.
  const [showCreate, setShowCreate] = useState(false);

  const [newZone, setNewZone] = useState({});
  const [zoneEdit, setZoneEdit] = useState(null);
  const [zoneEditName, setZoneEditName] = useState('');
  const [working, setWorking] = useState(false);

  // Which zone is having a leader chosen, and the leaders just chosen for one.
  // The chosen set is held here for the round trip that records it: a zone's
  // leaders are one line of text, and that line must not blink back to an
  // empty cell while the write lands.
  const [leaderEditZone, setLeaderEditZone] = useState(null);
  const [leaderChosen, setLeaderChosen] = useState(null);
  // The assign form's two answers for the zone it is open on: who, and what
  // they are in charge of.
  const [leaderPick, setLeaderPick] = useState('');
  const [leaderRole, setLeaderRole] = useState('');

  // Who could hold office in each zone of the center being managed, keyed by
  // zone. Only a member OF the zone can lead it, so the form offers exactly
  // those people: the rule is enforced by the server too, but a picker that
  // cannot produce an invalid answer is better than an error message.
  const [zoneMembers, setZoneMembers] = useState(null);

  // Which center's management surface is open. At most one, for the same reason
  // Service Types opens one row at a time: a page where everything is editable at
  // once makes every row look like a form.
  const [managingId, setManagingId] = useState(null);
  const [menuOpenId, setMenuOpenId] = useState(null);

  // The inline roster remains available from the explicit View members action;
  // tapping the center name opens the dedicated center page.
  const [openRoster, setOpenRoster] = useState(null);

  // How each center is moving over the last complete months. Admin work: this is
  // the leadership view of the centers, not part of running the front desk, and
  // the endpoint is role-gated to match (a receptionist's reporting scope is
  // today's own records, which would draw every center as flat-lined).
  const [trends, setTrends] = useState(null);

  const ordered = [...centers].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  function load() {
    // Returns its promise so a save can wait for the fresh list before it puts
    // the plain line back on screen.
    return api
      .get('/revival-centers')
      .then(({ data }) => setCenters(data.revivalCenters))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  // Wrapped rather than passed directly, because load() now hands back its
  // promise (so a save can wait for the fresh list) and an effect may only
  // return a clean-up function.
  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!isAdmin) return undefined;
    let alive = true;
    api
      .get('/reports/center-trends', { params: { months: TREND_MONTHS } })
      .then(({ data }) => { if (alive) setTrends(data); })
      // A missing trend must never cost the reader the centers list itself: the
      // page is here for the centers and the rosters; this is an extra reading.
      .catch(() => {});
    return () => { alive = false; };
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin || !managingId) return undefined;
    let alive = true;
    api
      .get('/members', { params: { centerId: managingId, limit: 500, active: '1' } })
      .then(({ data }) => {
        if (!alive) return;
        const byZone = new Map();
        for (const m of data.members) {
          if (m.zone_id == null) continue;
          byZone.set(m.zone_id, [...(byZone.get(m.zone_id) || []), m]);
        }
        setZoneMembers({ centerId: managingId, byZone });
      })
      // A failed candidate list is not fatal: the panel still shows who leads
      // each zone, it just cannot offer the form until a reload succeeds.
      .catch(() => { if (alive) setZoneMembers(null); });
    return () => { alive = false; };
  }, [isAdmin, managingId]);

  const trendFor = (centerId) => trends?.centers?.find((s) => s.key === centerId) || null;

  function openCreate() {
    setNewName('');
    setShowCreate(true);
  }

  function closeCreate() {
    setNewName('');
    setShowCreate(false);
  }

  async function handleCreate(e) {
    e.preventDefault();
    setBanner(null);
    setCreating(true);
    try {
      await api.post('/revival-centers', { name: newName });
      setBanner({ type: 'success', message: t('centers.created') });
      closeCreate();
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setCreating(false);
    }
  }

  // Opening a center closes whichever one was open. Nothing is staged here (each
  // zone is its own record, written as it is changed), so switching loses no
  // work, but a half-finished zone rename must not follow the cursor into the
  // next row.
  function toggleManaging(centerId) {
    setBanner(null);
    setZoneEdit(null);
    // A half-finished rename or leader form belongs to the row it was opened on,
    // and must not follow the cursor into the next center.
    setLeaderEditZone(null);
    setLeaderChosen(null);
    setLeaderPick('');
    setLeaderRole('');
    setManagingId((prev) => (prev === centerId ? null : centerId));
  }

  async function addZone(centerId, e) {
    e.preventDefault();
    const name = (newZone[centerId] || '').trim();
    if (!name) return;
    setBanner(null);
    setWorking(true);
    try {
      await api.post(`/revival-centers/${centerId}/zones`, { name });
      setNewZone((prev) => ({ ...prev, [centerId]: '' }));
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setWorking(false);
    }
  }

  async function saveZoneName(zone) {
    if (zoneEdit === zone.id) {
      setWorking(true);
      try {
        await api.patch(`/revival-centers/zones/${zone.id}`, { name: zoneEditName });
        setZoneEdit(null);
        load();
      } catch (err) {
        setBanner({ type: 'error', message: apiErrorMessage(err) });
      } finally {
        setWorking(false);
      }
    } else {
      setZoneEdit(zone.id);
      setZoneEditName(zone.name);
    }
  }

  // The leaders to print on a zone's line: the ones just chosen, until the
  // reload confirms them; otherwise what the server last said. One shape for
  // both, so the line has a single renderer. `memberZoneId` is the bearer's OWN
  // zone, which is what lets the line tell an office held inside the zone from
  // one recorded before that rule existed.
  function leadersOf(zone) {
    if (leaderChosen && leaderChosen.zoneId === zone.id) return leaderChosen.leaders;
    return (zone.leaders || []).map((l) => ({
      memberId: l.member_id,
      name: l.name,
      roleName: l.role_name || '',
      memberZoneId: l.member_zone_id,
    }));
  }

  // The center's leaders are its zones' leaders. Derived on every render, never
  // stored: a second list would be the same fact typed twice, and the copies
  // would part company the first time somebody left a zone.
  function centerLeadersOf(center) {
    return center.zones.flatMap((z) =>
      leadersOf(z).map((l) => ({ ...l, zoneId: z.id, zoneName: z.name }))
    );
  }

  function candidatesFor(zone) {
    if (!zoneMembers || zoneMembers.centerId === undefined) return null;
    return zoneMembers.byZone.get(zone.id) || [];
  }

  // Leaders are saved as the WHOLE set the moment it changes: there is nothing
  // to stage, and a zone with nobody leading it is a real state (the roster says
  // so) rather than an unsaved edit.
  async function saveZoneLeaders(zone, leaders) {
    setBanner(null);
    setWorking(true);
    setLeaderChosen({ zoneId: zone.id, leaders });
    setLeaderEditZone(null);
    setLeaderPick('');
    setLeaderRole('');
    try {
      await api.patch(`/revival-centers/zones/${zone.id}`, {
        leaders: leaders.map((l) => ({ memberId: l.memberId, roleName: l.roleName || '' })),
      });
      await load();
    } catch (err) {
      // The write failed, so the line must go back to the truth the server still
      // holds rather than keep advertising a leader nobody recorded.
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setLeaderChosen(null);
      setWorking(false);
    }
  }

  // Opens the assign form on somebody already in office, so a role this church
  // has to name can be given without taking the office away first. A row written
  // before roles existed carries '' and nothing else in the app can express the
  // role it should have had; removing and re-adding would be the same write with
  // an interval in between where nobody leads the zone.
  function nameRole(zone, memberId) {
    setLeaderPick(String(memberId));
    setLeaderRole('');
    setLeaderEditZone(zone.id);
  }

  // Adds the person the form names, with the role the form gives. One role per
  // member per zone is the rule, and the form cannot break it: a person already
  // in office is not offered: the one exception being the person the admin
  // opened the form on, whose office is being given its name rather than added
  // twice.
  function addLeader(zone) {
    const memberId = Number(leaderPick);
    const roleName = leaderRole.trim();
    const candidate = candidatesFor(zone)?.find((m) => m.id === memberId);
    if (!candidate || !roleName) return;
    const standing = leadersOf(zone);
    const held = standing.find((l) => l.memberId === memberId);
    // Naming the role of somebody already in office REPLACES their entry: the
    // person keeps the office and the bearer's own zone is kept, so a marker
    // never disappears just because a role was filled in.
    const rest = standing.filter((l) => l.memberId !== memberId);
    saveZoneLeaders(zone, [...rest, { memberId, name: candidate.name, roleName, memberZoneId: held ? held.memberZoneId : zone.id }]);
  }

  function removeLeader(zone, memberId) {
    saveZoneLeaders(zone, leadersOf(zone).filter((l) => l.memberId !== memberId));
  }

  async function removeZone(zone) {
    if (!window.confirm(`${t('centers.removeZoneConfirm')} ${zone.name}?`)) return;
    setBanner(null);
    try {
      await api.delete(`/revival-centers/zones/${zone.id}`);
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    }
  }

  async function toggleCenter(c) {
    setBanner(null);
    try {
      await api.patch(`/revival-centers/${c.id}`, { isActive: !c.is_active });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    }
  }

  async function reorder(c, dir) {
    const idx = ordered.findIndex((x) => x.id === c.id);
    const other = ordered[idx + dir];
    if (!other) return;
    try {
      await api.patch(`/revival-centers/${c.id}`, { sortOrder: other.sort_order });
      await api.patch(`/revival-centers/${other.id}`, { sortOrder: c.sort_order });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    }
  }

  return (
    <AppShell>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold">{t('centers.title')}</h1>
        {isAdmin && (
          <button type="button" onClick={openCreate} className="btn btn-primary">
            <Plus size={16} /> {t('centers.add')}
          </button>
        )}
      </div>
      <p className="mb-5 text-sm text-ink-400">{t('centers.subtitle')}</p>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      {/* Hidden until "Add center": the form is one center's worth of work, so
          it appears for exactly that and gets out of the way afterwards. */}
      {isAdmin && showCreate && (
        <form onSubmit={handleCreate} className="mb-4 rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display text-lg font-semibold text-brand-900">{t('centers.newTitle')}</h2>
          <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="c-name">{t('centers.newName')}</label>
          <input
            id="c-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            required
            autoFocus
            placeholder={t('centers.newNamePlaceholder')}
            className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={creating || !newName.trim()} className="btn btn-ink">
              <Plus size={16} /> {creating ? t('common.saving') : t('centers.createSubmit')}
            </button>
            <button
              type="button"
              onClick={closeCreate}
              className="flex items-center gap-2 rounded-md border border-ink-200 px-4 py-2.5 text-sm text-ink-700 hover:border-brand-600 hover:text-brand-800"
            >
              <X size={15} /> {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {trends?.months?.length > 1 && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-ink-400">
          <TrendingUp size={13} className="text-ink-300" />
          {t('centers.trendWindow', {
            months: trends.months.length,
            range: `${monthLabel(trends.months[0], i18n.language)} – ${monthLabel(trends.months[trends.months.length - 1], i18n.language)}`,
          })}
        </p>
      )}

      {/* The jobs a church most often needs, offered in the reader's language.
          Typing something else is expected and works: roles are free text. */}
      <datalist id="zone-role-options">
        {ROLE_SUGGESTIONS.map((role) => (
          <option key={role} value={t(`centers.roleSuggestion_${role}`)} />
        ))}
      </datalist>

      <ul className="bento">
        {ordered.map((c, i) => {
          const trend = trendFor(c.id);
          const reports = hasActivity(trend);
          const managing = isAdmin && managingId === c.id;
          return (
            <li key={c.id} className={`tile col-span-12 ${c.is_active ? '' : 'opacity-70'}`}>
              {/* What a center is, and the two things you do to it: everything
                  else about it waits until the row is opened. */}
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/centers/${c.id}`)}
                      className="font-display text-left text-base font-semibold text-ink-900 hover:text-brand-800"
                    >
                      {c.name}
                    </button>
                    <span className="cat-chip category-people">{c.member_count} {t('centers.members')}</span>
                    <span className="cat-chip category-ink">{c.zones.length} {t('centers.zones')}</span>
                    {!c.is_active && <span className="cat-chip category-amber">{t('centers.disabled')}</span>}
                  </div>
                  {/* The direction each center is moving, so the row answers
                      "is this area growing?" without a trip to Reports: shown
                      only where there is a movement to report. */}
                  {reports && (
                    <CenterTrend
                      months={trends.months}
                      attendance={trend.attendance}
                      offering={trend.offering}
                      format={compactMoney}
                    />
                  )}
                </div>
                {/* One roster control at every role: reading a center's members
                    is reception work, not admin work. */}
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setOpenRoster(openRoster === c.id ? null : c.id)}
                    aria-expanded={openRoster === c.id}
                    className="btn btn-primary px-3 py-1.5 text-xs"
                  >
                    <Users size={13} />
                    {openRoster === c.id ? t('centers.hideMembers') : t('centers.viewMembers')}
                  </button>
                  {isAdmin && (
                    <RowMenu
                      open={menuOpenId === c.id}
                      onToggle={() => setMenuOpenId(menuOpenId === c.id ? null : c.id)}
                      onClose={() => setMenuOpenId(null)}
                      label={t('centers.rowMenu')}
                    >
                      <RowMenuItem
                        onClick={() => {
                          setMenuOpenId(null);
                          toggleManaging(c.id);
                        }}
                      >
                        <Pencil size={14} /> {managing ? t('centers.close') : t('centers.manage')}
                      </RowMenuItem>
                      <RowMenuItem
                        onClick={() => {
                          setMenuOpenId(null);
                          toggleCenter(c);
                        }}
                      >
                        <Power size={14} /> {c.is_active ? t('centers.disable') : t('centers.enable')}
                      </RowMenuItem>
                    </RowMenu>
                  )}
                </div>
              </div>

              {/* Zones and ordering are one center's surface, opened one at a
                  time: the same shape as a Service Types row, and opening the
                  same way: to its own height rather than in one jump. */}
              {managing && (
                <ExpandingPanel className="border-t border-ink-100 p-4">
                  <span className="mb-2 block text-sm font-medium text-ink-700">{t('centers.zonesHeading')}</span>
                  {c.zones.length === 0 && <p className="text-xs text-ink-400">{t('centers.noZones')}</p>}
                  {/* One zone per row, because a zone carries two facts now, its
                      name and who leads it, and a chip row cannot hold the
                      second without becoming a form. */}
                  <ul className="space-y-2">
                    {c.zones.map((z) => (
                      <li key={z.id} className="rounded-lg border border-ink-200 p-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <MapPin size={12} className="shrink-0 text-ink-400" />
                          {zoneEdit === z.id ? (
                            <form
                              onSubmit={(e) => { e.preventDefault(); saveZoneName(z); }}
                              className="flex min-w-0 flex-1 items-center gap-1 rounded-full bg-ink-100 py-0.5 pl-2.5 pr-1"
                            >
                              <input
                                autoFocus
                                value={zoneEditName}
                                onChange={(e) => setZoneEditName(e.target.value)}
                                aria-label={t('centers.renameZone')}
                                className="w-28 bg-transparent text-xs font-medium text-ink-700 focus:outline-none"
                              />
                              <button type="submit" disabled={working} className="rounded-full bg-ink-800 px-2 py-0.5 text-xs font-medium text-cream-50">OK</button>
                            </form>
                          ) : (
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-800">
                              {z.is_active ? z.name : `${z.name} (${t('centers.disabled')})`}
                            </span>
                          )}
                          {zoneEdit !== z.id && z.is_active && (
                            <button type="button" onClick={() => { setZoneEdit(z.id); setZoneEditName(z.name); }} className="rounded-full p-1 text-ink-400 hover:bg-ink-100 hover:text-brand-800" title={t('centers.renameZone')} aria-label={`${t('centers.renameZone')}: ${z.name}`}>
                              <Pencil size={13} />
                            </button>
                          )}
                          <button type="button" onClick={() => removeZone(z)} className="rounded-full p-1 text-ink-400 hover:bg-ink-100 hover:text-danger-600" title={t('centers.removeZone')} aria-label={`${t('centers.removeZone')}: ${z.name}`}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                        {/* Who holds office in this zone, and in what. One line,
                            because it is one fact: a chip per person, each
                            naming the job they hold. A leader is a MEMBER of
                            this zone on purpose: somebody the church can open,
                            reach, and hold responsible for the people filed
                            there. */}
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                          <span className="text-ink-600">{t('centers.zoneLeaders')}:</span>
                          {leadersOf(z).length === 0 && <span className="text-ink-400">{EMPTY_VALUE}</span>}
                          {leadersOf(z).map((l) => {
                            // An office recorded before "a leader must be filed in
                            // their zone" existed is marked, not hidden: the x is
                            // right there, and removing it is how the admin fixes
                            // it. Nothing rewrites their assignment for them.
                            const mismatch = zoneMismatch(t, l, z.id);
                            // An office out of step with its zone carries one
                            // action: remove it. One that simply has no role
                            // named yet carries the other: name it here, in
                            // place. Only the unnamed one can be renamed, since
                            // a wrong office is a reassignment, not a relabel.
                            const unnamed = !mismatch && !String(l.roleName || '').trim();
                            return (
                              <span
                                key={l.memberId}
                                className="inline-flex items-center gap-1 rounded-full bg-people-50 py-1 pl-2.5 pr-1 text-xs text-people-700"
                              >
                                {unnamed ? (
                                  <button
                                    type="button"
                                    onClick={() => nameRole(z, l.memberId)}
                                    title={t('centers.zoneRoleNameHint')}
                                    className="font-medium text-brand-800 hover:underline"
                                  >
                                    {t('centers.zoneRoleName')}
                                  </button>
                                ) : (
                                  <span className="font-medium">{roleLabel(t, l.roleName)}</span>
                                )}
                                <MemberLink memberId={l.memberId} className="text-people-800">{l.name}</MemberLink>
                                {mismatch && (
                                  <span className="cat-chip category-amber" title={t('centers.leaderNotInZoneHint')}>
                                    {mismatch}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  onClick={() => removeLeader(z, l.memberId)}
                                  title={t('centers.zoneLeaderRemove')}
                                  aria-label={`${t('centers.zoneLeaderRemove')}: ${l.name}`}
                                  className="rounded-full p-0.5 hover:bg-people-100"
                                >
                                  <X size={11} />
                                </button>
                              </span>
                            );
                          })}
                          {leaderEditZone !== z.id && (
                            <button
                              type="button"
                              onClick={() => setLeaderEditZone(z.id)}
                              disabled={candidatesFor(z)?.length === 0}
                              title={candidatesFor(z)?.length === 0 ? t('centers.zoneEmpty', { zone: z.name }) : undefined}
                              className="text-xs font-medium text-brand-800 hover:underline disabled:text-ink-300 disabled:no-underline"
                            >
                              {t('centers.zoneLeaderAssign')}
                            </button>
                          )}
                        </div>

                        {/* Two answers, one row: who, and what they are in
                            charge of. The person list is this zone's members,
                            so the rule "a leader must belong to the zone"
                            cannot be broken from here. */}
                        {leaderEditZone === z.id && (
                          <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-ink-50 p-2">
                            <label className="text-xs font-medium text-ink-600">
                              <span className="mb-1 block">{t('centers.leaderPerson')}</span>
                              <select
                                value={leaderPick}
                                onChange={(e) => setLeaderPick(e.target.value)}
                                className="rounded-md border border-ink-200 bg-paper px-2 py-1.5 text-sm focus-visible:border-brand-600"
                              >
                                <option value="">{t('centers.leaderPickPlaceholder')}</option>
                                {(candidatesFor(z) || [])
                                  // Everybody in the zone who does not already
                                  // hold office, plus the one person the form was
                                  // opened on, whose office is being named rather
                                  // than added.
                                  .filter((m) => Number(m.id) === Number(leaderPick) || !leadersOf(z).some((l) => l.memberId === m.id))
                                  .map((m) => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                  ))}
                              </select>
                            </label>
                            <label className="text-xs font-medium text-ink-600">
                              <span className="mb-1 block">{t('centers.leaderRole')}</span>
                              <input
                                list="zone-role-options"
                                value={leaderRole}
                                onChange={(e) => setLeaderRole(e.target.value)}
                                placeholder={t('centers.leaderRolePlaceholder')}
                                className="w-40 rounded-md border border-ink-200 px-2 py-1.5 text-sm focus-visible:border-brand-600"
                              />
                            </label>
                            <button
                              type="button"
                              onClick={() => addLeader(z)}
                              disabled={working || !leaderPick || !leaderRole.trim()}
                              className="btn btn-ink px-3 py-1.5 text-xs"
                            >
                              {leadersOf(z).some((l) => l.memberId === Number(leaderPick))
                                ? t('centers.zoneRoleNameSave')
                                : t('centers.leaderAdd')}
                            </button>
                            <button
                              type="button"
                              onClick={() => setLeaderEditZone(null)}
                              className="text-xs font-medium text-ink-400 hover:text-ink-700"
                            >
                              {t('common.cancel')}
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  <form onSubmit={(e) => addZone(c.id, e)} className="mt-2 flex items-center gap-1 rounded-full border border-dashed border-ink-200 px-2 py-0.5">
                    <input
                      value={newZone[c.id] || ''}
                      onChange={(e) => setNewZone((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      placeholder={t('centers.addZone')}
                      aria-label={t('centers.addZone')}
                      className="w-28 bg-transparent text-xs font-medium text-ink-700 placeholder:text-ink-400 focus:outline-none"
                    />
                    <button type="submit" disabled={working} aria-label={t('centers.addZone')} className="text-ink-400 hover:text-brand-800"><Plus size={12} /></button>
                  </form>

                  {/* Ordering is a management action, so it lives with the other
                      management actions instead of beside every name in the list.
                      Labelled, not two bare arrows: an unlabelled icon button is
                      what left a stray ">1" on the front desk. */}
                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
                    <button type="button" onClick={() => reorder(c, -1)} disabled={i === 0} className="btn btn-secondary px-3 py-1.5 text-xs">
                      <ArrowUp size={13} /> {t('centers.moveUp')}
                    </button>
                    <button type="button" onClick={() => reorder(c, 1)} disabled={i === ordered.length - 1} className="btn btn-secondary px-3 py-1.5 text-xs">
                      <ArrowDown size={13} /> {t('centers.moveDown')}
                    </button>
                  </div>

                  {/* Who leads the center: every zone leader in it, rolled up.
                      Nothing is assigned here, that is the point. A center
                      leader is not a second job to hand out, it is what leading
                      a zone already means. */}
                  <div className="mt-4 border-t border-ink-100 pt-4">
                    <span className="mb-2 block text-sm font-medium text-ink-700">{t('centers.centerLeaders')}</span>
                    {centerLeadersOf(c).length === 0 ? (
                      <p className="text-xs text-ink-400">{t('centers.centerLeadersEmpty')}</p>
                    ) : (
                      <ul className="space-y-1">
                        {centerLeadersOf(c).map((l) => (
                          <li key={`${l.zoneName}-${l.memberId}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                            <MemberLink memberId={l.memberId} className="font-medium text-ink-800">{l.name}</MemberLink>
                            <span className="text-xs font-medium text-people-700">{roleLabel(t, l.roleName)}</span>
                            <span className="text-xs text-ink-400">{l.zoneName}</span>
                            {/* The roll-up is where "who is in charge of what"
                                is read at a glance, so an office out of step
                                with its zone has to be visible HERE too,
                                otherwise the summary is the one screen that
                                looks right while the assignment is wrong. */}
                            {zoneMismatch(t, l, l.zoneId) && (
                              <span className="cat-chip category-amber" title={t('centers.leaderNotInZoneHint')}>
                                {zoneMismatch(t, l, l.zoneId)}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <p className="mt-2 text-xs text-ink-400">{t('centers.centerLeadersHint')}</p>
                  </div>

                  {/* The reading the closed row deliberately withholds: a center
                      with nothing recorded says so here, in the detail view,
                      rather than repeating it down the list. A center that does
                      report already carries its line above, and repeating the
                      same chart inside its own panel is the noise this page is
                      getting rid of. */}
                  {!reports && trend && (
                    <CenterTrend
                      months={trends.months}
                      attendance={trend.attendance}
                      offering={trend.offering}
                      format={compactMoney}
                    />
                  )}
                </ExpandingPanel>
              )}
              {openRoster === c.id && (
                <CenterRoster key={c.id} centerId={c.id} memberCount={c.member_count} zones={c.zones} />
              )}
            </li>
          );
        })}
        {centers.length === 0 && <li className="tile col-span-12 p-6 text-center text-sm text-ink-400">{t('common.empty')}</li>}
      </ul>
    </AppShell>
  );
}
