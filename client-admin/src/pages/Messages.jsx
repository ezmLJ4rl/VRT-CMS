import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MessageSquare, Send, ChevronRight, Inbox, Printer, Undo2 } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import StatusBanner from '../components/StatusBanner';
import { useAuth } from '../context/AuthContext';

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(d);
  if (sameDay) return time;
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(d);
}

// Event broadcasts carry the printable announcement in their payload: print it
// in a new window so the front desk can post it without leaving Messages.
function printEventSheet(b) {
  const sheet = b.payload && typeof b.payload.printable === 'string' ? b.payload.printable : b.body || '';
  const w = window.open('', '_blank', 'width=720,height=840');
  if (!w) return;
  w.document.write(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${(b.subject || '').replace(/</g, '&lt;')}</title>
<style>body{font-family:Georgia,'Times New Roman',serif;margin:48px;color:#111;white-space:pre-wrap;font-size:14px;line-height:1.6;}@media print{body{margin:12px;}}</style>
</head><body>${sheet.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}
<button onclick="window.print()" style="margin-top:24px;padding:10px 18px;font-size:14px;">Print</button>
</body></html>`
  );
  w.document.close();
  w.focus();
}

export default function Messages() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [conversations, setConversations] = useState({ threads: [], broadcasts: [] });
  const [activeThread, setActiveThread] = useState(null);
  const [threadMessages, setThreadMessages] = useState([]);
  const [compose, setCompose] = useState({ subject: '', body: '' });
  const [banner, setBanner] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  // What has already gone out to the pastor, so a mistake can be taken back here
  // rather than in the database. `pendingRecallId` is the row awaiting its
  // second click: a recall is irreversible, and an inline confirm keeps that
  // decision on the row it belongs to instead of in a browser dialog.
  const [sent, setSent] = useState([]);
  const [pendingRecallId, setPendingRecallId] = useState(null);
  const [recallingId, setRecallingId] = useState(null);

  function loadConversations() {
    api.get('/messages').then(({ data }) => setConversations(data.conversations)).catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  function loadSent() {
    return api
      .get('/messages/sent', { params: { to: 'pastor' } })
      .then(({ data }) => setSent(data.sent || []))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  useEffect(() => {
    loadConversations();
    loadSent();
    setLoading(false);
  }, []);

  async function recallMessage(m) {
    setRecallingId(m.id);
    setBanner(null);
    try {
      await api.post(`/messages/${m.id}/recall`);
      setPendingRecallId(null);
      setBanner({ type: 'success', message: t('messages.recalledBanner') });
      await Promise.all([loadSent(), Promise.resolve(loadConversations())]);
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setRecallingId(null);
    }
  }

  function openThread(thread) {
    setActiveThread(thread);
    setCompose({ subject: `Re: ${thread.last.subject.replace(/^Re: /, '')}`, body: '' });
    api
      .get(`/messages/${thread.id}`)
      .then(({ data }) => setThreadMessages(data.messages))
      .catch((err) => setBanner({ type: 'error', message: apiErrorMessage(err) }));
  }

  async function sendReply(e) {
    e.preventDefault();
    if (!activeThread) return;
    setSending(true);
    try {
      await api.post('/messages', {
        recipientId: activeThread.partner.id,
        category: 'general',
        subject: compose.subject || 'Re: message',
        body: compose.body,
      });
      setCompose({ subject: compose.subject, body: '' });
      loadConversations();
      api.get(`/messages/${activeThread.id}`).then(({ data }) => setThreadMessages(data.messages));
    } catch (err) {
      setBanner({ type: 'error', message: apiErrorMessage(err) });
    } finally {
      setSending(false);
    }
  }

  async function sendToPastor(e) {
    e.preventDefault();
    if (!compose.body.trim()) return;
    setSending(true);
    try {
      await api.post('/messages', { recipientRole: 'pastor', category: 'general', subject: compose.subject || 'Message for the pastor', body: compose.body });
      setCompose({ subject: '', body: '' });
      setBanner({ type: 'success', message: t('messages.sent') });
      loadConversations();
      loadSent();
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

  return (
    <AppShell>
      <h1 className="mb-5 font-display text-2xl font-semibold">{t('messages.title')}</h1>
      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          {/* Conversations */}
          <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
            <h2 className="mb-3 flex items-center gap-1.5 font-display text-lg font-semibold"><MessageSquare size={16} className="text-ink-600" /> {t('messages.conversations')}</h2>
            {loading ? (
              <p className="py-6 text-center text-sm text-ink-400">{t('common.loading')}</p>
            ) : sortedThreads.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-400">{t('common.empty')}</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {sortedThreads.map((thread) => (
                  <li key={thread.id}>
                    <button
                      type="button"
                      onClick={() => openThread(thread)}
                      className="flex w-full items-center gap-3 px-2 py-3 text-left hover:bg-ink-50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 text-sm font-medium text-ink-900">
                          <span className="truncate">{thread.partner?.name || t('messages.pastor')}</span>
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

          {/* Compose to pastor */}
          <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
            <h2 className="mb-3 font-display text-lg font-semibold">{t('messages.newToPastor')}</h2>
            <form onSubmit={sendToPastor} className="space-y-3">
              <input
                value={compose.subject}
                onChange={(e) => setCompose({ ...compose, subject: e.target.value })}
                placeholder={t('messages.subjectPlaceholder')}
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-sm focus-visible:border-brand-600"
              />
              <textarea
                value={compose.body}
                onChange={(e) => setCompose({ ...compose, body: e.target.value })}
                placeholder={t('messages.composePlaceholder')}
                rows={3}
                required
                className="w-full rounded-md border border-ink-200 px-3 py-2.5 text-sm focus-visible:border-brand-600"
              />
              <button
                type="submit"
                disabled={sending || !compose.body.trim()}
                className="btn btn-primary"
              >
                <Send size={14} /> {sending ? t('common.sending') : t('messages.send')}
              </button>
            </form>
          </section>

          {/* What went out, and the way to take it back.

              The compose form above only ever says "sent": after that the
              message is in the pastor's feed and nothing on this screen could
              reach it. This list closes that gap: the front desk sees its own
              sends (an admin sees everyone's) and can withdraw one.

              Recalled rows stay on the list, marked, because "what did we take
              back?" needs an answer, that record is the reason a recall never
              deletes the message. */}
          <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
            <h2 className="mb-3 flex items-center gap-1.5 font-display text-lg font-semibold">
              <Undo2 size={16} className="text-ink-600" /> {t('messages.sentToPastor')}
            </h2>
            {sent.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-400">{t('messages.sentEmpty')}</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {sent.map((m) => (
                  <li key={m.id} className="py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-ink-900">{m.subject}</p>
                        <p className="mt-0.5 truncate text-xs text-ink-400">
                          {timeLabel(m.sent_at)} · {m.read ? t('messages.read') : t('messages.unread')}
                          {/* Only an admin's list can hold someone else's send, so
                              the name is shown exactly when it is needed. */}
                          {m.sender_id !== user?.id && m.sender_name ? ` · ${m.sender_name}` : ''}
                        </p>
                      </div>
                      {m.recalled ? (
                        <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-xs font-medium text-ink-500">
                          {t('messages.recalled')}
                        </span>
                      ) : m.canRecall && pendingRecallId !== m.id ? (
                        <button
                          type="button"
                          onClick={() => setPendingRecallId(m.id)}
                          className="shrink-0 inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800"
                        >
                          <Undo2 size={13} /> {t('messages.recall')}
                        </button>
                      ) : null}
                    </div>
                    {pendingRecallId === m.id && (
                      <div className="mt-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
                        <p className="text-xs font-medium text-ink-800">{t('messages.recallConfirm')}</p>
                        <p className="mt-1 text-xs text-ink-500">{t('messages.recallNote')}</p>
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => recallMessage(m)}
                            disabled={recallingId === m.id}
                            className="btn btn-danger px-3 py-1.5 text-xs"
                          >
                            {recallingId === m.id ? t('common.saving') : t('messages.recallYes')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setPendingRecallId(null)}
                            disabled={recallingId === m.id}
                            className="btn btn-secondary px-3 py-1.5 text-xs"
                          >
                            {t('messages.recallNo')}
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="space-y-6 lg:col-span-2">
          {/* Pastor broadcasts */}
          <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
            <h2 className="mb-3 flex items-center gap-1.5 font-display text-lg font-semibold"><Inbox size={16} className="text-ink-600" /> {t('messages.pastorBroadcasts')}</h2>
            {conversations.broadcasts.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-400">{t('common.empty')}</p>
            ) : (
              <ul className="space-y-3">
                {conversations.broadcasts.map((b) => (
                  <li key={b.id} className="rounded-lg border border-ink-100 p-3">
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-sm font-semibold text-ink-900">{b.subject}</p>
                      <span className="shrink-0 text-xs text-ink-400">{timeLabel(b.sent_at)}</span>
                    </div>
                    {b.body && <p className="whitespace-pre-wrap text-sm text-ink-600">{b.body}</p>}
                    {b.category === 'event' && (
                      <button
                        type="button"
                        onClick={() => printEventSheet(b)}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-xs font-medium text-ink-700 hover:border-brand-600 hover:text-brand-800"
                      >
                        <Printer size={13} /> {t('events.printSheet')}
                      </button>
                    )}
                    <p className="mt-1 text-xs text-ink-400">{b.sender_id === user?.id ? t('messages.you') : ''}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Thread detail */}
          {activeThread ? (
            <section className="rounded-xl border border-ink-200 bg-paper p-5 shadow-sm">
              <h2 className="mb-3 font-display text-lg font-semibold">{activeThread.partner?.name || t('messages.pastor')}</h2>
              <ul className="mb-4 max-h-64 space-y-2 overflow-auto">
                {threadMessages.map((m) => (
                  <li key={m.id} className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${m.sender_id === user?.id ? 'ml-auto bg-brand-600 text-white' : 'bg-ink-100 text-ink-800'}`}>
                    <p className="text-xs opacity-70">
                      {m.sender_id === user?.id ? t('messages.you') : t('messages.pastor')} · {timeLabel(m.sent_at)}
                    </p>
                    {m.body && <p className="mt-0.5 whitespace-pre-wrap">{m.body}</p>}
                  </li>
                ))}
              </ul>
              <form onSubmit={sendReply} className="flex gap-2">
                <textarea
                  value={compose.body}
                  onChange={(e) => setCompose({ ...compose, body: e.target.value })}
                  rows={2}
                  required
                  placeholder={t('messages.replyPlaceholder')}
                  className="flex-1 rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                />
                <button type="submit" disabled={sending || !compose.body.trim()} className="btn btn-primary" title={t('messages.send')}>
                  <Send size={15} />
                </button>
              </form>
            </section>
          ) : (
            <p className="rounded-xl border border-dashed border-ink-200 p-6 text-center text-sm text-ink-400">{t('messages.pickThread')}</p>
          )}
        </div>
      </div>
    </AppShell>
  );
}