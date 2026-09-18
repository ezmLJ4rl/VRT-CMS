import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2 } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import StatusBanner from '../components/StatusBanner';

const SEVERITY_STYLES = {
  low: 'bg-ink-100 text-ink-700',
  medium: 'bg-ink-100 text-ink-700',
  high: 'bg-amber-100 text-amber-800',
  critical: 'bg-danger-100 text-danger-700',
};

// The open-alert badge is owned by the shared unread source, not reported from
// here, so mounting this screen cannot leave the nav pill stale.
export default function Emergencies() {
  const { t } = useTranslation();
  const [emergencies, setEmergencies] = useState([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    api
      .get('/emergencies')
      .then(({ data }) => {
        setLoadError('');
        setEmergencies(data.emergencies);
      })
      .catch((err) => setLoadError(apiErrorMessage(err)));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-xl font-semibold">{t('emergencies.title')}</h1>
        <p className="text-sm text-ink-400">{t('emergencies.subtitle')}</p>
      </div>

      {loadError && <StatusBanner type="error" message={loadError} />}

      <ul className="divide-y divide-ink-100 rounded-xl border border-ink-200 bg-paper">
        {emergencies.map((e) => (
          <li key={e.id} className="p-3">
            <div className="mb-1 flex items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[e.severity]}`}>
                {t(`emergencies.severity_${e.severity}`)}
              </span>
              <span className={`text-xs ${e.status === 'resolved' ? 'flex items-center gap-1 text-people-700' : 'text-amber-700'}`}>
                {e.status === 'resolved' ? (
                  <>
                    <CheckCircle2 size={12} /> {t('emergencies.resolved')}
                  </>
                ) : (
                  t('emergencies.open')
                )}
              </span>
            </div>
            <p className="text-sm font-medium text-ink-900">{e.title}</p>
            {e.description && <p className="mt-0.5 text-sm text-ink-400">{e.description}</p>}
            <p className="mt-1 text-xs text-ink-400">
              {e.reported_by_name} · {e.timestamp}
            </p>
          </li>
        ))}
        {emergencies.length === 0 && <li className="p-4 text-center text-sm text-ink-400">{t('emergencies.noEmergencies')}</li>}
      </ul>
    </div>
  );
}
