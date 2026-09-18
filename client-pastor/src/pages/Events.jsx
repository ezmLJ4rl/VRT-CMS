import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Save, Send, RotateCcw, Trash2, MapPin, Calendar, X, Eye, ArchiveRestore, Megaphone } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import StatusBanner from '../components/StatusBanner';

const KINDS = ['event', 'service', 'giving', 'conference', 'other'];
const COLLECTION_TYPES = ['attendance', 'offerings', 'both'];
const EMPTY = { title: '', description: '', location: '', startsAt: '', endsAt: '', kind: 'event', collectionType: 'attendance' };

function prettyDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export default function Events() {
  const { t } = useTranslation();
  const [events, setEvents] = useState([]);
  const [tab, setTab] = useState('calendar');
  const [banner, setBanner] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [workingId, setWorkingId] = useState(null);
  const [reports, setReports] = useState({});

  // Ids whose delivery report has already been fetched this session: keeps the
  // polling load() from re-requesting reports without coupling it to state.
  const reportFetched = useRef(new Set());

  function load() {
    api
      .get('/events')
      .then(({ data }) => {
        setEvents(data.events);
        // Delivery report for every already-announced event.
        for (const ev of data.events) {
          if (!ev.announced_at || reportFetched.current.has(ev.id)) continue;
          reportFetched.current.add(ev.id);
          api
            .get(`/events/${ev.id}/announce-report`)
            .then(({ data: rep }) => setReports((prev) => ({ ...prev, [ev.id]: rep.channels })))
            .catch(() => reportFetched.current.delete(ev.id));
        }
      })
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  useEffect(load, []);

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function openEdit(e) {
    setEditingId(e.id);
    setForm({ title: e.title, description: e.description || '', location: e.location || '', startsAt: e.starts_at, endsAt: e.ends_at || '', kind: e.kind, collectionType: e.collection_type || 'attendance' });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setBanner(null);
    setSaving(true);
    try {
      const body = { ...form };
      body.endsAt = body.endsAt || null;
      if (editingId) {
        await api.patch(`/events/${editingId}`, body);
        setBanner({ type: 'success', message: t('events.saved') });
      } else {
        await api.post('/events', body);
        setBanner({ type: 'success', message: t('events.created') });
      }
      setShowForm(false);
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSaving(false);
    }
  }

  async function publish(e) {
    setWorkingId(e.id);
    setBanner(null);
    try {
      await api.patch(`/events/${e.id}`, { status: 'published' });
      setBanner({ type: 'success', message: t('events.published') });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setWorkingId(null);
    }
  }

  async function unpublish(e) {
    setWorkingId(e.id);
    setBanner(null);
    try {
      await api.patch(`/events/${e.id}`, { status: 'draft' });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setWorkingId(null);
    }
  }

  // After the event has run: promote its data-collection workspace into the
  // permanent record and report back with the recorded totals.
  async function finalize(e) {
    if (!window.confirm(`${t('events.finalizeConfirm')} ${e.title}?`)) return;
    setWorkingId(e.id);
    setBanner(null);
    try {
      const { data } = await api.post(`/events/${e.id}/finalize`);
      setBanner({
        type: 'success',
        message: t('events.finalized', {
          att: data.summary.attendance,
          total: Number(data.summary.offerings).toLocaleString(),
        }),
      });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setWorkingId(null);
    }
  }

  // SMS the announcement to every member with a phone number (one blast per event).
  async function announce(e) {
    if (!window.confirm(`${t('events.announceConfirm')} ${e.title}?`)) return;
    setWorkingId(e.id);
    setBanner(null);
    try {
      const { data } = await api.post(`/events/${e.id}/announce`);
      setBanner({ type: 'success', message: t('events.announced', { count: data.recipients }) });
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setWorkingId(null);
    }
  }

  async function remove(e) {
    if (!window.confirm(`${t('events.removeConfirm')} ${e.title}?`)) return;
    setWorkingId(e.id);
    setBanner(null);
    try {
      await api.delete(`/events/${e.id}`);
      setBanner({ type: 'success', message: t('events.deleted') });
      if (editingId === e.id) { setShowForm(false); setEditingId(null); }
      load();
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setWorkingId(null);
    }
  }

  const shown = tab === 'drafts' ? events.filter((e) => e.status === 'draft') : events.filter((e) => e.status === 'published');
  const now = new Date().toISOString();

  const kindBadge = (k) =>
    k === 'service' ? 'category-people' : k === 'giving' ? 'category-offering' : k === 'conference' ? 'category-ink' : k === 'other' ? 'category-amber' : 'category-people';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">{t('events.title')}</h1>
          <p className="text-sm text-ink-400">{t('events.subtitle')}</p>
        </div>
        <button onClick={openCreate} className="btn btn-ink shrink-0">
          <Plus size={15} /> {t('events.new')}
        </button>
      </div>

      {banner && <StatusBanner type={banner.type} message={banner.message} />}

      <div className="flex gap-1 rounded-lg bg-ink-100 p-1">
        <button
          onClick={() => setTab('calendar')}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${tab === 'calendar' ? 'bg-paper text-brand-800 shadow-sm' : 'text-ink-500'}`}
        >
          <Calendar size={14} className="mr-1.5 inline align-[-2px]" /> {t('events.calendar')}
        </button>
        <button
          onClick={() => setTab('drafts')}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${tab === 'drafts' ? 'bg-paper text-brand-800 shadow-sm' : 'text-ink-500'}`}
        >
          <Eye size={14} className="mr-1.5 inline align-[-2px]" /> {t('events.drafts')}
          {events.filter((e) => e.status === 'draft').length > 0 && (
            <span className="ml-1.5 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-semibold text-white">
              {events.filter((e) => e.status === 'draft').length}
            </span>
          )}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="rounded-xl border border-ink-200 bg-paper p-4 shadow-sm">
          <h2 className="mb-3 font-display text-base font-semibold text-brand-900">
            {editingId ? t('events.editTitle') : t('events.newTitle')}
          </h2>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="ev-title">{t('events.title')}</label>
              <input id="ev-title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="ev-start">{t('events.startsAt')}</label>
                <input id="ev-start" type="datetime-local" value={form.startsAt} onChange={(e) => setForm({ ...form, startsAt: e.target.value })} required className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="ev-end">{t('events.endsAt')}</label>
                <input id="ev-end" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="ev-kind">{t('events.kind')}</label>
                <select id="ev-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600">
                  {KINDS.map((k) => (
                    <option key={k} value={k}>{t(`events.kind_${k}`)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="ev-loc">{t('events.location')}</label>
                <input id="ev-loc" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="ev-desc">{t('events.description')}</label>
              <textarea id="ev-desc" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-ink-700" htmlFor="ev-collection">{t('events.collectionType')}</label>
              <select id="ev-collection" value={form.collectionType} onChange={(e) => setForm({ ...form, collectionType: e.target.value })} className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-brand-600">
                {COLLECTION_TYPES.map((c) => (
                  <option key={c} value={c}>{t(`events.collection_${c}`)}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-400">{t('events.collectionNote')}</p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button type="submit" disabled={saving || !form.title.trim() || !form.startsAt} className="btn btn-offering">
              <Save size={15} /> {saving ? t('common.saving') : t('events.save')}
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditingId(null); }} className="flex items-center gap-2 rounded-md border border-ink-200 px-4 py-2.5 text-sm text-ink-700">
              <X size={15} /> {t('common.cancel')}
            </button>
          </div>
        </form>
      )}

      <ul className="space-y-2.5">
        {shown.map((e) => (
          <li key={e.id} className={`rounded-xl border border-ink-200 bg-paper p-4 shadow-sm ${e.status === 'draft' ? 'border-dashed' : ''}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`cat-chip ${kindBadge(e.kind)}`}>{t(`events.kind_${e.kind}`)}</span>
              <span className={`cat-chip ${e.status === 'draft' ? 'category-amber' : 'category-success'}`}>
                {e.status === 'draft' ? t('events.draft') : t('events.publishedLabel')}
              </span>
              {e.starts_at < now && e.status === 'published' && <span className="cat-chip category-ink">{t('events.pastEvent')}</span>}
            </div>
            <h3 className="mt-2 font-display text-base font-semibold text-ink-900">{e.title}</h3>
            {e.status === 'published' && (
              <span className="cat-chip category-ink">{t(`events.collection_${e.collection_type || 'attendance'}`)}</span>
            )}
            <p className="text-sm text-ink-500">{prettyDate(e.starts_at)}{e.ends_at ? ` – ${prettyDate(e.ends_at)}` : ''}</p>
            {e.location && (
              <p className="mt-0.5 text-sm text-ink-500">
                <MapPin size={13} className="mr-1 inline align-[-2px]" /> {e.location}
              </p>
            )}
            {e.description && <p className="mt-1.5 text-sm text-ink-600">{e.description}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => openEdit(e)} className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800">
                <Pencil size={13} /> {t('events.edit')}
              </button>
              {e.status === 'draft' ? (
                <button onClick={() => publish(e)} disabled={workingId === e.id} className="btn btn-ink !px-3 !py-1.5 text-xs">
                  <Send size={13} /> {t('events.publish')}
                </button>
              ) : (
                <button onClick={() => unpublish(e)} disabled={workingId === e.id} className="btn btn-secondary !px-3 !py-1.5 text-xs">
                  <RotateCcw size={13} /> {t('events.unpublish')}
                </button>
              )}
              {e.workspace_service_id && (
                <button onClick={() => finalize(e)} disabled={workingId === e.id} className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800 disabled:opacity-60">
                  <ArchiveRestore size={13} /> {t('events.finalize')}
                </button>
              )}
              {e.status === 'published' && !e.announced_at && (
                <button onClick={() => announce(e)} disabled={workingId === e.id} className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800 disabled:opacity-60">
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
            <div>
              <button onClick={() => remove(e)} disabled={workingId === e.id} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-danger-600 hover:bg-danger-50 disabled:opacity-60">
                <Trash2 size={13} /> {t('events.remove')}
              </button>
            </div>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="rounded-xl border border-ink-200 bg-paper p-6 text-center text-sm text-ink-400">
            {tab === 'drafts' ? t('events.noDrafts') : t('events.noEvents')}
          </li>
        )}
      </ul>
    </div>
  );
}