import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Plus,
  Save,
  Users,
  UsersRound,
  Music,
  Music2,
  HeartHandshake,
  Pencil,
  X,
  Power,
  ChevronRight,
  Trash2,
} from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import GroupLogo from '../components/GroupLogo';
import RowMenu, { RowMenuItem } from '../components/RowMenu';
import TypedConfirmDialog from '../components/TypedConfirmDialog';
import StatusBanner from '../components/StatusBanner';

const KINDS = ['small_group', 'choir', 'worship_team', 'fellowship'];

// Same rule as the service-types row: colour is never used to tell metadata
// apart: one neutral badge style, differentiated by icon and text only.
const KIND_ICON = { small_group: Users, choir: Music, worship_team: Music2, fellowship: HeartHandshake };

function MetaBadge({ icon: Icon, children }) {
  return (
    <span className="cat-chip category-ink">
      <Icon size={12} />
      {children}
    </span>
  );
}

/**
 * A group edit is the group itself: its name, its type, its description and
 * whether it is active. Comparing this signature against the one captured when
 * the editor opened is what makes "is there anything to save?" answerable, and
 * what lets Cancel throw the draft away without touching the database.
 *
 * Membership is deliberately NOT part of this. Who is in a group is a property
 * of the member, set where the member is registered or edited (see
 * pages/Members.jsx); this screen reads the count those records produce. That
 * keeps one writer per fact: two screens that can each rewrite a roster are two
 * screens that can disagree about it.
 */
function signature(g) {
  return JSON.stringify({
    name: (g.name || '').trim(),
    kind: g.kind,
    description: (g.description || '').trim(),
    active: g.isActive ? 1 : 0,
  });
}

export default function Groups() {
  const { t } = useTranslation();
  const [groups, setGroups] = useState([]);
  const [banner, setBanner] = useState(null);

  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('small_group');
  const [creating, setCreating] = useState(false);
  // The create form is hidden until asked for: the page leads with the list of
  // groups, and creating one is a deliberate act, not a permanent fixture
  // claiming the top of the screen. Same model as Add member on the Members page.
  const [showCreate, setShowCreate] = useState(false);

  // At most one group is open for editing, and its stored state is kept beside
  // the draft so the two can be compared.
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [baseline, setBaseline] = useState(null);
  const [saving, setSaving] = useState(false);
  // Logo writes are immediate (PUT/DELETE fire on choice), so this holds the
  // group id whose logo write is in flight: the row's own controls disable
  // while it runs, and a second click cannot double-send.
  const [logoBusyId, setLogoBusyId] = useState(null);
  const [menuOpenId, setMenuOpenId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  // The group whose delete is being confirmed by retyping its name. Holds the
  // row itself rather than an id, so the dialog names the same group the menu
  // was opened on even if the list reloads underneath it.
  const [pendingDelete, setPendingDelete] = useState(null);

  const editingGroup = editingId != null ? groups.find((g) => g.id === editingId) : null;
  const dirty = !!draft && !!baseline && signature(draft) !== signature(baseline);
  const blankName = !!draft && !String(draft.name || '').trim();

  function load() {
    api
      .get('/groups')
      .then(({ data }) => setGroups(data.groups))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  useEffect(load, []);

  function openCreate() {
    setNewName('');
    setNewKind('small_group');
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
      await api.post('/groups', { name: newName, kind: newKind });
      setBanner({ type: 'success', message: t('groups.created') });
      closeCreate();
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setCreating(false);
    }
  }

  function startEdit(g) {
    setBanner(null);
    setEditingId(g.id);
    const base = {
      name: g.name,
      kind: g.kind,
      description: g.description || '',
      isActive: !!g.is_active,
    };
    setBaseline(base);
    setDraft({ ...base });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setBaseline(null);
  }

  function patchDraft(patch) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  /**
   * A logo is not part of the draft: it lands on the group the moment a file
   * is chosen, exactly like the zone-role form lands on save-less immediacy.
   * Keeping it out of the name/kind/description draft means Cancel cannot
   * promise to undo an upload the server has already stored: the Remove
   * button is the undo. `key` on the input resets it, so choosing the same
   * file twice in a row still fires onChange (a browser only fires it when
   * the value changes).
   */
  async function handleLogoChange(g, file) {
    if (!file) return;
    setBanner(null);
    setLogoBusyId(g.id);
    try {
      const form = new FormData();
      form.append('logo', file);
      await api.put(`/groups/${g.id}/logo`, form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setBanner({ type: 'success', message: t('groups.logoSaved') });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setLogoBusyId(null);
    }
  }

  async function removeLogo(g) {
    setBanner(null);
    setLogoBusyId(g.id);
    try {
      await api.delete(`/groups/${g.id}/logo`);
      setBanner({ type: 'success', message: t('groups.logoRemoved') });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setLogoBusyId(null);
    }
  }

  /**
   * Delete a group, after the name has been retyped in the dialog. As with
   * members, the server decides between a real delete and a deactivation: a
   * group referenced by attendance or offering history is deactivated instead,
   * so past records keep naming a real group. The banner reports which of the
   * two actually happened.
   */
  /** The dialog is the confirmation, so the menu only hands the row over. */
  function askDeleteGroup(g) {
    setMenuOpenId(null);
    setPendingDelete(g);
  }

  async function deleteGroup(g) {
    setPendingDelete(null);
    setBanner(null);
    setDeletingId(g.id);
    try {
      const { data } = await api.delete(`/groups/${g.id}`);
      setBanner({
        type: 'success',
        message: data.deactivated ? t('groups.deactivatedWithHistory', { name: g.name }) : t('groups.deleted', { name: g.name }),
      });
      if (editingId === g.id) cancelEdit();
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setDeletingId(null);
    }
  }

  async function saveDraft() {
    if (!draft || !baseline || !editingGroup) return;
    setSaving(true);
    setBanner(null);
    try {
      await api.patch(`/groups/${editingGroup.id}`, {
        name: draft.name,
        kind: draft.kind,
        description: draft.description,
        isActive: draft.isActive,
      });
      setBanner({ type: 'success', message: t('groups.saved') });
      cancelEdit();
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold">{t('groups.title')}</h1>
        <button type="button" onClick={openCreate} className="btn btn-primary">
          <Plus size={16} /> {t('groups.add')}
        </button>
      </div>
      <p className="mb-2 text-sm text-ink-400">{t('groups.subtitle')}</p>
      <p className="mb-5 text-sm text-ink-500">
        {t('groups.membershipHint')}{' '}
        <Link to="/members" className="font-medium text-brand-700 hover:underline">
          {t('groups.membershipHintLink')}
        </Link>
      </p>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      {/* Hidden until "Add group": the form is one group's worth of work, so
          it appears for exactly that and gets out of the way afterwards. */}
      {showCreate && (
        <form onSubmit={handleCreate} className="mb-6 rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display text-lg font-semibold text-brand-900">{t('groups.newTitle')}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="g-name">
                {t('groups.newName')}
              </label>
              <input
                id="g-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                autoFocus
                placeholder={t('groups.newNamePlaceholder')}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="g-kind">
                {t('groups.kind')}
              </label>
              <select
                id="g-kind"
                value={newKind}
                onChange={(e) => setNewKind(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`groups.kind_${k}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="submit" disabled={creating || !newName.trim()} className="btn btn-ink">
              <Plus size={16} /> {creating ? t('common.saving') : t('groups.createSubmit')}
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

      <ul className="space-y-3">
        {groups.map((g) => {
          const isEditing = editingId === g.id && !!draft;
          const isActive = isEditing ? draft.isActive : !!g.is_active;
          const KindIcon = KIND_ICON[g.kind] || UsersRound;
          return (
            <li
              key={g.id}
              className={`rounded-xl border bg-paper shadow-sm ${isEditing ? 'border-ink-300' : 'border-ink-200'} ${
                isActive ? '' : 'opacity-70'
              }`}
            >
              {/* Row identity: the only things visible when the row is closed.
                  The badge reads the group's own stored kind; nothing here
                  infers a type from the name. */}
              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <GroupLogo groupId={g.id} name={g.name} has={g.has_logo} size={44} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        to={`/groups/${g.id}`}
                        className="font-display text-base font-semibold text-ink-900 hover:text-brand-800 hover:underline"
                      >
                        {g.name}
                      </Link>
                    <MetaBadge icon={KindIcon}>{t(`groups.kind_${g.kind}`)}</MetaBadge>
                    <MetaBadge icon={Users}>
                      {t('groups.memberCount', { count: g.member_count })}
                    </MetaBadge>
                    {!isActive && (
                      <span className="cat-chip category-amber">
                        <Power size={12} />
                        {t('groups.disabled')}
                      </span>
                    )}
                  </div>
                  {g.description && (
                    <p className="mt-1 truncate text-xs text-ink-400" title={g.description}>
                      {g.description}
                    </p>
                  )}
                  </div>
                </div>
                {!isEditing && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/groups/${g.id}`} className="btn btn-secondary px-3 py-1.5 text-xs">
                      <ChevronRight size={13} /> {t('groups.viewMembers')}
                    </Link>
                    {/* Row menu: actions beyond the two primary ones live here,
                        matching the collapsed-row pattern: scanning stays clean,
                        destructive power stays one deliberate click away. The
                        same component serves the Members rows. */}
                    <RowMenu
                      open={menuOpenId === g.id}
                      onToggle={() => setMenuOpenId(menuOpenId === g.id ? null : g.id)}
                      onClose={() => setMenuOpenId(null)}
                      label={t('groups.rowMenu')}
                    >
                      <RowMenuItem
                        onClick={() => {
                          setMenuOpenId(null);
                          startEdit(g);
                        }}
                        disabled={dirty}
                      >
                        <Pencil size={14} /> {t('groups.edit')}
                      </RowMenuItem>
                      <RowMenuItem onClick={() => askDeleteGroup(g)} disabled={deletingId === g.id} danger>
                        <Trash2 size={14} /> {t('groups.delete')}
                      </RowMenuItem>
                    </RowMenu>
                  </div>
                )}
              </div>

              {/* Everything else appears only for the one group being edited. */}
              {isEditing && (
                <div className="border-t border-ink-100 p-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor={`g-name-${g.id}`}>
                        {t('groups.name')}
                      </label>
                      <input
                        id={`g-name-${g.id}`}
                        value={draft.name}
                        onChange={(e) => patchDraft({ name: e.target.value })}
                        className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor={`g-kind-${g.id}`}>
                        {t('groups.kind')}
                      </label>
                      <select
                        id={`g-kind-${g.id}`}
                        value={draft.kind}
                        onChange={(e) => patchDraft({ kind: e.target.value })}
                        className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
                      >
                        {KINDS.map((k) => (
                          <option key={k} value={k}>
                            {t(`groups.kind_${k}`)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="mt-4">
                    <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor={`g-desc-${g.id}`}>
                      {t('groups.description')}
                    </label>
                    <input
                      id={`g-desc-${g.id}`}
                      value={draft.description}
                      onChange={(e) => patchDraft({ description: e.target.value })}
                      className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
                    />
                  </div>

                  <div className="mt-4 border-t border-ink-100 pt-4">
                    <span className="mb-1 block text-sm font-medium text-ink-700">{t('groups.logoHeading')}</span>
                    <div className="flex flex-wrap items-center gap-3">
                      <GroupLogo groupId={g.id} name={g.name} has={g.has_logo} size={56} />
                      <label
                        className={`btn btn-secondary px-3 py-1.5 text-xs ${logoBusyId === g.id ? 'pointer-events-none opacity-60' : ''}`}
                      >
                        <Pencil size={13} /> {t('groups.logoUpload')}
                        <input
                          key={g.logo_updated_at || 'none'}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          className="hidden"
                          onChange={(e) => {
                            handleLogoChange(g, e.target.files?.[0]);
                            e.target.value = '';
                          }}
                        />
                      </label>
                      {g.has_logo && (
                        <button
                          type="button"
                          onClick={() => removeLogo(g)}
                          disabled={logoBusyId === g.id}
                          className="btn btn-secondary px-3 py-1.5 text-xs"
                        >
                          <X size={13} /> {t('groups.logoRemove')}
                        </button>
                      )}
                      <span className="text-xs text-ink-400">{t('groups.logoHint')}</span>
                    </div>
                  </div>

                  <div className="mt-4 border-t border-ink-100 pt-4">
                    <span className="mb-1 block text-sm font-medium text-ink-700">{t('groups.membersHeading')}</span>
                    {t('groups.memberCount', { count: g.member_count })}
                    {': '}
                    <Link to={`/groups/${g.id}`} className="font-medium text-brand-700 hover:underline">
                      {t('groups.viewMembers')}
                    </Link>
                    <p className="mt-1 text-xs text-ink-400">{t('groups.membershipHint')}</p>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-ink-100 pt-4">
                    <button
                      type="button"
                      onClick={() => patchDraft({ isActive: !draft.isActive })}
                      className="btn btn-secondary px-3 py-1.5 text-xs"
                    >
                      <Power size={13} /> {draft.isActive ? t('groups.disable') : t('groups.enable')}
                    </button>
                    {!draft.isActive && <span className="text-xs text-ink-400">{t('groups.disableHint')}</span>}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                    <button type="button" onClick={cancelEdit} className="btn btn-secondary">
                      <X size={15} /> {t('common.cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={saveDraft}
                      disabled={!dirty || saving || blankName}
                      title={
                        blankName
                          ? t('groups.nameRequired')
                          : !dirty
                            ? t('groups.saveDisabledHint')
                            : undefined
                      }
                      className={dirty && !blankName ? 'btn btn-ink' : 'btn btn-secondary'}
                    >
                      <Save size={15} /> {saving ? t('common.saving') : t('groups.save')}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {groups.length === 0 && (
          <li className="rounded-xl border border-ink-200 bg-paper p-6 text-center text-sm text-ink-400">
            {t('common.empty')}
          </li>
        )}
      </ul>

      {pendingDelete && (
        <TypedConfirmDialog
          key={pendingDelete.id}
          title={t('groups.deleteTitle', { name: pendingDelete.name })}
          body={t('groups.deleteBody')}
          name={pendingDelete.name}
          confirmLabel={t('groups.delete')}
          busy={deletingId === pendingDelete.id}
          onConfirm={() => deleteGroup(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </AppShell>
  );
}
