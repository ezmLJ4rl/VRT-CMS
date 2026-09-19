import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import api, { apiErrorMessage } from '../api';
import StatusBanner from '../components/StatusBanner';
import { useAuth } from '../context/AuthContext';

function timeLabel(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export default function MessageThreadDetail() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { threadKey } = useParams();
  const [messages, setMessages] = useState([]);
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/messages/${threadKey}`)
      .then(({ data }) => {
        setMessages(data.messages || []);
        const unread = (data.messages || []).filter((message) => !message.read_at && message.sender_id !== user?.id);
        Promise.all(unread.map((message) => api.patch(`/messages/${message.id}/read`).catch(() => {})));
      })
      .catch((err) => setError(apiErrorMessage(err, t('messages.detailLoadFailed'))))
      .finally(() => setLoading(false));
  }, [threadKey, t, user?.id]);

  useEffect(() => { load(); }, [load]);

  const partnerId = useMemo(() => {
    const message = messages.find((item) => item.sender_id !== user?.id) || messages[0];
    return message?.sender_id === user?.id ? message?.recipient_id : message?.sender_id;
  }, [messages, user?.id]);

  async function sendReply(event) {
    event.preventDefault();
    if (!reply.trim() || !partnerId) return;
    setSending(true);
    try {
      const subject = messages[0]?.subject || t('messages.title');
      await api.post('/messages', { recipientId: partnerId, category: 'general', subject: `Re: ${subject.replace(/^Re: /, '')}`, body: reply.trim() });
      setReply('');
      load();
    } catch (err) {
      setError(apiErrorMessage(err, t('messages.sendFailed')));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <button type="button" onClick={() => navigate('/messages')} className="btn btn-ghost -ml-2"><ArrowLeft size={16} /> {t('messages.backToMessages')}</button>
      <header className="border-b border-ink-200 pb-4">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink-900">{t('messages.conversationDetail')}</h1>
      </header>
      {error && <StatusBanner type="error" message={error} />}
      {loading ? <p className="py-10 text-center text-sm text-ink-400">{t('common.loading')}</p> : (
        <>
          <ul className="space-y-2">
            {messages.map((message) => (
              <li key={message.id} className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${message.sender_id === user?.id ? 'ml-auto bg-brand-600 text-white' : 'bg-paper text-ink-800 shadow-sm ring-1 ring-ink-200'}`}>
                <p className="text-xs opacity-70">{message.sender_id === user?.id ? t('messages.you') : t('messages.frontDesk')} · {timeLabel(message.sent_at)}</p>
                {message.body && <p className="mt-1 whitespace-pre-wrap">{message.body}</p>}
              </li>
            ))}
          </ul>
          <form onSubmit={sendReply} className="flex gap-2 rounded-xl border border-ink-200 bg-paper p-3">
            <textarea value={reply} onChange={(event) => setReply(event.target.value)} rows={2} required placeholder={t('messages.replyPlaceholder')} className="flex-1 rounded-md border border-ink-200 px-3 py-2 text-sm" />
            <button type="submit" disabled={sending || !reply.trim()} className="btn btn-primary self-end" title={t('messages.send')}><Send size={15} /></button>
          </form>
        </>
      )}
    </div>
  );
}
