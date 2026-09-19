import { useEffect, useState } from 'react';
import { ArrowLeft, CalendarDays, Inbox, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import api, { apiErrorMessage } from '../api';
import StatusBanner from '../components/StatusBanner';
import { formatDate } from '../format';
import { DigestCard } from './Messages';

function isDigest(message) {
  return Boolean(message?.payload?.date && (message.payload.attendance || message.payload.offerings));
}

export default function MessageDetail() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { id } = useParams();
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get(`/messages/broadcast/${id}`)
      .catch((err) => {
        // Older API deployments may not yet expose the dedicated detail route.
        // The feed already contains the same full payload, so use it as a safe
        // compatibility fallback instead of showing a misleading "unavailable" error.
        if (err.response?.status !== 404) throw err;
        return api.get('/messages').then(({ data }) => {
          const message = (data.conversations.broadcasts || []).find((item) => String(item.id) === String(id));
          if (!message) throw err;
          return { data: { message } };
        });
      })
      .then(({ data }) => {
        if (!active) return;
        const openedMessage = data.message.read_at ? data.message : { ...data.message, read_at: new Date().toISOString() };
        setMessage(openedMessage);
        if (!data.message.read_at) {
          api.patch(`/messages/${id}/read`).catch(() => {});
        }
      })
      .catch((err) => { if (active) setError(apiErrorMessage(err, t('messages.detailLoadFailed'))); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, t]);

  if (loading) return <p className="py-12 text-center text-sm text-ink-400">{t('common.loading')}</p>;
  if (error || !message) return <div className="space-y-4"><button type="button" onClick={() => navigate('/messages')} className="btn btn-secondary"><ArrowLeft size={15} /> {t('messages.backToMessages')}</button><StatusBanner type="error" message={error || t('messages.detailNotFound')} /></div>;

  const digest = isDigest(message);
  const date = digest ? formatDate(message.payload.date, i18n.language) : formatDate(message.sent_at, i18n.language);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <button type="button" onClick={() => navigate('/messages')} className="btn btn-ghost -ml-2"><ArrowLeft size={16} /> {t('messages.backToMessages')}</button>
      <header className="border-b border-ink-200 pb-4">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-brand-700"><CalendarDays size={14} /> {date}</p>
        <h1 className="mt-1 flex items-center gap-2 font-display text-2xl font-semibold tracking-tight text-ink-900"><span className="text-brand-700">{digest ? <Inbox size={21} /> : <MessageSquare size={21} />}</span>{digest ? t('messages.dailySummary') : message.subject}</h1>
      </header>

      {digest ? (
        <DigestCard t={t} b={message} onMarkRead={() => { setMessage({ ...message, read_at: new Date().toISOString() }); api.patch(`/messages/${id}/read`).catch(() => {}); }} />
      ) : (
        <section className="rounded-xl border border-ink-200 bg-paper p-4 shadow-sm">
          <p className="whitespace-pre-wrap text-sm leading-6 text-ink-700">{message.body || t('messages.noMessageBody')}</p>
          {message.payload?.url && <button type="button" onClick={() => navigate(message.payload.url)} className="mt-4 text-sm font-medium text-brand-700 hover:underline">{t('messages.openRelatedRecord')}</button>}
        </section>
      )}
    </div>
  );
}
