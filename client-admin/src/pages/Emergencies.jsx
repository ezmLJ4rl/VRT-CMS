import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import StatusBanner from '../components/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { EMPTY_VALUE } from '../emptyValue';

const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const SEVERITY_STYLES = {
  low: 'bg-ink-100 text-ink-700',
  medium: 'bg-ink-100 text-ink-700',
  high: 'bg-amber-100 text-amber-800',
  critical: 'bg-danger-100 text-danger-700',
};

export default function Emergencies() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const canResolve = ['admin', 'superadmin'].includes(user?.role);

  const [emergencies, setEmergencies] = useState([]);
  const [banner, setBanner] = useState(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [severity, setSeverity] = useState('medium');
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    load();
  }, []);

  function load() {
    api
      .get('/emergencies')
      .then(({ data }) => setEmergencies(data.emergencies))
      .catch((err) => setLoadError(apiErrorMessage(err)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setBanner(null);
    setSubmitting(true);
    try {
      await api.post('/emergencies', { title, description: description || undefined, severity });
      setBanner({ type: 'success', message: t('emergencies.reportedSuccess') });
      setTitle('');
      setDescription('');
      setSeverity('medium');
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSubmitting(false);
    }
  }

  async function resolve(id) {
    try {
      await api.patch(`/emergencies/${id}/resolve`);
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    }
  }

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-semibold">{t('emergencies.title')}</h1>
      <p className="mb-5 text-sm text-ink-400">{t('emergencies.subtitle')}</p>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}
      {loadError && !banner && (
        <div className="mb-5">
          <StatusBanner type="error" message={loadError} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display text-lg font-semibold">{t('emergencies.reportTitle')}</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="title">
                {t('emergencies.incidentTitle')}
              </label>
              <input
                id="title"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="severity">
                {t('emergencies.severity')}
              </label>
              <select
                id="severity"
                value={severity}
                onChange={(e) => setSeverity(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>
                    {t(`emergencies.severity_${s}`)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="description">
                {t('emergencies.description')}
              </label>
              <textarea
                id="description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-danger-600 px-4 py-3.5 text-base font-medium text-white hover:bg-danger-700 disabled:opacity-60"
            >
              <AlertTriangle size={17} /> {t('emergencies.report')}
            </button>
            <p className="text-xs text-ink-400">{t('emergencies.notifyNote')}</p>
          </form>
        </section>

        <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
          <h2 className="mb-4 font-display text-lg font-semibold">{t('emergencies.log')}</h2>
          <ul className="divide-y divide-ink-100">
            {emergencies.map((e) => (
              <li key={e.id} className="flex items-start justify-between gap-3 py-3">
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[e.severity]}`}>
                      {t(`emergencies.severity_${e.severity}`)}
                    </span>
                    {e.status === 'resolved' && (
                      <span className="flex items-center gap-1 text-xs text-people-700">
                        <CheckCircle2 size={13} /> {t('emergencies.resolved')}
                      </span>
                    )}
                  </div>
                  <p className="text-sm font-medium text-ink-900">{e.title}</p>
                  {e.description && <p className="mt-0.5 text-sm text-ink-400">{e.description}</p>}
                  <p className="mt-1 text-xs text-ink-400">
                    {e.reported_by_name} · {e.timestamp}
                  </p>
                </div>
                {canResolve && e.status === 'open' && (
                  <button
                    onClick={() => resolve(e.id)}
                    className="shrink-0 rounded-md border border-ink-200 px-2.5 py-1.5 text-xs text-ink-700 hover:border-people-500 hover:text-people-700"
                  >
                    {t('emergencies.markResolved')}
                  </button>
                )}
              </li>
            ))}
            {emergencies.length === 0 && <li className="py-4 text-center text-sm text-ink-400">{EMPTY_VALUE}</li>}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}
