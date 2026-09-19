import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Send, ChevronDown, ChevronRight, Inbox, Users, HandCoins } from 'lucide-react';
import { m } from 'motion/react';
import { DURATION, EASE, settled, useSettled } from '../motion';
import api, { apiErrorMessage } from '../api';
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

function churchTodayISO() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Dar_es_Salaam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function digestTitle(t, i18n, date) {
  if (date === churchTodayISO()) return t('messages.dailySummaryToday');
  return t('messages.dailySummaryForDate', { date: formatDate(date, i18n.language) });
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

function mergeDigestBroadcasts(broadcasts) {
  const merged = [];
  const byDate = new Map();
  for (const broadcast of broadcasts) {
    const payload = broadcast.payload;
    if (!payload?.date || (!payload.attendance && !payload.offerings)) {
      merged.push(broadcast);
      continue;
    }
    const existing = byDate.get(payload.date);
    if (!existing) {
      const copy = { ...broadcast, payload: { ...payload }, sourceIds: [broadcast.id] };
      byDate.set(payload.date, copy);
      merged.push(copy);
      continue;
    }
    const attendance = new Map([...(existing.payload.attendance || []), ...(payload.attendance || [])].map((row) => [String(row.id), row]));
    const offerings = new Map([...(existing.payload.offerings || []), ...(payload.offerings || [])].map((row) => [String(row.id), row]));
    existing.payload = {
      ...existing.payload,
      attendance: [...attendance.values()],
      offerings: [...offerings.values()],
      attendanceSessions: attendance.size,
      totalOfferings: [...offerings.values()].reduce((sum, row) => sum + Number(row.amount || 0), 0),
    };
    existing.sourceIds = [...existing.sourceIds, broadcast.id];
    if (!existing.read_at || !broadcast.read_at) existing.read_at = null;
    if (new Date(broadcast.sent_at) > new Date(existing.sent_at)) existing.sent_at = broadcast.sent_at;
  }
  return merged;
}

function attendanceMetricsForMessage(t, session) {
  return attendanceMetrics(session).map((metric) => ({
    ...metric,
    label: t(metric.kind === 'unique' ? 'messages.uniqueAttendeesShort' : 'messages.recordedShort'),
  }));
}

function groupAttendance(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const name = session.typeName || session.label || 'Service';
    if (!groups.has(name)) groups.set(name, { name, sessions: [], total: 0 });
    const group = groups.get(name);
    group.sessions.push(session);
    group.total += Number(session.recordedCount ?? session.count ?? 0);
  }
  return [...groups.values()];
}

function groupOfferings(gifts) {
  const groups = new Map();
  for (const gift of gifts) {
    const name = gift.category || gift.type || 'Offering';
    const currency = gift.currency || 'TZS';
    const key = `${name}:${currency}`;
    if (!groups.has(key)) groups.set(key, { name, currency, gifts: [], total: 0 });
    const group = groups.get(key);
    group.gifts.push(gift);
    group.total += Number(gift.amount || 0);
  }
  return [...groups.values()];
}

function DigestCard({ t, i18n, b, onMarkRead }) {
  const p = b.payload || {};
  const sessions = p.attendance || [];
  const gifts = p.offerings || [];
  const attendanceGroups = groupAttendance(sessions);
  const offeringGroups = groupOfferings(gifts);
  const [openGroups, setOpenGroups] = useState(new Set());

  function toggle(key) {
    setOpenGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <div className="overflow-hidden rounded-lg border border-people-200 bg-people-50">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-people-100 bg-white/60 px-3 py-2.5">
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm font-semibold text-ink-900">
          <Inbox size={14} className="shrink-0 text-people-700" />
          {formatDate(p.date, i18n.language)} ·
          <span className="flex items-center gap-1 text-people-700"><Users size={13} className="shrink-0" /> {sessions.length} {t('messages.sessionsShort')}</span>
          <span className="flex items-center gap-1 text-offering-700"><HandCoins size={13} className="shrink-0" /> {Number(p.totalOfferings || 0).toLocaleString()} {p.currency || 'TZS'}</span>
        </p>
        {b.read_at ? <span className="text-xs text-ink-400">{t('messages.read')}</span> : <button type="button" onClick={onMarkRead} className="text-xs font-medium text-brand-700 hover:underline">{t('messages.markRead')}</button>}
      </div>

      {attendanceGroups.length > 0 && (
        <section className="px-3 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('messages.attendanceSection')}</p>
          <div className="space-y-2">
            {attendanceGroups.map((group) => {
              const key = `attendance:${group.name}`;
              const open = openGroups.has(key);
              return (
                <div key={key} className="rounded-lg bg-white/80 px-3 py-2.5">
                  <button type="button" aria-expanded={open} onClick={() => toggle(key)} className="flex w-full items-center justify-between gap-3 text-left">
                    <span className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-people-700">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span><span className="truncate font-semibold text-ink-900">{group.name}</span></span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-people-700">{group.total.toLocaleString()} {t('messages.recordedShort')}</span>
                  </button>
                  {open && <div className="mt-2 space-y-2 border-t border-ink-100 pt-2">{group.sessions.map((session) => <div key={session.id} className="pl-6"><div className="flex items-start justify-between gap-3 text-sm"><span className="text-ink-700">{session.subSession || t('messages.sessionDetail')}</span><span className="shrink-0 text-right font-medium tabular-nums text-people-700">{attendanceMetricsForMessage(t, session).map((metric) => <span key={metric.kind} className="ml-2">{metric.count.toLocaleString()} {metric.label}</span>)}</span></div>{session.attendees?.length > 0 && <p className="mt-1 text-xs leading-relaxed text-ink-400">{session.attendees.join(', ')}</p>}</div>)}</div>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {offeringGroups.length > 0 && (
        <section className="px-3 pb-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-400">{t('messages.offeringsSection')}</p>
          <div className="space-y-2">
            {offeringGroups.map((group) => {
              const key = `offering:${group.name}:${group.currency}`;
              const open = openGroups.has(key);
              return (
                <div key={key} className="rounded-lg bg-white/80 px-3 py-2.5">
                  <button type="button" aria-expanded={open} onClick={() => toggle(key)} className="flex w-full items-center justify-between gap-3 text-left"><span className="flex min-w-0 items-center gap-2"><span className="shrink-0 text-offering-700">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span><span className="truncate font-semibold text-ink-900">{group.name}</span></span><span className="shrink-0 text-sm font-semibold tabular-nums text-offering-700">{group.total.toLocaleString()} {group.currency}</span></button>
                  {open && <div className="mt-2 space-y-2 border-t border-ink-100 pt-2">{group.gifts.map((gift) => <div key={gift.id} className="grid gap-0.5 pl-6 text-sm sm:grid-cols-[1fr_auto]"><span className="text-ink-600">{gift.giver || t('common.anonymous')}<span className="text-xs text-ink-400">{gift.service ? ` · ${gift.service}` : ''}{gift.receipt ? ` · ${gift.receipt}` : ''}</span></span><span className="font-medium tabular-nums text-offering-700">{Number(gift.amount).toLocaleString()} {gift.currency}</span></div>)}</div>}
                </div>
              );
            })}
          </div>
        </section>
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
        const list = mergeDigestBroadcasts(
          (data.conversations.broadcasts || []).filter((b) => !isRoutineGroupMembershipNotice(b))
        );
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
    const sourceIds = b.sourceIds || [b.id];
    await Promise.all(sourceIds.map((id) => api.patch(`/messages/${id}/read`).catch(() => {})));
    setConversations((prev) => ({
      ...prev,
      broadcasts: prev.broadcasts.map((item) => (sourceIds.includes(item.id) || item.id === b.id ? { ...item, read_at: new Date().toISOString() } : item)),
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
                  <p className="text-sm font-semibold text-ink-900">{b.payload?.attendance || b.payload?.offerings ? (b.payload.date ? digestTitle(t, i18n, b.payload.date) : t('messages.dailySummary')) : b.subject}</p>
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