import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ExpandingPanel } from '../motionUi.jsx';
import {
  Plus,
  Save,
  ArrowUp,
  ArrowDown,
  Power,
  Pencil,
  X,
  Search,
  Users,
  UserRound,
  Hash,
  Music,
  Church,
} from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import StatusBanner from '../components/StatusBanner';

const MODES = ['headcount', 'named', 'both'];
// A church service (ibada) may record attendance and offerings; a rehearsal is a
// practice session that records attendance only and is reported separately.
const KINDS = ['service', 'rehearsal'];

// Which icon names the attendance mode / type. Colour is deliberately NOT used
// to tell metadata apart: every badge below shares one neutral, low-saturation
// style, so a passive label never competes with an actionable button.
const MODE_ICON = { headcount: Hash, named: UserRound, both: Users };
const KIND_ICON = { service: Church, rehearsal: Music };

// One badge style for every piece of row metadata: same shape, same
// saturation, differentiated only by icon and text.
function MetaBadge({ icon: Icon, children }) {
  return (
    <span className="cat-chip category-ink">
      <Icon size={12} />
      {children}
    </span>
  );
}

function signature(name, kind, isActive, subSessions) {
  return JSON.stringify({
    name: (name || '').trim(),
    kind,
    active: isActive ? 1 : 0,
    subs: (subSessions || []).map((s) => ({ id: s.id ?? null, name: (s.name || '').trim() })),
  });
}

export default function ServiceTypes() {
  const { t } = useTranslation();
  const [types, setTypes] = useState([]);
  const [banner, setBanner] = useState(null);

  const [newName, setNewName] = useState('');
  const [newMode, setNewMode] = useState('headcount');
  const [newKind, setNewKind] = useState('service');
  const [creating, setCreating] = useState(false);
  // The create form is hidden until asked for: the page leads with the list of
  // types, and creating one is a deliberate act, not a permanent fixture
  // claiming the top of the screen. Same model as Add group / Add member.
  const [showCreate, setShowCreate] = useState(false);

  // Editing state: at most one row is open, and the open row's changes live in
  // a single draft so "has anything actually changed?" is answerable by
  // comparing the draft with the stored row.
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');

  const ordered = [...types].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? ordered.filter((x) => x.name.toLowerCase().includes(needle) || (x.key || '').toLowerCase().includes(needle))
    : ordered;

  const editingType = editingId != null ? types.find((x) => x.id === editingId) : null;

  const dirty =
    !!editingType &&
    !!draft &&
    signature(editingType.name, editingType.kind, editingType.is_active, editingType.subSessions) !==
      signature(draft.name, draft.kind, draft.isActive, draft.subSessions);

  // Saving re-runs the server's reconcile, which drops a sub-session whose name
  // is blank, so a blank name is treated as "not finished", not as "delete".
  const blankSubSession = !!draft && draft.subSessions.some((s) => !String(s.name || '').trim());

  useEffect(() => {
    load();
  }, []);

  function load() {
    api
      .get('/service-types')
      .then(({ data }) => setTypes(data.serviceTypes))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  function openCreate() {
    setNewName('');
    setNewMode('headcount');
    setNewKind('service');
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
      await api.post('/service-types', { name: newName, kind: newKind, attendanceMode: newMode, subSessions: [] });
      setBanner({ type: 'success', message: t('serviceTypes.created') });
      closeCreate();
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setCreating(false);
    }
  }

  // Opening a row while another row has unsaved work would silently discard it,
  // so the other rows' Edit actions stay unavailable until that draft is
  // saved or cancelled.
  function startEdit(type) {
    if (dirty) return;
    setBanner(null);
    setEditingId(type.id);
    setDraft({
      name: type.name,
      kind: type.kind,
      isActive: !!type.is_active,
      subSessions: (type.subSessions || []).map((s) => ({ id: s.id, name: s.name, is_active: s.is_active })),
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }

  function patchDraft(patch) {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function setSubSessionName(idx, value) {
    setDraft((prev) =>
      prev ? { ...prev, subSessions: prev.subSessions.map((s, i) => (i === idx ? { ...s, name: value } : s)) } : prev
    );
  }

  function addSubSession() {
    setDraft((prev) =>
      prev ? { ...prev, subSessions: [...prev.subSessions, { id: null, name: '', is_active: 1 }] } : prev
    );
  }

  function removeSubSession(idx) {
    setDraft((prev) => (prev ? { ...prev, subSessions: prev.subSessions.filter((_, i) => i !== idx) } : prev));
  }

  async function saveDraft() {
    if (!editingType || !draft) return;
    setSaving(true);
    setBanner(null);
    try {
      await api.patch(`/service-types/${editingType.id}`, {
        name: draft.name,
        kind: draft.kind,
        isActive: !!draft.isActive,
        subSessions: draft.subSessions.map((s) => ({
          ...(s.id ? { id: Number(s.id) } : {}),
          name: s.name,
          isActive: !!s.is_active,
        })),
      });
      setBanner({ type: 'success', message: t('serviceTypes.saved') });
      cancelEdit();
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function reorder(type, dir) {
    const idx = ordered.findIndex((x) => x.id === type.id);
    const swap = ordered[idx + dir];
    if (!swap) return;
    try {
      await api.patch(`/service-types/${type.id}`, { sortOrder: swap.sort_order });
      await api.patch(`/service-types/${swap.id}`, { sortOrder: type.sort_order });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    }
  }

  return (
    <AppShell>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold">{t('serviceTypes.title')}</h1>
        <button type="button" onClick={openCreate} className="btn btn-primary">
          <Plus size={16} /> {t('serviceTypes.add')}
        </button>
      </div>
      <p className="mb-5 text-sm text-ink-400">{t('serviceTypes.subtitle')}</p>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      {/* Hidden until "Add type": the form is one type's worth of work, so it
          appears for exactly that and gets out of the way afterwards. */}
      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display text-lg font-semibold text-brand-900">{t('serviceTypes.newTitle')}</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="st-name">
                {t('serviceTypes.newName')}
              </label>
              <input
                id="st-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                autoFocus
                placeholder={t('serviceTypes.newNamePlaceholder')}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="st-kind">
                {t('serviceTypes.kind')}
              </label>
              <select
                id="st-kind"
                value={newKind}
                onChange={(e) => {
                  setNewKind(e.target.value);
                  // A rehearsal is a headcount plus names by default.
                  if (e.target.value === 'rehearsal') setNewMode('both');
                }}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`serviceTypes.kind_${k}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="st-mode">
                {t('serviceTypes.mode')}
              </label>
              <select
                id="st-mode"
                value={newMode}
                onChange={(e) => setNewMode(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
              >
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(`serviceTypes.mode_${m}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={creating || !newName.trim()} className="btn btn-ink">
              <Plus size={16} /> {creating ? t('common.saving') : t('serviceTypes.createSubmit')}
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

      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('serviceTypes.search')}
          aria-label={t('serviceTypes.search')}
          className="w-full rounded-md border border-ink-200 bg-ink-50/40 py-2 pl-9 pr-3 text-sm focus-visible:border-brand-600"
        />
      </div>

      <ul className="mt-3 space-y-3">
        {filtered.map((type) => {
          const isEditing = editingId === type.id && !!draft;
          // While a row is being edited its badges follow the draft, so the
          // staged state is visible before it is saved.
          const isActive = isEditing ? draft.isActive : !!type.is_active;
          const subNames = (type.subSessions || []).map((s) => s.name);
          const pos = ordered.findIndex((x) => x.id === type.id);
          return (
            <li
              key={type.id}
              className={`rounded-xl border bg-paper shadow-sm ${isEditing ? 'border-ink-300' : 'border-ink-200'} ${
                isActive ? '' : 'opacity-70'
              }`}
            >
              {/* Row identity: the only things visible when the row is closed. */}
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-base font-semibold text-ink-900">{type.name}</span>
                    <MetaBadge icon={MODE_ICON[type.attendance_mode]}>
                      {t(`serviceTypes.mode_${type.attendance_mode}`)}
                    </MetaBadge>
                    <MetaBadge icon={KIND_ICON[type.kind]}>{t(`serviceTypes.kind_${type.kind}`)}</MetaBadge>
                    {!isActive && (
                      <span className="cat-chip category-amber">
                        <Power size={12} />
                        {t('serviceTypes.disabled')}
                      </span>
                    )}
                  </div>
                  {subNames.length > 0 && (
                    <p className="mt-1 truncate text-xs text-ink-400" title={subNames.join(', ')}>
                      {t('serviceTypes.subsessionsLabel')}: {subNames.join(' · ')}
                    </p>
                  )}
                </div>
                {!isEditing && (
                  <button
                    type="button"
                    onClick={() => startEdit(type)}
                    disabled={dirty}
                    title={dirty ? t('serviceTypes.finishEditingHint') : undefined}
                    className="btn btn-secondary self-end px-3 py-1.5 text-xs sm:self-center"
                  >
                    <Pencil size={13} /> {t('serviceTypes.edit')}
                  </button>
                )}
              </div>

              {/* Everything else appears only for the one row being edited, and
                  opens to its own height rather than snapping: the press and
                  the panel arriving read as one movement (motionUi.jsx). */}
              {isEditing && (
              <ExpandingPanel className="border-t border-ink-100 p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor={`st-name-${type.id}`}>
                        {t('serviceTypes.name')}
                      </label>
                      <input
                        id={`st-name-${type.id}`}
                        value={draft.name}
                        onChange={(e) => patchDraft({ name: e.target.value })}
                        className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor={`st-kind-${type.id}`}>
                        {t('serviceTypes.kind')}
                      </label>
                      {/* Changing this moves the type between the two reports, so it
                          goes through the API (which refuses to turn a type that
                          already collected offerings into a rehearsal). */}
                      <select
                        id={`st-kind-${type.id}`}
                        value={draft.kind}
                        onChange={(e) => patchDraft({ kind: e.target.value })}
                        className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
                      >
                        {KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`serviceTypes.kind_${k}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-4">
                    <span className="mb-2 block text-sm font-medium text-ink-700">
                      {t('serviceTypes.subsessionsLabel')}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {draft.subSessions.map((s, si) => (
                        <span
                          key={si}
                          className="flex items-center gap-1 rounded-full border border-ink-200 bg-ink-50 py-0.5 pl-2.5 pr-1 text-xs font-medium text-ink-700"
                        >
                          <input
                            value={s.name}
                            onChange={(e) => setSubSessionName(si, e.target.value)}
                            placeholder={t('serviceTypes.subsession')}
                            aria-label={t('serviceTypes.subsession')}
                            className="w-28 bg-transparent focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => removeSubSession(si)}
                            title={t('serviceTypes.removeSubsession')}
                            aria-label={t('serviceTypes.removeSubsession')}
                            className="rounded-full p-0.5 text-ink-400 hover:text-danger-700"
                          >
                            <X size={12} />
                          </button>
                        </span>
                      ))}
                      <button
                        type="button"
                        onClick={addSubSession}
                        className="btn btn-secondary px-3 py-1.5 text-xs"
                      >
                        <Plus size={13} /> {t('serviceTypes.addSubsession')}
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
                    <button
                      type="button"
                      onClick={() => reorder(type, -1)}
                      disabled={pos === 0}
                      className="btn btn-secondary px-3 py-1.5 text-xs"
                    >
                      <ArrowUp size={13} /> {t('serviceTypes.moveUp')}
                    </button>
                    <button
                      type="button"
                      onClick={() => reorder(type, 1)}
                      disabled={pos === ordered.length - 1}
                      className="btn btn-secondary px-3 py-1.5 text-xs"
                    >
                      <ArrowDown size={13} /> {t('serviceTypes.moveDown')}
                    </button>
                    <button
                      type="button"
                      onClick={() => patchDraft({ isActive: !draft.isActive })}
                      className="btn btn-secondary px-3 py-1.5 text-xs"
                    >
                      <Power size={13} /> {draft.isActive ? t('serviceTypes.disable') : t('serviceTypes.enable')}
                    </button>
                    {!draft.isActive && <span className="text-xs text-ink-400">{t('serviceTypes.disableHint')}</span>}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                    <button type="button" onClick={cancelEdit} className="btn btn-secondary">
                      <X size={15} /> {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={saveDraft}
                      disabled={!dirty || saving || blankSubSession}
                      title={blankSubSession ? t('serviceTypes.subsessionNameRequired') : !dirty ? t('serviceTypes.saveDisabledHint') : undefined}
                      className={dirty ? 'btn btn-ink' : 'btn btn-secondary'}
                    >
                      <Save size={15} /> {saving ? t('common.saving') : t('serviceTypes.save')}
                    </button>
                  </div>
              </ExpandingPanel>
              )}

            </li>
          );
        })}
        {types.length === 0 && (
          <li className="rounded-xl border border-ink-200 bg-paper p-6 text-center text-sm text-ink-400">
            {t('common.empty')}
          </li>
        )}
      </ul>
    </AppShell>
  );
}
