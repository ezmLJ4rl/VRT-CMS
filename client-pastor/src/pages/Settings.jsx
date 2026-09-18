import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { LogOut, Download, Bell, BellOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { CHURCH_NAME, CHURCH_ADDRESS } from '../i18n/common';
import { getPushSupportState, enablePushNotifications, disablePushNotifications } from '../push';
import StatusBanner from '../components/StatusBanner';

export default function Settings() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [pushState, setPushState] = useState('default');
  const [pushError, setPushError] = useState('');
  const [installPrompt, setInstallPrompt] = useState(null);

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

  function handleLogout() {
    logout();
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

      <button
        onClick={handleLogout}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-danger-300 px-4 py-3 text-sm font-medium text-brand-800 hover:bg-brand-50"
      >
        <LogOut size={16} /> {t('settings.logout')}
      </button>
    </div>
  );
}
