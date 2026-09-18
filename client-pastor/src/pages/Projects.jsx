import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import api from '../api';
import ProgressBar from '../components/ProgressBar';

/*
 * Special projects, pastor's view: progress only.
 *
 * The same figures the office works from, raised against the goal, and what is
 * still promised, presented to be read in a glance or shown to the church, and
 * with no editing controls at all, because the pastor's role here is to see.
 */
const STATUS_TONE = { active: 'text-people-700', on_hold: 'text-amber-700', completed: 'text-ink-500' };

export default function Projects() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get('/projects')
      .then(({ data }) => setProjects(data.projects))
      .catch(() => {
        setProjects([]);
        setError(t('projects.loadFailed'));
      });
  }, [t]);

  const money = (amount, currency) => `${Number(amount || 0).toLocaleString()} ${currency}`;

  return (
    <div className="space-y-4">
      <h1 className="font-display text-xl font-semibold">{t('projects.title')}</h1>

      {error && <p className="rounded-xl border border-danger-300 bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}
      {projects === null && <p className="py-10 text-center text-sm text-ink-400">{t('common.loading')}</p>}

      {projects?.length === 0 && (
        <div className="rounded-xl border border-ink-200 bg-paper p-6 text-center">
          <p className="text-sm font-medium text-ink-900">{t('projects.emptyTitle')}</p>
          <p className="mt-1 text-sm text-ink-400">{t('projects.emptyBody')}</p>
        </div>
      )}

      <ul className="space-y-3">
        {(projects || []).map((p) => (
          <li key={p.id}>
            <Link to={`/projects/${p.id}`} className="block rounded-xl border border-ink-200 bg-paper p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-display text-base font-semibold text-ink-900">{p.name}</p>
                  <p className={`text-xs font-medium ${STATUS_TONE[p.status] || 'text-ink-500'}`}>{t(`projects.status_${p.status}`)}</p>
                </div>
                <ChevronRight size={18} className="mt-0.5 shrink-0 text-ink-300" aria-hidden="true" />
              </div>

              <div className="mt-3">
                <ProgressBar
                  pct={p.fundedPct}
                  value={`${money(p.raised, p.currency)} / ${money(p.goalAmount, p.currency)}`}
                  label={t('projects.raised')}
                />
              </div>
              <p className="mt-1.5 text-xs text-ink-500">
                {p.fundedPct === null ? t('projects.noGoal') : t('projects.percentsFunded', { pct: p.fundedPct })}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
