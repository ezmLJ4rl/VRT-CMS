import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import DataTable from '../components/DataTable';
import StatusBanner from '../components/StatusBanner';

const EMPTY_FORM = { requestedDate: '', requestedTime: '', purpose: '', requesterNotes: '' };
const STATUS_KEYS = ['pending', 'confirmed', 'declined', 'rescheduled', 'completed', 'cancelled'];

function appointmentError(err, fallback, t) {
  const key = err?.response?.data?.error;
  if (key === 'errors.appointmentPastorUnavailable') return t('appointments.pastorUnavailable');
  return apiErrorMessage(err, fallback);
}

export default function Appointments() {
  const { t } = useTranslation();
  const [appointments, setAppointments] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [statusFilter, setStatusFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/appointments')
      .then(({ data }) => { setAppointments(data.appointments || []); setError(''); })
      .catch((err) => setError(appointmentError(err, t('appointments.loadFailed'), t)))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => appointments.filter((a) => (
    (!statusFilter || a.status === statusFilter) && (!dateFilter || a.requestedDate === dateFilter || a.proposedDate === dateFilter)
  )), [appointments, statusFilter, dateFilter]);

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError(''); setNotice('');
    try {
      await api.post('/appointments', form);
      setForm(EMPTY_FORM);
      setNotice(t('appointments.requested'));
      load();
    } catch (err) {
      setError(appointmentError(err, t('appointments.saveFailed'), t));
    } finally { setSaving(false); }
  }

  async function cancel(id) {
    setError('');
    try { await api.patch(`/appointments/${id}/cancel`); load(); }
    catch (err) { setError(appointmentError(err, t('appointments.saveFailed'), t)); }
  }

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-700"><CalendarClock size={15} /> {t('appointments.sectionLabel')}</p>
          <h1 className="font-display text-2xl font-semibold text-ink-900">{t('appointments.title')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">{t('appointments.subtitle')}</p>
        </div>
      </div>

      {error && <div className="mb-4"><StatusBanner type="error" message={error} /></div>}
      {notice && <div className="mb-4"><StatusBanner type="success" message={notice} /></div>}

      <section className="tile mb-5 p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">{t('appointments.requestTitle')}</h2>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm font-medium text-ink-700">{t('appointments.date')}
            <input required type="date" value={form.requestedDate} onChange={(e) => setForm({ ...form, requestedDate: e.target.value })} className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2.5 font-normal" />
          </label>
          <label className="text-sm font-medium text-ink-700">{t('appointments.time')}
            <input required type="time" value={form.requestedTime} onChange={(e) => setForm({ ...form, requestedTime: e.target.value })} className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2.5 font-normal" />
          </label>
          <label className="text-sm font-medium text-ink-700 sm:col-span-2">{t('appointments.purpose')}
            <input required maxLength={200} value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} placeholder={t('appointments.purposePlaceholder')} className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2.5 font-normal" />
          </label>
          <label className="text-sm font-medium text-ink-700 sm:col-span-2 lg:col-span-3">{t('appointments.notes')}
            <input maxLength={1000} value={form.requesterNotes} onChange={(e) => setForm({ ...form, requesterNotes: e.target.value })} placeholder={t('appointments.notesPlaceholder')} className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2.5 font-normal" />
          </label>
          <div className="flex items-end lg:justify-end">
            <button type="submit" disabled={saving} className="btn btn-primary w-full lg:w-auto">{saving ? t('appointments.saving') : t('appointments.requestAction')}</button>
          </div>
        </form>
      </section>

      <section className="tile p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div><h2 className="font-display text-lg font-semibold">{t('appointments.requests')}</h2><p className="text-sm text-ink-400">{t('appointments.requestsHint')}</p></div>
          <div className="flex flex-wrap gap-2">
            <label className="text-xs font-medium text-ink-500">{t('appointments.filterStatus')}
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="ml-2 rounded-md border border-ink-200 bg-paper px-2 py-1.5 text-sm text-ink-700">
                <option value="">{t('appointments.allStatuses')}</option>
                {STATUS_KEYS.map((key) => <option key={key} value={key}>{t(`appointments.status_${key}`)}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium text-ink-500">{t('appointments.filterDate')}
              <input type="date" value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} className="ml-2 rounded-md border border-ink-200 px-2 py-1.5 text-sm" />
            </label>
            {(statusFilter || dateFilter) && <button type="button" onClick={() => { setStatusFilter(''); setDateFilter(''); }} className="inline-flex items-center gap-1 text-xs font-medium text-ink-500 hover:text-ink-900"><X size={13} /> {t('appointments.clearFilters')}</button>}
          </div>
        </div>
        {loading ? <p className="py-8 text-center text-sm text-ink-400">{t('common.loading')}</p> : (
          <DataTable
            columns={[
              { key: 'date', header: t('appointments.date'), render: (a) => <span className="font-medium text-ink-900">{a.proposedDate || a.requestedDate}<span className="ml-1 text-xs text-ink-400">{a.proposedDate ? t('appointments.proposed') : ''}</span></span> },
              { key: 'time', header: t('appointments.time'), render: (a) => <span className="text-ink-600">{a.proposedTime || a.requestedTime}</span> },
              { key: 'purpose', header: t('appointments.purpose'), render: (a) => <span className="text-ink-700">{a.purpose}</span> },
              { key: 'status', header: t('appointments.status'), width: 20, cardValue: true, render: (a) => <span className={`cat-chip ${a.status === 'confirmed' ? 'category-success' : a.status === 'declined' || a.status === 'cancelled' ? 'category-ink' : a.status === 'rescheduled' ? 'category-amber' : 'category-brand'}`}>{t(`appointments.status_${a.status}`)}</span> },
              { key: 'action', header: '', width: 16, render: (a) => ['pending', 'confirmed', 'rescheduled'].includes(a.status) ? <button type="button" onClick={() => cancel(a.id)} className="text-xs font-medium text-ink-500 hover:text-danger-700">{t('appointments.cancel')}</button> : null },
            ]}
            rows={visible}
            keyOf={(a) => a.id}
            empty={<p className="py-8 text-center text-sm text-ink-400">{t('appointments.empty')}</p>}
          />
        )}
      </section>
    </AppShell>
  );
}
