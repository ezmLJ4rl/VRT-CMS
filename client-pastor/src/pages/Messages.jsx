import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Send, ChevronDown, ChevronRight, Inbox, Users, HandCoins } from 'lucide-react';
import { m } from 'motion/react';
import { DURATION, EASE, settled, useSettled } from '../motion';
import api, { apiErrorMessage } from '../api';
import DataTable from '../components/DataTable';
import StatusBanner from '../components/StatusBanner';
import { useAuth } from '../context/AuthContext';
import { useUnread } from '../context/UnreadContext';
import { formatDate } from '../format';
import { attendanceMetrics } from '../attendanceMetrics';

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(d);
  if (sameDay) return time;
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(d);
}

function isRoutineGroupMembershipNotice(message) {
  if (message.record_type === 'group_update') return true;
  let payload = message.payload || {};
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { payload = {}; }
  }
  if (payload.group && (payload.changes || payload.total !== undefined || typeof payload.url === 'string')) return true;
  return /^group update\s*:/i.test(message.subject || '') || /\bsee the group\b/i.test(message.body || '');
}

function attendanceMetricsForMessage(t, session) {
  return attendanceMetrics(session).map((metric) => ({
    ...metric,
    label: t(metric.kind === 'unique' ? 'messages.uniqueAttendeesShort' : 'messages.recordedShort'),
  }));
}

function DigestCard({ t, i18n, b, onMarkRead }) {
  const p = b.payload || {};
  const [openNames, setOpenNames] = useState(false);
  const sessions = p.attendance || [];
  const gifts = p.offerings || [];
  return (
    <div className="overflow-hidden rounded-lg border border-people-200 bg-people-50">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-people-100 bg-white/60 px-3 py-2.5">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-semibold text-ink-900">
          <Inbox size={14} className="shrink-0 text-people-700" />
          {formatDate(p.date, i18n.language)} ·
          <span className="flex items-center gap-1 text-people-700"><Users size={13} className="shrink-0" /> {sessions.length} {t('messages.sessionsShort')}</span>
          <span className="flex items-center gap-1 text-offering-700"><HandCoins size={13} className="shrink-0" /> {Number(p.totalOfferings || 0).toLocaleString()} {p.currency || 'TZS'}</span>
        </p>
        {b.read_at ? (
          <span className="text-xs text-ink-400">{t('messages.read')}</span>
        ) : (
          <button type="button" onClick={onMarkRead} className="text-xs font-medium text-brand-700 hover:underline">
            {t('messages.markRead')}
          </button>
        )}
      </div>

      {sessions.length > 0 && (
        <div className="px-3 py-2.5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('messages.attendanceSection')}</p>
          {/* The one shared table pattern (components/DataTable): fixed columns
              under their headers, sticky header, and the same card reflow on
              narrow screens as every other list. */}
          <div className="rounded-lg border border-ink-100 bg-white p-3">
            <DataTable
              columns={[
                { key: 'label', header: t('messages.colSession'), render: (s) => <span className="font-medium text-ink-900">{s.label}</span> },
                {
                  key: 'count',
                  header: t('messages.colCount'),
                  width: 16,
                  align: 'right',
                  cardValue: true,
                  render: (s) => {
                    const metrics = attendanceMetricsForMessage(t, s);
                    return (
                      <span className="flex flex-wrap justify-end gap-1.5 font-semibold tabular-nums text-people-700">
                        {metrics.map((metric) => <span key={metric.kind}>{metric.count.toLocaleString()} {metric.label}</span>)}
                      </span>
                    );
                  },
                },
                {
                  key: 'names',
                  header: t('messages.colNames'),
                  width: 20,
                  align: 'right',
                  render: (s) =>
                    (s.attendees || []).length > 0 ? (
                      <button type="button" onClick={() => setOpenNames(!openNames)} className="inline-flex items-center gap-1 text-xs font-medium text-people-700 hover:underline">
                        {openNames ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        {s.attendees.length} {t('records.namesCount')}
                      </button>
                    ) : null,
                },
              ]}
              rows={sessions}
              keyOf={(s) => s.id}
              empty={null}
              expandedRow={(s) =>
                openNames && (s.attendees || []).length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {s.attendees.map((n, i) => (
                      <span key={i} className="rounded-full bg-white px-2.5 py-0.5 text-xs text-ink-700 ring-1 ring-ink-200">{n}</span>
                    ))}
                  </div>
                ) : null
              }
            />
          </div>
        </div>
      )}

      {gifts.length > 0 && (
        <div className="px-3 py-2.5">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('messages.offeringsSection')}</p>
          {/* Same shared pattern; the app-wide offerings column order. */}
          <div className="rounded-lg border border-ink-100 bg-white p-3">
            <DataTable
              columns={[
                { key: 'category', header: t('messages.colCategory'), render: (g) => <span className="cat-chip category-offering">{g.category}</span> },
                {
                  key: 'giver',
                  header: t('messages.colGiver'),
                  render: (g) =>
                    // A general offering needs no name, so an empty giver is a
                    // normal record, not missing data: say so instead of
                    // printing a bare dash that reads like a broken value.
                    g.giver || (
                      <span className="text-ink-400" title={t('messages.noNameRecorded')}>
                        {t('common.anonymous')}
                      </span>
                    ),
                },
                { key: 'service', header: t('messages.colService'), width: 24, render: (g) => <span className="text-xs text-ink-500">{g.service}{g.receipt ? ` · ${g.receipt}` : ''}</span> },
                {
                  key: 'amount',
                  header: t('messages.colAmount'),
                  width: 18,
                  align: 'right',
                  cardValue: true,
                  render: (g) => <span className="font-semibold tabular-nums text-offering-700">{Number(g.amount).toLocaleString()} {g.currency}</span>,
                },
              ]}
              rows={gifts}
              keyOf={(g) => g.id}
              empty={null}
            />
          </div>
        </div>
      )}

      {b.body && !sessions.length && !gifts.length && <p className="whitespace-pre-wrap px-3 py-2.5 text-sm text-ink-600">{b.body}</p>}
    </div>
  );
}

/**
 * One notice from the front desk, arriving as a notice should.
 *
 * Only a notice that appears WHILE the pastor is on this screen animates: the
 * screen polls every 20 seconds (see loadConversations), and the first load is
 * the baseline: opening Messages must not set the whole feed moving, and the
 * home view stays calm for the same reason.
 *
 * The settle class is the part that matters most here: it puts the notice in
 * its resting state once the arrival would be over, so a summary the desk just
 * sent cannot end up invisible because the phone never painted a frame.
 */
function BroadcastNotice({ fresh, children }) {
  const done = useSettled(fresh ? true : null);
  if (!fresh) return <li>{children}</li>;
  return (
    <m.li
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.notice, ease: EASE }}
      className={settled('', done)}
    >
      {children}
    </m.li>
  );
}

export default function Messages() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  // The badge is not this screen's to own: it re-reads the shared count after
  // clearing something, so the nav pill and the Home tile stay in step.
  const { refresh: refreshUnread } = useUnread();
  const [conversations, setConversations] = useState({ threads: [], broadcasts: [] });
  const [activeThread, setActiveThread] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [banner, setBanner] = useState(null);
  const [sending, setSending] = useState(false);
  // The broadcast ids already on screen, so the next poll can tell which ones
  // the desk has just added, and those are the only ones that animate in.
  const seenBroadcasts = useRef(null);
  const [freshBroadcasts, setFreshBroadcasts] = useState([]);

  function loadConversations() {
    api
      .get('/messages')
      .then(({ data }) => {
        // Group/member roster changes are administrative history, not Pastor
        // notifications. The server filters them too; this client-side guard
        // protects older servers or already-cached responses from resurfacing
        // those rows in the Pastor feed.
        const list = (data.conversations.broadcasts || []).filter((b) => !isRoutineGroupMembershipNotice(b));
        const seen = seenBroadcasts.current;
        seenBroadcasts.current = new Set(list.map((b) => b.id));
        // Compared in the loader rather than in render: the previous set is the
        // thing being compared, and a ref read during render is exactly the kind
        // of value React cannot guarantee is fresh.
        if (seen) setFreshBroadcasts(list.filter((b) => !seen.has(b.id)).map((b) => b.id));
        setConversations({ ...data.conversations, broadcasts: list });
        // Broadcasts stay unread until the Pastor explicitly opens the item or
        // presses its Mark as read action. Loading this canonical feed is never
        // treated as having read every notification.
      })
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  useEffect(() => {
    loadConversations();
    const interval = setInterval(loadConversations, 20000);
    return () => clearInterval(interval);
  }, [refreshUnread]);

  async function markBroadcastRead(b) {
    if (b.read_at) return;
    await api.patch(`/messages/${b.id}/read`).catch(() => {});
    setConversations((prev) => ({
      ...prev,
      broadcasts: prev.broadcasts.map((item) => (item.id === b.id ? { ...item, read_at: new Date().toISOString() } : item)),
    }));
    refreshUnread();
  }

  function openThread(thread) {
    setActiveThread(thread);
    api
      .get(`/messages/${thread.id}`)
      .then(({ data }) => {
        setThreadMessages(data.messages);
        const unread = data.messages.filter((m) => !m.read_at);
        if (unread.length) {
          Promise.all(unread.map((m) => api.patch(`/messages/${m.id}/read`).catch(() => {}))).then(() => refreshUnread());
        }
        loadConversations();
      })
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  async function sendReply(e) {
    e.preventDefault();
    if (!activeThread || !reply.trim()) return;
    setSending(true);
    try {
      await api.post('/messages', {
        recipientId: activeThread.partner.id,
        category: 'general',
        subject: `Re: ${activeThread.last.subject.replace(/^Re: /, '')}`,
        body: reply,
      });
      setReply('');
      loadConversations();
      api.get(`/messages/${activeThread.id}`).then(({ data }) => setThreadMessages(data.messages));
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSending(false);
    }
  }

  const sortedThreads = useMemo(
    () => [...conversations.threads].sort((a, b) => new Date(b.last.sentAt) - new Date(a.last.sentAt)),
    [conversations.threads]
  );
  const unreadBroadcasts = conversations.broadcasts.filter((item) => !item.read_at).length;
  const unreadThreads = sortedThreads.reduce((total, thread) => total + Number(thread.unread || 0), 0);
  const unreadTotal = unreadBroadcasts + unreadThreads;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-ink-200 pb-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">{t('messages.fromFrontDesk')}</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink-900">{t('messages.title')}</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-500">{t('messages.subtitle', 'Important updates and conversations in one place.')}</p>
        </div>
        <div className="rounded-xl border border-ink-200 bg-paper px-4 py-2 text-right shadow-xs">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">{t('messages.unread', 'Unread')}</p>
          <p className="font-display text-xl font-semibold tabular-nums text-brand-700">{unreadTotal}</p>
        </div>
      </header>
      {banner && (
        <div className="mb-3">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      {conversations.broadcasts.filter((b) => !isRoutineGroupMembershipNotice(b)).length > 0 && (
        <section className="rounded-2xl border border-ink-200 bg-paper p-3 shadow-sm sm:p-4">
          <div className="mb-3 flex items-center justify-between gap-3 border-b border-ink-100 pb-3">
            <h2 className="flex items-center gap-1.5 font-display text-base font-semibold"><Inbox size={15} className="text-ink-600" /> {t('messages.fromFrontDesk')}</h2>
            <span className="text-xs text-ink-400">{conversations.broadcasts.length} {t('messages.updates', 'updates')}</span>
          </div>
          <ul className="space-y-2.5">
            {conversations.broadcasts.filter((b) => !isRoutineGroupMembershipNotice(b)).map((b) => (
              <BroadcastNotice key={b.id} fresh={freshBroadcasts.includes(b.id)}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-ink-900">{b.payload?.attendance || b.payload?.offerings ? t('messages.dailySummary') : b.subject}</p>
                  <span className="shrink-0 text-xs text-ink-400">{timeLabel(b.sent_at)}</span>
                </div>
                {b.payload?.attendance || b.payload?.offerings ? (
                  <DigestCard t={t} i18n={i18n} b={b} onMarkRead={() => markBroadcastRead(b)} />
                ) : (
                  <div className="rounded-lg border border-ink-100 p-3">
                    {b.body && <p className="whitespace-pre-wrap text-sm text-ink-600">{b.body}</p>}
                    {!b.read_at && (
                      <button type="button" onClick={() => markBroadcastRead(b)} className="mt-2 text-xs font-medium text-brand-700 hover:underline">
                        {t('messages.markRead')}
                      </button>
                    )}
                  </div>
                )}
              </BroadcastNotice>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-2xl border border-ink-200 bg-paper p-3 shadow-sm sm:p-4">
        <div className="mb-2 flex items-center justify-between gap-3 border-b border-ink-100 pb-3">
          <h2 className="flex items-center gap-1.5 font-display text-base font-semibold"><MessageSquare size={15} className="text-brand-700" /> {t('messages.conversations')}</h2>
          <span className="text-xs text-ink-400">{sortedThreads.length} {t('messages.threads', 'conversations')}</span>
        </div>
        {sortedThreads.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">{t('common.empty')}</p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {sortedThreads.map((thread) => (
              <li key={thread.id}>
                <button type="button" onClick={() => openThread(thread)} className="flex w-full items-center gap-3 py-3 text-left">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                      <span className="truncate">{thread.partner?.name || t('messages.frontDesk')}</span>
                      {thread.unread > 0 && (
                        <span className="rounded-full bg-brand-600 px-2 py-0.5 text-xs font-bold text-white">{thread.unread}</span>
                      )}
                    </p>
                    <p className="truncate text-xs text-ink-400">{thread.last.subject}</p>
                  </div>
                  <span className="shrink-0 text-xs text-ink-400">{timeLabel(thread.last.sentAt)}</span>
                  <ChevronRight size={15} className="shrink-0 text-ink-300" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {activeThread ? (
        <section className="rounded-xl border border-ink-200 bg-paper p-4 shadow-sm">
          <h2 className="mb-2 font-display text-base font-semibold">{activeThread.partner?.name || t('messages.frontDesk')}</h2>
          <ul className="mb-3 max-h-80 space-y-2 overflow-auto">
            {threadMessages.map((m) => (
              <li key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.sender_id === user?.id ? 'ml-auto bg-brand-600 text-white' : 'bg-ink-100 text-ink-800'}`}>
                <p className="text-xs opacity-70">{m.sender_id === user?.id ? t('messages.you') : t('messages.frontDesk')} · {timeLabel(m.sent_at)}</p>
                {m.body && <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>}
              </li>
            ))}
          </ul>
          <form onSubmit={sendReply} className="flex gap-2">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={2}
              required
              placeholder={t('messages.replyPlaceholder')}
              className="flex-1 rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
            />
            <button type="submit" disabled={sending || !reply.trim()} className="btn btn-primary" title={t('messages.send')}>
              <Send size={15} />
            </button>
          </form>
        </section>
      ) : (
        <p className="rounded-xl border border-dashed border-ink-200 p-6 text-center text-sm text-ink-400">{t('messages.pickThread')}</p>
      )}
    </div>
  );
}