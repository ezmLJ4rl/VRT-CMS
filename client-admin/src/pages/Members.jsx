import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Save, X, MapPin, Check, UserPlus, Trash2, AlertTriangle, Users } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import { useAuth } from '../context/AuthContext';
import AppShell from '../components/AppShell';
import GroupLogo from '../components/GroupLogo';
import RowMenu, { RowMenuItem } from '../components/RowMenu';
import StatusBanner from '../components/StatusBanner';
import MemberProfile from '../components/MemberProfile';
import MemberLink from '../components/MemberLink';
import MembersHeader from '../components/MembersHeader';
import TypedConfirmDialog from '../components/TypedConfirmDialog';

// groupIds is part of the member record, not a separate screen's job: a person
// is registered into their center, their zone and their group(s) here, and the
// Groups screen only reads the counts that produces. Shipping this empty in
// EMPTY is what makes "no groups" an explicit choice rather than a field that
// was simply never filled in.
const EMPTY = { name: '', phone: '', email: '', gender: '', dateJoined: '', revivalCenterId: '', zoneId: '', notes: '', groupIds: [] };

export default function Members() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  // The front desk uses this screen too (it registers members), but deleting a
  // member and deactivating one are an administrator's decisions: the API
  // enforces that, and these two controls follow it instead of offering a button
  // that would come back 403.
  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin';
  const [members, setMembers] = useState([]);
  const [centers, setCenters] = useState([]);
  const [groups, setGroups] = useState([]);
  const [banner, setBanner] = useState(null);

  const [search, setSearch] = useState('');
  const [centerFilter, setCenterFilter] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [genderFilter, setGenderFilter] = useState('');
  // The order the list is asked for. Server-side, so it applies to the whole
  // directory rather than the page of it that happens to be loaded.
  const [sort, setSort] = useState('recent');
  // Both counts come from the server: `total` matches the current filters,
  // `grandTotal` is the whole directory (see MembersHeader).
  const [counts, setCounts] = useState({ total: 0, grandTotal: 0 });

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const editingRef = useRef(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [loadingGroups, setLoadingGroups] = useState(false);
  // Where the member is filed right now, kept apart from the form: the picker's
  // offer of movable zones is judged against the record, not against whatever has
  // been clicked since.
  const [filedCenterId, setFiledCenterId] = useState(null);
  const [filedZoneId, setFiledZoneId] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  // Which row's ⋮ menu is open: the same one-open-at-a-time rule as Groups.
  const [menuOpenId, setMenuOpenId] = useState(null);

  // The list is read-only by default. Selection is a mode the user enters
  // deliberately ("Assign to group"), because a checkbox column that is always
  // there invites an accidental bulk write and muddies a table whose normal job
  // is simply to be read.
  const [assignMode, setAssignMode] = useState(false);

  // Bulk assign: tick several people, then put them all into one group in a
  // single call. Selection is a UI convenience only: the write still goes
  // through the same group-members endpoint an individual edit uses.
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkGroupId, setBulkGroupId] = useState('');
  const [bulkSaving, setBulkSaving] = useState(false);

  // Members are registered at a revival center, so a center's roster is the
  // natural place to fill a group from: picking one fetches its people and
  // ticks them, and the list narrows to it so they can be reviewed first.
  const [sourceCenterId, setSourceCenterId] = useState('');
  const [filling, setFilling] = useState(false);

  // A name that matches an existing member is a question, not a refusal: the
  // server answers 409 code 'duplicate_name' and the front desk says whether
  // this is a genuinely different person. The resend carries the answer.
  const [duplicate, setDuplicate] = useState(null);

  // Bumped after a save or a delete instead of refetching by hand: one query
  // shape, one place that fills both the rows and the header's count. The two
  // hand-written copies this replaces had already drifted: a refetch after
  // saving dropped the zone, status and sort, and left the count stale.
  const [reloadKey, setReloadKey] = useState(0);

  // The member whose delete is being confirmed by retyping their name. Holds the
  // row itself, not an id, so the dialog names the same person the menu was
  // opened on even if the list reloads underneath it.
  const [pendingDelete, setPendingDelete] = useState(null);

  const loadCenters = () => api.get('/revival-centers').then(({ data }) => setCenters(data.revivalCenters)).catch(() => {});
  const loadGroups = () => api.get('/groups').then(({ data }) => setGroups(data.groups)).catch(() => {});

  useEffect(() => {
    loadCenters();
    loadGroups();
  }, []);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api
        .get('/members', {
          params: {
            search: search || undefined,
            centerId: centerFilter || undefined,
            zoneId: zoneFilter || undefined,
            groupId: groupFilter || undefined,
            active: statusFilter || undefined,
            gender: genderFilter || undefined,
            sort,
            limit: 200,
          },
        })
        .then(({ data }) => {
          if (!alive) return;
          setMembers(data.members);
          setCounts({ total: data.total ?? data.members.length, grandTotal: data.grandTotal ?? data.total ?? data.members.length });
        })
        .catch((err) => { if (alive) setBanner({ type: 'error', message: apiErrorMessage(err) }); });
    }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [search, centerFilter, zoneFilter, groupFilter, statusFilter, genderFilter, sort, reloadKey]);

  // A selection is only ever valid for the rows on screen: changing what the
  // list shows drops it, so a hidden member can never be swept into a group.
  // Applied in the filter handlers rather than an effect, so the reset happens
  // in the same render as the filter change instead of a second pass.
  function changeFilter(setter, value) {
    setter(value);
    setSelectedIds([]);
    setSourceCenterId('');
  }

  /** The Filter panel changes several fields at once, so it takes a patch. */
  function applyFilters(patch) {
    if ('centerId' in patch) setCenterFilter(patch.centerId);
    if ('zoneId' in patch) setZoneFilter(patch.zoneId);
    if ('groupId' in patch) setGroupFilter(patch.groupId);
    if ('active' in patch) setStatusFilter(patch.active);
    if ('gender' in patch) setGenderFilter(patch.gender);
    setSelectedIds([]);
    setSourceCenterId('');
  }

  function clearFilters() {
    setCenterFilter('');
    setZoneFilter('');
    setGroupFilter('');
    setStatusFilter('');
    setGenderFilter('');
    setSelectedIds([]);
    setSourceCenterId('');
  }

  const zones = useMemo(() => {
    const c = centers.find((x) => x.id === Number(form.revivalCenterId));
    return (c && c.zones) || [];
  }, [centers, form.revivalCenterId]);

  // A leadership office is held IN a zone, and the API refuses to move its holder
  // out of that zone, or out of its center, or into "no zone", because the move
  // would strand the office somewhere its bearer no longer belongs. The rule is
  // worked out here from the same payload that fills the picker, so an option
  // that could only fail on save is disabled and says which office is in the way.
  const offices = useMemo(() => {
    if (!editingId) return [];
    const held = [];
    for (const c of centers) {
      for (const z of c.zones || []) {
        for (const l of z.leaders || []) {
          if (Number(l.member_id) === Number(editingId)) {
            held.push({ zoneId: z.id, zoneName: z.name, centerName: c.name });
          }
        }
      }
    }
    return held;
  }, [centers, editingId]);

  const asId = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

  // The server only checks an office when the zone actually changes, so the zone
  // a member is already filed in always stays reachable; any other target needs
  // every office they hold to sit in that zone. That last clause is what keeps
  // moving someone INTO the zone they lead available: it is how a row whose
  // holder is filed elsewhere gets put right.
  const canMoveTo = (zoneId) => {
    const target = asId(zoneId);
    return target === asId(filedZoneId) || offices.every((o) => o.zoneId === target);
  };

  // A center is worth offering only if landing there leaves somewhere to go: the
  // one they are already in, or one with a zone they may be filed in.
  const centerOpen = (c) =>
    asId(c.id) === asId(filedCenterId) || canMoveTo(null) || (c.zones || []).some((z) => canMoveTo(z.id));

  const noneZoneOpen = canMoveTo(null);
  const noneCenterOpen = centerOpen({ id: null });

  // Named once each, for the disabled options and the note beneath the picker.
  const ledZoneNames = [...new Set(offices.map((o) => o.zoneName))];
  const ledCenterNames = [...new Set(offices.map((o) => o.centerName))];
  const lockedNote = offices.length ? ` · ${t('members.zoneLockedOption', { zones: ledZoneNames.join(', ') })}` : '';

  // Re-picking the center a member is already in is not a move, so it must not
  // wipe their zone: clearing it here would silently unfile them, and for a
  // member who leads a zone, it would make the next save fail for a reason the
  // admin never asked for.
  function changeCenter(value) {
    if (value === String(form.revivalCenterId)) return;
    setForm({ ...form, revivalCenterId: value, zoneId: '' });
  }

  function resetForm() {
    setForm(EMPTY);
    setEditingId(null);
    editingRef.current = null;
    setFiledCenterId(null);
    setFiledZoneId(null);
    setShowForm(false);
    setExpanded(null);
    setDuplicate(null);
  }

  function openCreate() {
    setEditingId(null);
    editingRef.current = null;
    setFiledCenterId(null);
    setFiledZoneId(null);
    setForm(EMPTY);
    setDuplicate(null);
    setShowForm(true);
  }

  async function openEdit(m) {
    setEditingId(m.id);
    editingRef.current = m.id;
    setFiledCenterId(m.revival_center_id != null ? Number(m.revival_center_id) : null);
    setFiledZoneId(m.zone_id != null ? Number(m.zone_id) : null);
    setDuplicate(null);
    setForm({
      name: m.name,
      phone: m.phone || '',
      email: m.email || '',
      gender: m.gender || '',
      dateJoined: m.date_joined || '',
      revivalCenterId: m.revival_center_id || '',
      zoneId: m.zone_id || '',
      notes: m.notes || '',
      groupIds: [],
    });
    setShowForm(true);
    setExpanded(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // The roster is fetched rather than assumed: opening the editor with an
    // empty group list would show every group as unchecked, and saving that
    // would quietly remove the member from all of them.
    setLoadingGroups(true);
    try {
      const { data } = await api.get(`/members/${m.id}`);
      const ids = (data.groups || []).map((g) => g.id);
      // Applied only if this member is still the one open: a slow response must
      // not stamp one member's groups onto another member's form.
      setForm((f) => (editingRef.current === m.id ? { ...f, groupIds: ids } : f));
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setLoadingGroups(false);
    }
  }

  function toggleGroup(id) {
    setForm((f) => ({
      ...f,
      groupIds: f.groupIds.includes(id) ? f.groupIds.filter((x) => x !== id) : [...f.groupIds, id],
    }));
  }

  // A group the member is already in stays on screen even after it has been
  // disabled, so re-saving their details cannot silently drop them from it.
  const assignableGroups = groups.filter((g) => g.is_active || form.groupIds.includes(g.id));

  /**
   * Register or update the member.
   *
   * `confirmed` is what turns the server's soft name warning into a decision:
   * the first submit may come back 409 code 'duplicate_name' (a member with this
   * name already exists), which opens the confirm panel instead of an error. The
   * front desk's answer resends the same form with confirmNameDuplicate set, and
   * only then is the second record created.
   */
  async function handleSubmit(e, confirmed = false) {
    if (e) e.preventDefault();
    setBanner(null);
    setSaving(true);
    try {
      const body = { ...form };
      if (!editingId) {
        body.isActive = true;
        if (confirmed) body.confirmNameDuplicate = true;
      }
      body.revivalCenterId = body.revivalCenterId ? Number(body.revivalCenterId) : null;
      body.zoneId = body.zoneId ? Number(body.zoneId) : null;
      body.groupIds = form.groupIds;
      if (editingId) {
        await api.patch(`/members/${editingId}`, body);
        setBanner({ type: 'success', message: t('members.saved') });
      } else {
        await api.post('/members', body);
        setBanner({ type: 'success', message: t('members.created') });
      }
      resetForm();
      setReloadKey((k) => k + 1);
      loadCenters();
    } catch (err) {
      const data = err?.response?.data;
      if (!editingId && data?.code === 'duplicate_name') {
        setDuplicate({ message: data.error, matches: data.duplicates || [] });
      } else {
        setBanner({ type: 'error', message: apiErrorMessage(err) });
      }
    } finally {
      setSaving(false);
    }
  }

  function toggleActive(m) {
    api
      .patch(`/members/${m.id}`, { isActive: !m.is_active })
      .then(({ data }) => setMembers((prev) => prev.map((x) => (x.id === m.id ? data.member : x))))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  /** The dialog is the confirmation, so the menu only hands the row over. */
  function askDeleteMember(m) {
    setMenuOpenId(null);
    setPendingDelete(m);
  }

  /**
   * Delete a member, after their name has been retyped in the dialog.
   *
   * The server decides whether that is a real delete or a deactivation: anyone
   * referenced by attendance, offering or pledge history is deactivated instead,
   * so the past records keep naming a real person. The banner reports which of
   * the two actually happened rather than claiming a deletion that did not.
   */
  async function deleteMember(m) {
    setPendingDelete(null);
    setBanner(null);
    setDeletingId(m.id);
    try {
      const { data } = await api.delete(`/members/${m.id}`);
      setBanner({
        type: 'success',
        message: data.deactivated ? t('members.deactivatedWithHistory', { name: m.name }) : t('members.deleted', { name: m.name }),
      });
      if (expanded === m.id) setExpanded(null);
      setSelectedIds((prev) => prev.filter((id) => id !== m.id));
      setReloadKey((k) => k + 1);
      loadCenters();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err, t('members.deleteFailed')) });
    } finally {
      setDeletingId(null);
    }
  }

  function toggleExpand(m) {
    navigate(`/members/${m.id}`);
  }

  const activeGroups = groups.filter((g) => g.is_active);
  const selectedCount = selectedIds.length;
  const allSelected = members.length > 0 && members.every((m) => selectedIds.includes(m.id));

  function toggleSelect(id) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? [] : members.map((m) => m.id));
  }

  // Leaving assign mode drops the selection with it, so a tick that was made in
  // a mode the user has now left can never be applied later by surprise.
  function toggleAssignMode() {
    setAssignMode((on) => {
      if (on) {
        setSelectedIds([]);
        setBulkGroupId('');
        setSourceCenterId('');
      }
      return !on;
    });
  }

  // Fetch a center's roster and tick it, so a whole center can be dropped into
  // a group without re-typing anyone who is already registered. The separate
  // request (rather than reusing the on-screen page) is deliberate: the list is
  // capped, and a center's roster must not be silently truncated by it.
  async function fillFromCenter(id) {
    setSourceCenterId(id);
    setSelectedIds([]);
    setBanner(null);
    if (!id) return;
    setCenterFilter(id);
    setFilling(true);
    try {
      const { data } = await api.get('/members', { params: { centerId: id, limit: 500 } });
      setSelectedIds(data.members.map((m) => m.id));
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setFilling(false);
    }
  }

  // Add every selected member to the chosen group in one request. The endpoint
  // is additive and ignores anyone already on the roster, so ticking a person
  // who is already there is a no-op rather than a duplicate or an error.
  async function addSelectedToGroup() {
    if (!selectedCount || !bulkGroupId || bulkSaving) return;
    setBulkSaving(true);
    setBanner(null);
    const group = groups.find((g) => String(g.id) === String(bulkGroupId));
    try {
      const { data } = await api.post(`/groups/${bulkGroupId}/members`, { memberIds: selectedIds });
      setBanner({
        type: 'success',
        message: data.added
          ? t('members.bulkAdded', { added: data.added, count: selectedCount, group: group?.name || '' })
          : t('members.bulkAllPresent', { count: selectedCount, group: group?.name || '' }),
      });
      setSelectedIds([]);
      setBulkGroupId('');
      setSourceCenterId('');
      const { data: list } = await api.get('/members', {
        params: { search: search || undefined, centerId: centerFilter || undefined, zoneId: zoneFilter || undefined, groupId: groupFilter || undefined, active: statusFilter || undefined, gender: genderFilter || undefined, limit: 200 },
      });
      setMembers(list.members);
      loadGroups();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setBulkSaving(false);
    }
  }

  return (
    <AppShell>
      <MembersHeader
        total={counts.total}
        grandTotal={counts.grandTotal}
        search={search}
        onSearch={(value) => changeFilter(setSearch, value)}
        sort={sort}
        onSort={setSort}
        filters={{ centerId: centerFilter, zoneId: zoneFilter, groupId: groupFilter, active: statusFilter, gender: genderFilter }}
        onFilter={applyFilters}
        onClearFilters={clearFilters}
        centers={centers}
        groups={groups}
        onAddMember={openCreate}
      >
        {/* Assigning a whole group is a different task from registering one
            person, so it is entered deliberately and left the same way. */}
        <button
          type="button"
          onClick={toggleAssignMode}
          disabled={members.length === 0}
          aria-pressed={assignMode}
          className={`btn ${assignMode ? 'btn-people' : 'btn-secondary'}`}
        >
          <Users size={16} /> {assignMode ? t('members.assignModeDone') : t('members.assignMode')}
        </button>
      </MembersHeader>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      {showForm && (
        <form onSubmit={handleSubmit} className="mb-6 rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display text-lg font-semibold text-brand-900">
            {editingId ? t('members.editTitle') : t('members.addTitle')}
          </h2>

          {/* The server's soft duplicate question, answered here. Registering a
              second "Neema K" is legitimate (two real people share the name), so
              this blocks nothing until the front desk chooses. */}
          {duplicate && (
            <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
              <p className="flex items-start gap-2 text-sm font-medium text-amber-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>{t('members.duplicateTitle')}: {duplicate.message}</span>
              </p>
              {duplicate.matches.length > 0 && (
                <ul className="mt-2 ml-6 list-disc text-xs text-amber-800">
                  {duplicate.matches.slice(0, 5).map((m) => (
                    <li key={m.id}>{m.name}{m.memberNo ? ` · ${m.memberNo}` : ''}</li>
                  ))}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => handleSubmit(null, true)} disabled={saving} className="btn btn-ink">
                  {saving ? t('common.saving') : t('members.duplicateConfirm')}
                </button>
                <button
                  type="button"
                  onClick={() => setDuplicate(null)}
                  className="rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700 hover:border-brand-600 hover:text-brand-800"
                >
                  {t('members.duplicateCancel')}
                </button>
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="m-name">{t('members.name')}</label>
              <input id="m-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="m-phone">{t('members.phone')}</label>
              <input id="m-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
              <p className="mt-1 text-xs text-ink-400">{t('members.phoneUniqueHint')}</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="m-email">{t('members.email')}</label>
              <input id="m-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
              <p className="mt-1 text-xs text-ink-400">{t('members.emailUniqueHint')}</p>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="m-gender">{t('members.gender')}</label>
              <select id="m-gender" value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600">
                <option value="">{t('common.select')}</option>
                <option value="female">{t('members.female')}</option>
                <option value="male">{t('members.male')}</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="m-joined">{t('members.dateJoined')}</label>
              <input id="m-joined" type="date" value={form.dateJoined} onChange={(e) => setForm({ ...form, dateJoined: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="m-center">{t('members.center')}</label>
              <select
                id="m-center"
                value={form.revivalCenterId}
                onChange={(e) => changeCenter(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
              >
                <option value="" disabled={!noneCenterOpen}>{t('common.none')}{noneCenterOpen ? '' : lockedNote}</option>
                {centers.map((c) => {
                  const open = centerOpen(c);
                  return (
                    <option key={c.id} value={c.id} disabled={!open}>{c.name}{open ? '' : lockedNote}</option>
                  );
                })}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="m-zone">{t('members.zone')}</label>
              <select id="m-zone" value={form.zoneId} onChange={(e) => setForm({ ...form, zoneId: e.target.value })} disabled={!zones.length} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600 disabled:opacity-50">
                <option value="" disabled={!noneZoneOpen}>{t('common.none')}{noneZoneOpen ? '' : lockedNote}</option>
                {zones.map((z) => {
                  const open = canMoveTo(z.id);
                  return (
                    <option key={z.id} value={z.id} disabled={!open}>{z.name}{open ? '' : lockedNote}</option>
                  );
                })}
              </select>
              {offices.length > 0 && (
                <p className="mt-1 text-xs text-amber-700">
                  {t('members.zoneLockedHint', { zones: ledZoneNames.join(', '), center: ledCenterNames.join(', ') })}
                </p>
              )}
            </div>
            <div className="sm:col-span-2 lg:col-span-3">
              <span className="mb-1 block text-sm font-medium text-ink-700">{t('members.groupsHeading')}</span>
              <p className="mb-2 text-xs text-ink-400">{t('members.groupsHint')}</p>
              {groups.length === 0 ? (
                <p className="text-sm text-ink-400">{t('members.groupsNone')}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {assignableGroups.map((g) => {
                    const on = form.groupIds.includes(g.id);
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => toggleGroup(g.id)}
                        aria-pressed={on}
                        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                          on
                            ? 'border-brand-600 bg-brand-50 text-brand-800'
                            : 'border-ink-200 text-ink-600 hover:border-brand-400 hover:text-brand-800'
                        }`}
                      >
                        {on ? <Check size={13} /> : <Plus size={13} />}
                        <GroupLogo groupId={g.id} name={g.name} has={g.has_logo} round size={18} />
                        {g.name}
                        <span className="text-ink-400">{t(`groups.kind_${g.kind}`)}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {loadingGroups && <p className="mt-1 text-xs text-ink-400">{t('common.loading')}</p>}
            </div>
            <div className="lg:col-span-3">
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="m-notes">{t('members.notes')}</label>
              <textarea id="m-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={saving} className="btn btn-offering">
              <Save size={15} /> {saving ? t('common.saving') : t('members.save')}
            </button>
            <button type="button" onClick={resetForm} className="flex items-center gap-2 rounded-md border border-ink-200 px-4 py-2.5 text-sm text-ink-700 hover:border-brand-600 hover:text-brand-800">
              <X size={15} /> {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      {assignMode && (
        <div className="mb-5 flex flex-col gap-3 rounded-xl border border-people-300 bg-people-50 p-4 shadow-sm lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <label className="flex items-center gap-2 text-sm font-medium text-people-800">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                className="h-4 w-4 rounded border-ink-300"
              />
              {t('members.selectAll')}
            </label>
            <span className="text-sm text-people-800">
              {selectedCount > 0 ? t('members.selectedCount', { count: selectedCount }) : t('members.assignModeHint')}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={sourceCenterId}
              onChange={(e) => fillFromCenter(e.target.value)}
              aria-label={t('members.fillFromCenter')}
              disabled={centers.length === 0 || filling}
              className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600 disabled:opacity-50"
            >
              <option value="">{t('members.fillFromCenter')}</option>
              {centers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            {bulkGroupId && (() => {
              const sel = activeGroups.find((g) => String(g.id) === String(bulkGroupId));
              return (
                <GroupLogo
                  groupId={bulkGroupId}
                  name={sel?.name}
                  has={sel?.has_logo}
                  round
                  size={22}
                />
              );
            })()}
            <select
              value={bulkGroupId}
              onChange={(e) => setBulkGroupId(e.target.value)}
              aria-label={t('members.bulkGroupLabel')}
              disabled={activeGroups.length === 0}
              className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600 disabled:opacity-50"
            >
              <option value="">{t('members.bulkGroupPlaceholder')}</option>
              {activeGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={addSelectedToGroup}
              disabled={!selectedCount || !bulkGroupId || bulkSaving}
              className="btn btn-ink"
            >
              <UserPlus size={16} /> {bulkSaving ? t('common.saving') : t('members.addToGroup')}
            </button>
          </div>
        </div>
      )}

      <ul className="space-y-2">
        {members.map((m) => (
          <li key={m.id} className={`rounded-xl border border-ink-200 bg-paper shadow-sm ${m.is_active ? '' : 'opacity-70'}`}>
            {expanded !== m.id && (
              <div className="flex cursor-pointer flex-col gap-3 p-4 sm:flex-row sm:items-center" onClick={() => toggleExpand(m)}>
              {assignMode && (
                <input
                  type="checkbox"
                  checked={selectedIds.includes(m.id)}
                  onChange={() => toggleSelect(m.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={t('members.selectMember', { name: m.name })}
                  className="h-4 w-4 shrink-0 rounded border-ink-300"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <MemberLink memberId={m.id} className="font-display font-semibold text-ink-900">{m.name}</MemberLink>
                  <span className="cat-chip category-people">{m.member_no}</span>
                  {!m.is_active && <span className="cat-chip category-amber">{t('members.inactive')}</span>}
                  {(m.member_groups || []).map((g) => (
                    <span key={g.id} className="cat-chip category-ink">
                      <GroupLogo groupId={g.id} name={g.name} has={g.has_logo} round size={14} />
                      {g.name}
                    </span>
                  ))}
                  {m.center_name && (
                    <span className="text-xs text-ink-400">
                      <MapPin size={11} className="inline align-[-1px]" /> {m.center_name}
                      {m.zone_name ? ` · ${m.zone_name}` : ''}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-sm text-ink-500">
                  {m.email || m.phone ? (
                    <>
                      {[m.phone, m.email].filter(Boolean).join(' · ')}
                    </>
                  ) : (
                    t('common.none')
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isAdmin && (
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleActive(m); }}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium ${m.is_active ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-people-50 text-people-800 hover:bg-people-100'}`}
                  >
                    {m.is_active ? t('members.deactivate') : t('members.activate')}
                  </button>
                )}
                {/* Edit and Delete live in the same ⋮ menu as the Groups rows:
                    one pattern across both screens (see components/RowMenu.jsx).
                    Deactivate stays a primary button: it is the everyday action
                    on this screen, not a hidden one, for the admins who have
                    it at all. */}
                <RowMenu
                  open={menuOpenId === m.id}
                  onToggle={() => setMenuOpenId(menuOpenId === m.id ? null : m.id)}
                  onClose={() => setMenuOpenId(null)}
                  label={t('members.rowMenu')}
                >
                  <RowMenuItem
                    onClick={() => {
                      setMenuOpenId(null);
                      openEdit(m);
                    }}
                  >
                    <Pencil size={14} /> {t('members.edit')}
                  </RowMenuItem>
                  {isAdmin && (
                    <RowMenuItem onClick={() => askDeleteMember(m)} disabled={deletingId === m.id} danger>
                      <Trash2 size={14} /> {t('members.delete')}
                    </RowMenuItem>
                  )}
                </RowMenu>
              </div>
              </div>
            )}
            {expanded === m.id && (
              <MemberProfile
                memberId={m.id}
                onClose={() => {
                  setMenuOpenId(null);
                  setExpanded(null);
                }}
                actions={(
                  <RowMenu
                    open={menuOpenId === m.id}
                    onToggle={() => setMenuOpenId(menuOpenId === m.id ? null : m.id)}
                    onClose={() => setMenuOpenId(null)}
                    label={t('members.rowMenu')}
                  >
                    <RowMenuItem
                      onClick={() => {
                        setMenuOpenId(null);
                        openEdit(m);
                      }}
                    >
                      <Pencil size={14} /> {t('members.edit')}
                    </RowMenuItem>
                    {isAdmin && (
                      <RowMenuItem onClick={() => askDeleteMember(m)} disabled={deletingId === m.id} danger>
                        <Trash2 size={14} /> {t('members.delete')}
                      </RowMenuItem>
                    )}
                  </RowMenu>
                )}
              />
            )}
          </li>
        ))}
        {members.length === 0 && <li className="rounded-xl border border-ink-200 bg-paper p-6 text-center text-sm text-ink-400">{t('common.empty')}</li>}
      </ul>

      {pendingDelete && (
        <TypedConfirmDialog
          key={pendingDelete.id}
          title={t('members.deleteTitle', { name: pendingDelete.name })}
          body={t('members.deleteBody')}
          name={pendingDelete.name}
          confirmLabel={t('members.delete')}
          busy={deletingId === pendingDelete.id}
          onConfirm={() => deleteMember(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </AppShell>
  );
}
