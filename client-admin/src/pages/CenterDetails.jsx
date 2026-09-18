import { ArrowLeft, MapPin, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import CenterRoster from '../components/CenterRoster';
import StatusBanner from '../components/StatusBanner';

export default function CenterDetails() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [center, setCenter] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .get('/revival-centers')
      .then(({ data }) => {
        if (!alive) return;
        const found = data.revivalCenters.find((item) => String(item.id) === String(id));
        setCenter(found || null);
      })
      .catch((err) => {
        if (alive) setError(apiErrorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <AppShell>
      <Link to="/centers" className="mb-4 inline-flex items-center gap-2 text-sm font-medium text-ink-600 hover:text-brand-800">
        <ArrowLeft size={16} /> {t('centers.backToList')}
      </Link>

      {error && <StatusBanner type="error" message={error} />}
      {!error && !center && <p className="text-sm text-ink-400">{t('common.loading')}</p>}
      {center && (
        <>
          <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <MapPin size={20} className="text-people-700" />
                <h1 className="font-display text-2xl font-semibold text-ink-900">{center.name}</h1>
                {!center.is_active && <span className="cat-chip category-amber">{t('centers.disabled')}</span>}
              </div>
              <p className="mt-1 text-sm text-ink-500">{t('centers.detailsSubtitle')}</p>
            </div>
          </header>

          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            <div className="tile p-4">
              <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-400">
                <Users size={14} /> {t('centers.members')}
              </p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{center.member_count}</p>
            </div>
            <div className="tile p-4">
              <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-ink-400">
                <MapPin size={14} /> {t('centers.zones')}
              </p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{center.zones.length}</p>
            </div>
          </div>

          <section className="tile p-4">
            <h2 className="mb-1 font-display text-lg font-semibold">{t('centers.rosterTitle')}</h2>
            <p className="mb-3 text-sm text-ink-400">{t('centers.rosterHint')}</p>
            <CenterRoster centerId={center.id} memberCount={center.member_count} zones={center.zones} />
          </section>
        </>
      )}
    </AppShell>
  );
}
