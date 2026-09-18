import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MapPin, CalendarRange, FileText, Printer, CheckCircle2, ArchiveRestore, Megaphone } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import StatusBanner from '../components/StatusBanner';

function fmt(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
}

const kindBadge = (k) =>
  k === 'service' ? 'category-people' : k === 'giving' ? 'category-offering' : k === 'conference' ? 'category-ink' : k === 'other' ? 'category-amber' : 'category-people';

// Open the server-rendered PDF event sheet. The GET needs the Authorization
// header (handled by the shared axios instance), so the PDF is fetched as a
// blob and opened in a new tab from an object URL.
async function printSheet(event) {
  try {
    const res = await api.get(`/events/${event.id}/printable-sheet`, { params: { format: 'pdf' }, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const w = window.open(url, '_blank');
    if (!w) {
      URL.revokeObjectURL(url);
      return;
    }
    // Give the tab a moment to load, then release the blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    console.warn('print sheet failed', err);
  }
}

export default function Events() {
  const { t } = useTranslation();
  const [published, setPublished] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [banner, setBanner] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [reports, setReports] = useState({});

  // SMS the announcement to members (one blast per event); email covers members
  // without a phone. The response reports both channels.
  async function announce(e) {
    if (!window.confirm(t('events.announceConfirm'))) return;
    setBusyId(e.id);
    setBanner(null);
    try {
      const { data } = await api.post(`/events/${e.id}/announce`);
      setBanner({
        type: 'success',
        message: t('events.announced', { count: data.recipients, sms: data.sms, email: data.email }),
      });
      setReports((prev) => ({
        ...prev,
        [e.id]: { sms: { sent: data.sms, failed: 0, pending: 0 }, email: { sent: data.email, failed: 0, pending: 0 } },
      }));
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setBusyId(null);
    }
  }

  function load() {
    api
      .get('/events', { params: { status: 'published' } })
      .then(({ data }) => {
        setPublished(data.events);
        // Pull the delivery report for every already-announced event.
        for (const ev of data.events) {
          if (!ev.announced_at) continue;
          api
            .get(`/events/${ev.id}/announce-report`)
            .then(({ data: rep }) => setReports((prev) => ({ ...prev, [ev.id]: rep.channels })))
            .catch(() => {});
        }
      })
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
    api
      .get('/events', { params: { status: 'draft' } })
      .then(({ data }) => setDrafts(data.events))
      .catch(() => {});
  }

  useEffect(load, []);

  async function finalize(e) {
    if (!window.confirm(t('events.finalizeConfirm', { title: e.title }))) return;
    setBusyId(e.id);
    setBanner(null);
    try {
      const { data } = await api.post(`/events/${e.id}/finalize`);
      setBanner({
        type: 'success',
        message: t('events.finalized', {
          att: data.summary.attendance,
          gifts: data.summary.gifts,
          total: Number(data.summary.offerings).toLocaleString(),
        }),
      });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl font-semibold">{t('events.title')}</h1>
      <p className="mb-5 text-sm text-ink-400">{t('events.subtitle')}</p>

      {banner && <StatusBanner type={banner.type} message={banner.message} />}

      <section className="mb-6">
        <h2 className="mb-2 flex items-center gap-2 font-display text-base font-semibold text-brand-900">
          <CalendarRange size={16} /> {t('events.calendar')}
        </h2>
        <ul className="space-y-2.5">
          {published.map((e) => (
            <li key={e.id} className="rounded-xl border border-ink-200 bg-paper p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`cat-chip ${kindBadge(e.kind)}`}>{t(`events.kind_${e.kind}`)}</span>
                {e.starts_at < new Date().toISOString() && <span className="cat-chip category-ink">{t('events.pastEvent')}</span>}
              </div>
              <h3 className="mt-2 font-display text-base font-semibold text-ink-900">{e.title}</h3>
              <p className="text-sm text-ink-500">{fmt(e.starts_at)}{e.ends_at ? ` – ${fmt(e.ends_at)}` : ''}</p>
              {e.location && (
                <p className="mt-0.5 text-sm text-ink-500"><MapPin size={13} className="mr-1 inline align-[-2px]" /> {e.location}</p>
              )}
              {e.description && <p className="mt-1 text-sm text-ink-600">{e.description}</p>}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <span className="cat-chip category-people">{t(`events.collection_${e.collection_type || 'attendance'}`)}</span>
                {e.workspace_service_id ? (
                  <span className="cat-chip category-success"><CheckCircle2 size={11} /> {t('events.workspaceReady')}</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => printSheet(e)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800"
                >
                  <Printer size={13} /> {t('events.printSheet')}
                </button>
                {e.workspace_service_id && (
                  <button
                    type="button"
                    onClick={() => finalize(e)}
                    disabled={busyId === e.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800 disabled:opacity-60"
                  >
                    <ArchiveRestore size={13} /> {t('events.finalize')}
                  </button>
                )}
                {!e.announced_at && (
                  <button
                    type="button"
                    onClick={() => announce(e)}
                    disabled={busyId === e.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800 disabled:opacity-60"
                  >
                    <Megaphone size={13} /> {t('events.announce')}
                  </button>
                )}
                {e.announced_at && (
                  <span className="cat-chip category-success"><Megaphone size={11} /> {t('events.announcedBadge')}</span>
                )}
              </div>
              {reports[e.id] && (
                <p className="mt-2 text-xs text-ink-500">
                  {t('events.deliveryReport', {
                    smsSent: reports[e.id].sms.sent,
                    emailSent: reports[e.id].email.sent,
                    smsFailedSuffix: reports[e.id].sms.failed
                      ? t('events.deliveryFailedSuffix', { smsFailed: reports[e.id].sms.failed })
                      : '',
                  })}
                </p>
              )}
            </li>
          ))}
          {published.length === 0 && <li className="rounded-xl border border-ink-200 bg-paper p-6 text-center text-sm text-ink-400">{t('events.noEvents')}</li>}
        </ul>
      </section>

      {drafts.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 font-display text-base font-semibold text-brand-900">
            <FileText size={16} /> {t('events.drafts')}
          </h2>
          <p className="mb-2 text-xs text-ink-400">{t('events.draftNote')}</p>
          <ul className="space-y-2">
            {drafts.map((e) => (
              <li key={e.id} className="rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-3">
                <div className="flex items-center gap-2">
                  <span className={`cat-chip ${kindBadge(e.kind)}`}>{t(`events.kind_${e.kind}`)}</span>
                  <span className="cat-chip category-amber">{t('events.draft')}</span>
                </div>
                <p className="mt-1 text-sm font-medium text-ink-900">{e.title}</p>
                <p className="text-xs text-ink-500">{fmt(e.starts_at)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}
