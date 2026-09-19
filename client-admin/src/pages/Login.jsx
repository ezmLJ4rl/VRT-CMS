import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import { useAuth } from '../context/AuthContext';
import StatusBanner from '../components/StatusBanner';
import VrtLogo from '../components/VrtLogo';
import { CHURCH_NAME, CHURCH_LOCATION } from '../i18n/common';

const HOME_BY_ROLE = { receptionist: '/receptionist', admin: '/admin', superadmin: '/admin' };

function mmss(total) {
  const s = Math.max(0, Math.round(total));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// Login is a single step: email + password. No QR code, authenticator app, or
// second device is required: any authorized user can sign in from any device.
export default function Login() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [lockUntil, setLockUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);

  // The axios interceptor redirects here on 401 and flags the reason, so the
  // user lands on an explained login screen, not a bare form.
  useEffect(() => {
    if (localStorage.getItem('vrt_session_expired') === '1') {
      localStorage.removeItem('vrt_session_expired');
      setSessionExpired(true);
    }
  }, []);

  useEffect(() => {
    if (lockUntil <= Date.now()) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [lockUntil]);

  const lockRemaining = Math.max(0, Math.ceil((lockUntil - now) / 1000));
  const locked = lockRemaining > 0;

  function beginStartLockout(retryAfter) {
    setLockUntil(Date.now() + retryAfter * 1000);
    setNow(Date.now());
    setError(t('login.tooManyAttempts'));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const { data } = await api.post('/auth/login', { email, password, app: 'admin' });
      if (data.user.role === 'pastor') {
        setError(t('login.pastorRedirect'));
        return;
      }
      login(data.token, data.user);
      navigate(HOME_BY_ROLE[data.user.role] || '/login');
    } catch (err) {
      const status = err.response?.status;
      const retryAfter = Number(err.response?.data?.retryAfter);
      if (status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) beginStartLockout(retryAfter);
      else setError(apiErrorMessage(err, t('login.error')));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-6">
      <div className="w-full max-w-sm">
        <div className="rounded-xl border border-ink-200 bg-paper p-5 shadow-xl sm:p-6">
          <div className="mb-3 text-center">
            <VrtLogo size={144} className="mx-auto mb-3" />
            <h1 className="font-display text-xl font-semibold tracking-tight text-ink-900">{CHURCH_NAME}</h1>
            <p className="mt-1 text-xs text-ink-400">{CHURCH_LOCATION}</p>
          </div>

          <h2 className="mb-1 text-center font-display text-base font-medium">{t('login.title')}</h2>
          <p className="mb-4 text-center text-sm text-ink-400">{t('login.subtitle')}</p>

          {sessionExpired && (
            <div className="mb-3">
              <StatusBanner type="info" message={t('login.sessionExpired')} />
            </div>
          )}
          {error && (
            <div className="mb-3">
              <StatusBanner type={locked ? 'info' : 'error'} message={error} />
            </div>
          )}
          {locked && (
            <div className="mb-3">
              <StatusBanner type="info" message={t('login.tryAgainIn', { time: mmss(lockRemaining) })} />
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="email">
                {t('login.email')}
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="password">
                {t('login.password')}
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-md border border-ink-200 px-3 py-3 pr-11 text-base focus-visible:border-brand-600"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-ink-400 hover:text-ink-600"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={submitting || locked}
              className="btn btn-primary w-full"
            >
              {locked ? t('login.tryAgainShort') : submitting ? t('login.signingIn') : t('login.submit')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
