import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Check, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import api, { apiErrorMessage } from '../api';
import StatusBanner from '../components/StatusBanner';

function appointmentDate(a) { return a.proposedDate || a.requestedDate; }
function appointmentTime(a) { return a.proposedTime || a.requestedTime; }

function appointmentError(err, fallback, t) {
  const key = err?.response?.data?.error;
  if (key === 'errors.appointmentPastorUnavailable') return t('appointments.pastorUnavailable');
  return apiErrorMessage(err, fallback);
}

export default function Appointments() {
  const { t } = useTranslation();
  const [appointments, setAppointments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [response, setResponse] = useState({ date: '', time: '', notes: '' });

  const load = useCallback(() => {
    setLoading(true);
    // A deployment can briefly answer while the API is restarting. Retry once
    // before showing an error so the page does not turn a transient outage into
    // a misleading "not available" state.
    const request = (attempt = 0) => api.get('/appointments').catch((err) => {
      if (attempt === 0 && [404, 502, 503].includes(err?.response?.status)) {
        return new Promise((resolve) => window.setTimeout(resolve, 500)).then(() => request(1));
      }
      throw err;
    });
    request()
      .then(({ data }) => { setAppointments(data.appointments || []); setError(''); })
      .catch((err) => setError(appointmentError(err, t('appointments.loadFailed'), t)))
      .finally(() => setLoading(false));
  }, [t]);
  useEffect(() => { load(); }, [load]);

  const pending = useMemo(() => appointments.filter((a) => ['pending', 'rescheduled'].includes(a.status)), [appointments]);
  const upcoming = useMemo(() => appointments
    .filter((a) => a.status === 'confirmed')
    .sort((a, b) => `${appointmentDate(a)} ${appointmentTime(a)}`.localeCompare(`${appointmentDate(b)} ${appointmentTime(b)}`)), [appointments]);

  async function respond(id, status, extra = {}) {
    setBusyId(id); setError(''); setNotice('');
    try {
      await api.patch(`/appointments/${id}/respond`, { status, ...extra });
      setNotice(t(`appointments.response_${status}`));
      setOpenId(null); load();
    } catch (err) { setError(appointmentError(err, t('appointments.responseFailed'), t)); }
    finally { setBusyId(null); }
  }

  function openResponse(a) {
    setOpenId(a.id);
    setResponse({ date: a.proposedDate || a.requestedDate, time: a.proposedTime || a.requestedTime, notes: '' });
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-700"><CalendarClock size={15} /> {t('appointments.sectionLabel')}</p>
        <h1 className="font-display text-xl font-semibold">{t('appointments.title')}</h1>
        <p className="mt-1 text-sm text-ink-500">{t('appointments.subtitle')}</p>
      </header>
      {error && <StatusBanner type="error" message={error} />}
      {notice && <StatusBanner type="success" message={notice} />}
      {loading ? <p className="py-10 text-center text-sm text-ink-400">{t('common.loading')}</p> : (
        <>
          <section className="rounded-xl border border-ink-200 bg-paper p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between gap-3"><div><h2 className="font-display text-base font-semibold">{t('appointments.pendingTitle')}</h2><p className="text-xs text-ink-400">{t('appointments.pendingHint')}</p></div><span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">{pending.length}</span></div>
            {pending.length === 0 ? <p className="py-6 text-center text-sm text-ink-400">{t('appointments.noPending')}</p> : (
              <ul className="divide-y divide-ink-100">
                {pending.map((a) => (
                  <li key={a.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0"><p className="font-medium text-ink-900">{a.purpose}</p><p className="mt-0.5 text-sm text-ink-600">{a.requesterName} · {appointmentDate(a)} · {appointmentTime(a)}</p>{a.requesterNotes && <p className="mt-1 text-xs text-ink-400">{a.requesterNotes}</p>}</div>
                      <div className="flex shrink-0 items-center gap-2"><button type="button" disabled={busyId === a.id} onClick={() => respond(a.id, 'confirmed')} className="btn btn-primary px-3 py-1.5 text-xs"><Check size={14} /> {t('appointments.confirm')}</button><button type="button" disabled={busyId === a.id} onClick={() => (openId === a.id ? setOpenId(null) : openResponse(a))} className="text-xs font-medium text-ink-500 hover:text-ink-900">{t('appointments.cantMakeIt')}</button></div>
                    </div>
                    {openId === a.id && (
                      <div className="mt-3 rounded-lg bg-ink-50 p-3">
                        <div className="flex flex-wrap gap-2"><button type="button" disabled={busyId === a.id} onClick={() => respond(a.id, 'declined', { pastorNotes: response.notes })} className="btn btn-secondary px-3 py-1.5 text-xs"><X size={14} /> {t('appointments.decline')}</button><button type="button" disabled={busyId === a.id} onClick={() => respond(a.id, 'rescheduled', { proposedDate: response.date, proposedTime: response.time, pastorNotes: response.notes })} className="btn btn-secondary px-3 py-1.5 text-xs"><ChevronRight size={14} /> {t('appointments.proposeTime')}</button></div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-3"><input type="date" value={response.date} onChange={(e) => setResponse({ ...response, date: e.target.value })} className="rounded-md border border-ink-200 px-2 py-1.5 text-sm" /><input type="time" value={response.time} onChange={(e) => setResponse({ ...response, time: e.target.value })} className="rounded-md border border-ink-200 px-2 py-1.5 text-sm" /><input value={response.notes} onChange={(e) => setResponse({ ...response, notes: e.target.value })} placeholder={t('appointments.responseNotesPlaceholder')} className="rounded-md border border-ink-200 px-2 py-1.5 text-sm" /></div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-xl border border-ink-200 bg-paper p-4 shadow-sm">
            <h2 className="mb-3 font-display text-base font-semibold">{t('appointments.upcomingTitle')}</h2>
            {upcoming.length === 0 ? <p className="py-6 text-center text-sm text-ink-400">{t('appointments.noUpcoming')}</p> : <ul className="divide-y divide-ink-100">{upcoming.map((a) => <li key={a.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"><span className="min-w-0"><span className="block truncate font-medium text-ink-900">{a.requesterName} · {a.purpose}</span><span className="text-sm text-ink-500">{appointmentDate(a)} · {appointmentTime(a)}</span></span><span className="cat-chip category-success">{t('appointments.status_confirmed')}</span></li>)}</ul>}
          </section>
        </>
      )}
    </div>
  );
}
