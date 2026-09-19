import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { LogOut, Download, Bell, BellOff, MonitorSmartphone } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import { useAuth } from '../context/AuthContext';
import { CHURCH_NAME, CHURCH_ADDRESS } from '../i18n/common';
import { getPushSupportState, enablePushNotifications, disablePushNotifications } from '../push';
import StatusBanner from '../components/StatusBanner';
import { formatDateTime } from '../format';

export default function Settings() {
  const { t, i18n } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [pushState, setPushState] = useState('default');
  const [pushError, setPushError] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);
  // The account's signed-in devices, read from the server's session records:
  // which places are signed in, which one is THIS device, and ending any other
  // one (a lost phone) or all of them from here.
  const [sessions, setSessions] = useState(null);
  const [devicesError, setDevicesError] = useState('');
  const [signingOutAll, setSigningOutAll] = useState(false);

  function loadSessions() {
    api
      .get('/auth/sessions')
      .then(({ data }) => setSessions(data.sessions.filter((s) => !s.revoked)))
      .catch((err) => setDevicesError(apiErrorMessage(err)));
  }

  useEffect(() => {
    loadSessions();
  }, []);

  async function revokeSession(sid) {
    setDevicesError('');
    try {
      await api.post(`/auth/sessions/${sid}/revoke`);
      loadSessions();
    } catch (err) {
      setDevicesError(apiErrorMessage(err));
    }
  }

  async function signOutAllDevices() {
    if (!window.confirm(t('settings.signOutAllConfirm'))) return;
    setSigningOutAll(true);
    setDevicesError('');
    try {
      await api.post('/auth/logout-all');
      await logout();
      navigate('/login');
    } catch (err) {
      setDevicesError(apiErrorMessage(err));
      setSigningOutAll(false);
    }
  }

  useEffect(() => {
    setPushState(getPushSupportState());
    function onBeforeInstall(e) {
      e.preventDefault();
      setInstallPrompt(e);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstall);
  }, []);

  async function handleTogglePush() {
    setPushError('');
    try {
      if (pushState === 'granted') {
        await disablePushNotifications();
        setPushState('default');
      } else {
        await enablePushNotifications();
        setPushState('granted');
      }
    } catch (err) {
      setPushError(err.message);
      setPushState(getPushSupportState());
    }
  }

  async function handleInstall() {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  }

  // Waits for the server to revoke THIS device's session before leaving.
  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="space-y-5">
      <h1 className="font-display text-xl font-semibold">{t('settings.title')}</h1>

      <div className="rounded-xl border border-ink-200 bg-paper p-4">
        <p className="text-sm font-medium text-ink-900">{user?.name}</p>
        <p className="text-xs text-ink-400">{user?.email}</p>
      </div>

      {installPrompt && (
        <div className="rounded-xl border border-ink-200 bg-paper p-4">
          <p className="mb-1 text-sm font-medium text-ink-900">{t('settings.installTitle')}</p>
          <p className="mb-3 text-sm text-ink-400">{t('settings.installBody')}</p>
          <button
            onClick={handleInstall}
            className="btn btn-ink btn-lg w-full"
          >
            <Download size={16} /> {t('settings.installButton')}
          </button>
        </div>
      )}

      {/* Language is chosen from the header pill on every screen, so a second
          control here would just be a second place to keep in step. */}
      {pushState !== 'unsupported' && (
        <div className="rounded-xl border border-ink-200 bg-paper p-4">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-sm font-medium text-ink-900">{t('settings.notifications')}</p>
            <button
              onClick={handleTogglePush}
              disabled={pushState === 'denied'}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${
                pushState === 'granted' ? 'bg-people-100 text-people-700' : 'bg-ink-100 text-ink-700'
              }`}
            >
              {pushState === 'granted' ? <Bell size={13} /> : <BellOff size={13} />}
              {pushState === 'granted' ? t('home.notificationsEnabled') : t('home.enableNotifications')}
            </button>
          </div>
          {pushState === 'denied' && <p className="text-xs text-ink-400">{t('home.notificationsBlocked')}</p>}
          {pushError && (
            <div className="mt-2">
              <StatusBanner type="error" message={pushError} />
            </div>
          )}
        </div>
      )}

      <div className="rounded-xl border border-ink-200 bg-paper p-4">
        <p className="text-sm font-medium text-ink-900">{CHURCH_NAME}</p>
        <p className="text-xs text-ink-400">{CHURCH_ADDRESS}</p>
      </div>

      {/* Signed-in devices: the account can be signed in on several at once
          (a laptop at the office, this phone), and each one is managed
          independently. Ending another device never touches this one. */}
      <div className="rounded-xl border border-ink-200 bg-paper p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-medium text-ink-900">
          <MonitorSmartphone size={15} aria-hidden="true" className="text-ink-500" /> {t('settings.devices')}
        </h2>
        <p className="mb-3 text-xs text-ink-400">{t('settings.devicesHelp')}</p>
        {devicesError && <StatusBanner type="error" message={devicesError} />}
        {sessions === null && !devicesError && <p className="py-2 text-sm text-ink-400">{t('common.loading')}</p>}
        {sessions && (
          <ul className="divide-y divide-ink-100">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink-900">
                      {s.current ? t('settings.deviceThisDevice') : `${t('settings.device')} ${s.id.slice(0, 8)}`}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-ink-400">
                    {t('settings.deviceLastActive', { when: formatDateTime(s.lastActiveAt, i18n.language) })}
                  </span>
                </span>
                {!s.current && (
                  <button
                    type="button"
                    onClick={() => revokeSession(s.id)}
                    className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium text-ink-600 hover:bg-danger-50 hover:text-danger-700"
                  >
                    {t('settings.signOutElsewhere')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          onClick={signOutAllDevices}
          disabled={signingOutAll}
          className="mt-3 w-full rounded-md border border-ink-200 px-4 py-2.5 text-sm font-medium text-ink-700 hover:border-danger-400 hover:text-danger-700 disabled:opacity-50"
        >
          {t('settings.signOutAllDevices')}
        </button>
      </div>

      <button
        onClick={handleLogout}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-danger-300 px-4 py-3 text-sm font-medium text-brand-800 hover:bg-brand-50"
      >
        <LogOut size={16} /> {t('settings.logout')}
      </button>
    </div>
  );
}
