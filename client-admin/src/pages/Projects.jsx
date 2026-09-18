import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Plus, X, ArrowRight } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import StatusBanner from '../components/StatusBanner';
import ProgressBar from '../components/ProgressBar';
import { STATUS_TONE, money, daysLabel } from '../projectView';

const EMPTY = {
  name: '',
  description: '',
  status: 'active',
  startedOn: '',
  targetOn: '',
  goalAmount: '',
  currency: 'TZS',
};

/*
 * Special projects: the fundraising records, not an offering category.
 *
 * Created here and worked on the detail page. Ordering and the progress figures
 * come from the API (it owns the ledger), so this page never recalculates money
 * of its own: two screens showing two different "raised" totals is exactly what
 * this section exists to prevent.
 */
export default function Projects() {
  const { t } = useTranslation();
  const [projects, setProjects] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState(null);

  function load() {
    api
      .get('/projects')
      .then(({ data }) => setProjects(data.projects))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  useEffect(load, []);

  async function submit(e) {
    e.preventDefault();
    setSaving(true);
    setBanner(null);
    try {
      const { data } = await api.post('/projects', {
        ...form,
        goalAmount: form.goalAmount === '' ? 0 : Number(form.goalAmount),
        startedOn: form.startedOn || null,
        targetOn: form.targetOn || null,
      });
      setBanner({
        type: 'success',
        message: data.adoptedOfferings
          ? t('projects.createdAdopted', { n: data.adoptedOfferings })
          : t('projects.created'),
      });
      setForm(EMPTY);
      setShowForm(false);
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold">{t('projects.title')}</h1>
          <p className="mt-1 text-sm text-ink-500">{t('projects.subtitle')}</p>
        </div>
        <button type="button" onClick={() => setShowForm((v) => !v)} className="btn btn-primary">
          {showForm ? <X size={16} /> : <Plus size={16} />}
          {showForm ? t('common.cancel') : t('projects.newProject')}
        </button>
      </div>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      {showForm && (
        <form onSubmit={submit} className="tile mb-5 space-y-3 p-5">
          <h2 className="font-display text-lg font-semibold">{t('projects.newProject')}</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="pName">{t('projects.name')}</label>
              <input id="pName" required value={form.name} onChange={set('name')} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="pDesc">{t('projects.description')}</label>
              <textarea id="pDesc" rows={2} value={form.description} onChange={set('description')} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="pGoal">{t('projects.goal')}</label>
              <input id="pGoal" type="number" min="0" inputMode="numeric" value={form.goalAmount} onChange={set('goalAmount')} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="pCur">{t('projects.currency')}</label>
              <select id="pCur" value={form.currency} onChange={set('currency')} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600">
                <option value="TZS">TZS</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="pStart">{t('projects.startedOn')}</label>
              <input id="pStart" type="date" value={form.startedOn} onChange={set('startedOn')} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="pTarget">{t('projects.targetOn')}</label>
              <input id="pTarget" type="date" value={form.targetOn} onChange={set('targetOn')} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="pStatus">{t('projects.status')}</label>
              <select id="pStatus" value={form.status} onChange={set('status')} className="w-full rounded-md border border-ink-200 px-3 py-2.5 focus-visible:border-brand-600">
                <option value="active">{t('projects.statusActive')}</option>
                <option value="on_hold">{t('projects.statusOnHold')}</option>
                <option value="completed">{t('projects.statusCompleted')}</option>
              </select>
            </div>
          </div>
          <button type="submit" disabled={saving || !form.name} className="btn btn-primary btn-lg w-full">
            {saving ? t('common.saving') : t('projects.create')}
          </button>
        </form>
      )}

      {projects === null && <p className="py-10 text-center text-sm text-ink-400">{t('common.loading')}</p>}
      {projects?.length === 0 && (
        <div className="tile p-8 text-center">
          <p className="font-display text-lg font-semibold">{t('projects.emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-ink-500">{t('projects.emptyBody')}</p>
        </div>
      )}

      <div className="bento">
        {(projects || []).map((p) => (
          <article key={p.id} className="tile col-span-12 border-l-4 border-l-offering-600 p-5 lg:col-span-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h2 className="font-display text-lg font-semibold text-ink-900">{p.name}</h2>
              <span className={`cat-chip ${STATUS_TONE[p.status] || 'category-ink'}`}>{t(`projects.status_${p.status}`)}</span>
            </div>
            {p.description && <p className="mt-1 text-sm text-ink-500">{p.description}</p>}

            <div className="mt-4">
              <ProgressBar
                pct={p.fundedPct}
                label={t('projects.raisedOfGoal', { raised: money(p.raised, p.currency), goal: money(p.goalAmount, p.currency) })}
                value={p.fundedPct === null ? t('projects.noGoal') : `${p.fundedPct}%`}
                hint={t('projects.giftsCount', { n: p.gifts })}
              />
            </div>

            <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-offering-50 px-2 py-2">
                <dt className="text-[11px] uppercase tracking-wide text-offering-800/70">{t('projects.pledged')}</dt>
                <dd className="font-display text-sm font-semibold tabular-nums text-offering-800">{money(p.pledged, p.currency)}</dd>
              </div>
              <div className="rounded-lg bg-amber-50 px-2 py-2">
                <dt className="text-[11px] uppercase tracking-wide text-amber-800/70">{t('projects.owed')}</dt>
                <dd className="font-display text-sm font-semibold tabular-nums text-amber-800">{money(p.owed, p.currency)}</dd>
              </div>
              <div className="rounded-lg bg-ink-50 px-2 py-2">
                <dt className="text-[11px] uppercase tracking-wide text-ink-400">{t('projects.netPosition')}</dt>
                <dd className="font-display text-sm font-semibold tabular-nums text-ink-900">{money(p.netPosition, p.currency)}</dd>
              </div>
            </dl>

            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-xs text-ink-400">{daysLabel(p.timeline, t)}</span>
              <Link to={`/projects/${p.id}`} className="btn btn-secondary">
                {t('projects.viewProgress')} <ArrowRight size={15} />
              </Link>
            </div>
          </article>
        ))}
      </div>
    </AppShell>
  );
}
