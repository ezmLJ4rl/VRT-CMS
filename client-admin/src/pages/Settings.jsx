import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Save, Trash2, UserPlus, X } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import DataTable from '../components/DataTable';
import StatusBanner from '../components/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { CHURCH_NAME, CHURCH_ADDRESS } from '../i18n/common';

const ROLES = ['receptionist', 'admin', 'pastor', 'superadmin'];

export default function Settings() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isSuperadmin = user?.role === 'superadmin';

  const [users, setUsers] = useState([]);
  const [banner, setBanner] = useState(null);
  const [newUser, setNewUser] = useState({ name: '', email: '', role: 'receptionist', password: '' });
  const [creating, setCreating] = useState(false);
  // The create form is hidden until asked for: the section leads with the list
  // of users, and adding one is a deliberate act, not a permanent fixture
  // above the table. Same model as Add member / Add group / Add type / Add center.
  const [showCreate, setShowCreate] = useState(false);
  const [toggleId, setToggleId] = useState(null);
  const [resetId, setResetId] = useState(null);
  const [resetResult, setResetResult] = useState(null);
  const [copied, setCopied] = useState(false);

  // Full account edit (name, email, phone, role, active, password): the same
  // panel creates nothing; it only ever patches the account it was opened on.
  const [editing, setEditing] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => {
    if (isSuperadmin) loadUsers();
  }, [isSuperadmin]);

  function loadUsers() {
    api
      .get('/users')
      .then(({ data }) => setUsers(data.users))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  function openCreate() {
    setNewUser({ name: '', email: '', role: 'receptionist', password: '' });
    setShowCreate(true);
  }

  function closeCreate() {
    setNewUser({ name: '', email: '', role: 'receptionist', password: '' });
    setShowCreate(false);
  }

  async function handleCreateUser(e) {
    e.preventDefault();
    setBanner(null);
    setCreating(true);
    try {
      await api.post('/users', newUser);
      setBanner({ type: 'success', message: t('settings.userCreated') });
      closeCreate();
      loadUsers();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(u) {
    setToggleId(u.id);
    try {
      await api.patch(`/users/${u.id}`, { isActive: !u.is_active });
      loadUsers();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setToggleId(null);
    }
  }

  async function handleResetPassword(u) {
    if (!window.confirm(t('settings.resetConfirm', { name: u.name }))) return;
    setBanner(null);
    setResetId(u.id);
    try {
      const { data } = await api.post(`/users/${u.id}/reset-password`);
      setResetResult(data);
      setBanner({ type: 'success', message: t('settings.resetDone') });
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setResetId(null);
    }
  }

  function startEdit(u) {
    setBanner(null);
    setResetResult(null);
    setEditing({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone || '',
      role: u.role,
      isActive: !!u.is_active,
      password: '',
    });
  }

  async function handleSaveEdit(e) {
    e.preventDefault();
    setBanner(null);
    setSavingEdit(true);
    try {
      const payload = {
        name: editing.name,
        email: editing.email,
        phone: editing.phone,
        role: editing.role,
        isActive: editing.isActive,
      };
      // Only send a password when one was typed: the API writes exactly the keys
      // it receives, so an empty box must not blank out the credential.
      if (editing.password) payload.password = editing.password;

      await api.patch(`/users/${editing.id}`, payload);
      setBanner({ type: 'success', message: t('settings.userUpdated') });
      setEditing(null);
      loadUsers();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDeleteUser(u) {
    if (!window.confirm(t('settings.deleteConfirm', { name: u.name }))) return;
    setBanner(null);
    setDeletingId(u.id);
    try {
      await api.delete(`/users/${u.id}`);
      setBanner({ type: 'success', message: t('settings.userDeleted') });
      if (editing?.id === u.id) setEditing(null);
      loadUsers();
    } catch (err) {
      // 409 means the account has recorded history; the API says what it found
      // and what to do instead, so show that explanation verbatim.
      setBanner({ type: 'error', message: apiErrorMessage(err, t('settings.deleteFailed')) });
    } finally {
      setDeletingId(null);
    }
  }

  async function handleChangePassword(e) {
    e.preventDefault();
    setBanner(null);
    setChangingPassword(true);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      setBanner({ type: 'success', message: t('settings.passwordChanged') });
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setChangingPassword(false);
    }
  }

  return (
    <AppShell>
      <h1 className="mb-5 font-display text-2xl font-semibold">{t('settings.title')}</h1>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-3 font-display text-lg font-semibold">{t('settings.churchInfo')}</h2>
          <p className="text-sm text-ink-700">{CHURCH_NAME}</p>
          <p className="text-sm text-ink-400">{CHURCH_ADDRESS}</p>
        </section>

        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display text-lg font-semibold">{t('settings.changePassword')}</h2>
          <form onSubmit={handleChangePassword} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="currentPassword">
                {t('settings.currentPassword')}
              </label>
              <input
                id="currentPassword"
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="newPassword">
                {t('settings.newPassword')}
              </label>
              <input
                id="newPassword"
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
              />
            </div>
            <button
              type="submit"
              disabled={changingPassword}
              className="btn btn-ink"
            >
              {t('settings.save')}
            </button>
          </form>
        </section>
      </div>

      {isSuperadmin && (
        <section className="mt-6 rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold">{t('settings.users')}</h2>
            <button type="button" onClick={openCreate} className="btn btn-primary">
              <UserPlus size={15} /> {t('settings.addUser')}
            </button>
          </div>

          {/* Hidden until "Add user": the form is one account's worth of work,
              so it appears for exactly that and gets out of the way afterwards. */}
          {showCreate && (
            <form onSubmit={handleCreateUser} className="mb-6 rounded-xl border border-ink-200 bg-ink-50/60 p-4">
              <h3 className="mb-3 font-display text-base font-semibold text-brand-900">{t('settings.newTitle')}</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <input
                  placeholder={t('settings.name')}
                  aria-label={t('settings.name')}
                  required
                  autoFocus
                  value={newUser.name}
                  onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                  className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                />
                <input
                  placeholder={t('login.email')}
                  aria-label={t('login.email')}
                  type="email"
                  required
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                />
                <select
                  aria-label={t('settings.role')}
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                  className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`settings.role_${r}`)}
                    </option>
                  ))}
                </select>
                <input
                  placeholder={t('login.password')}
                  aria-label={t('login.password')}
                  type="password"
                  required
                  minLength={8}
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  className="rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                />
                <button type="submit" disabled={creating} className="btn btn-ink">
                  <UserPlus size={15} /> {creating ? t('common.saving') : t('settings.createSubmit')}
                </button>
              </div>
              <button
                type="button"
                onClick={closeCreate}
                className="mt-3 flex items-center gap-2 rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700 hover:border-brand-600 hover:text-brand-800"
              >
                <X size={15} /> {t('common.cancel')}
              </button>
            </form>
          )}

          {resetResult && (
            <div className="mb-4 rounded-lg border border-ink-200 bg-ink-50/60 p-4 text-sm">
              <p className="mb-1 font-medium text-ink-800">{t('settings.resetPasswordTitle')}</p>
              <p className="mb-3 text-ink-600">{t('settings.resetPasswordBody')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded-md bg-white px-3 py-1.5 text-base font-semibold tracking-wide text-brand-800 ring-1 ring-ink-200">{resetResult.tempPassword}</code>
                <button
                  type="button"
                  onClick={() => {
                    if (navigator.clipboard) navigator.clipboard.writeText(resetResult.tempPassword);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                  className="rounded-md bg-ink-800 px-3 py-1.5 text-xs font-medium text-cream-50 hover:bg-ink-900"
                >
                  {copied ? t('settings.copied') : t('settings.copy')}
                </button>
                <button type="button" onClick={() => setResetResult(null)} className="rounded-md px-3 py-1.5 text-xs font-medium text-ink-500 hover:bg-ink-100">
                  {t('settings.dismiss')}
                </button>
              </div>
            </div>
          )}

          {editing && (
            <form onSubmit={handleSaveEdit} className="mb-6 rounded-xl border border-ink-200 bg-ink-50/60 p-4">
              <h3 className="mb-3 font-display text-base font-semibold text-brand-900">{t('settings.editUser')}</h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="edit-name">{t('settings.name')}</label>
                  <input id="edit-name" required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="edit-email">{t('login.email')}</label>
                  <input id="edit-email" type="email" required value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="edit-phone">{t('settings.phone')}</label>
                  <input id="edit-phone" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="edit-role">{t('settings.role')}</label>
                  <select id="edit-role" value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600">
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{t(`settings.role_${r}`)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="edit-password">{t('settings.newPasswordOptional')}</label>
                  <input id="edit-password" type="password" minLength={8} autoComplete="new-password" placeholder={t('settings.keepPassword')} value={editing.password} onChange={(e) => setEditing({ ...editing, password: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600" />
                </div>
                <label className="flex items-end gap-2 pb-2 text-sm text-ink-700">
                  <input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} className="h-4 w-4 rounded border-ink-300" />
                  {t('settings.active')}
                </label>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button type="submit" disabled={savingEdit} className="btn btn-ink">
                  <Save size={15} /> {savingEdit ? t('common.saving') : t('settings.save')}
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  className="flex items-center gap-2 rounded-md border border-ink-200 px-4 py-2 text-sm text-ink-700 hover:border-brand-600 hover:text-brand-800"
                >
                  <X size={15} /> {t('common.cancel')}
                </button>
              </div>
            </form>
          )}

          {/* The one shared table pattern (components/DataTable): fixed
              columns under their headers, sticky header, and the same card
              reflow on phones as every other list in the app. */}
          <DataTable
            columns={[
              { key: 'name', header: t('settings.name'), render: (u) => <span className="font-medium text-ink-900">{u.name}</span> },
              { key: 'email', header: t('login.email'), render: (u) => <span className="text-ink-400">{u.email}</span> },
              { key: 'role', header: t('settings.role'), width: 14, render: (u) => t(`settings.role_${u.role}`) },
              {
                key: 'status',
                header: t('settings.status'),
                width: 12,
                align: 'right',
                render: (u) => (
                  <button
                    onClick={() => toggleActive(u)}
                    disabled={toggleId === u.id}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${
                      u.is_active ? 'bg-people-100 text-people-700' : 'bg-brand-100 text-brand-800'
                    }`}
                  >
                    {u.is_active ? t('settings.active') : t('settings.inactive')}
                  </button>
                ),
              },
              {
                key: 'actions',
                header: t('settings.actions'),
                width: 34,
                align: 'right',
                render: (u) => (
                  <span className="inline-flex items-center justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(u)}
                      title={t('settings.editUser')}
                      className="flex items-center gap-1 rounded-md border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800"
                    >
                      <Pencil size={13} /> {t('settings.edit')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleResetPassword(u)}
                      disabled={resetId === u.id}
                      title={t('settings.resetPassword')}
                      className="rounded-md bg-ink-800 px-2.5 py-1 text-xs font-medium text-cream-50 hover:bg-ink-900 disabled:opacity-50"
                    >
                      {resetId === u.id ? t('common.saving') : t('settings.resetPassword')}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteUser(u)}
                      disabled={deletingId === u.id}
                      title={t('settings.deleteUser')}
                      className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-danger-700 hover:bg-danger-50 disabled:opacity-50"
                    >
                      <Trash2 size={13} /> {t('settings.deleteUser')}
                    </button>
                  </span>
                ),
              },
            ]}
            rows={users}
            keyOf={(u) => u.id}
            empty={<p className="py-6 text-center text-sm text-ink-400">{t('common.empty')}</p>}
          />
        </section>
      )}
    </AppShell>
  );
}
