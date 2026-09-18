import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, ChevronRight } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import { useAuth } from '../context/AuthContext';
import { useUnread } from '../context/UnreadContext';
import { getPushSupportState, enablePushNotifications } from '../push';
import StatusBanner from '../components/StatusBanner';
import BarChart from '../components/BarChart';
import CountBadge from '../components/CountBadge';
import { todayISO } from '../dates';
import { attendanceMetrics } from '../attendanceMetrics';

/**
 * One kind's sessions, as its own labelled list.
 *
 * Split rather than interleaved so a rehearsal's headcount is never read as part
 * of the day's service attendance. An empty group still says so, because "no
 * rehearsal happened" and "the rehearsal list is missing" must not look alike.
 * Rehearsal counts are rendered muted: they are real attendance, but they are
 * not a church service's attendance.
 */
function SessionGroup({ t, heading, note, sessions, empty, muted = false }) {
  return (
    <div>
      <h3 className="text-xs font-medium uppercase tracking-wide text-ink-400">{heading}</h3>
      {note && <p className="mt-0.5 text-xs text-ink-400">{note}</p>}
      {sessions.length === 0 ? (
        <p className="py-2 text-sm text-ink-400">{empty}</p>
      ) : (
        <ul className="mt-1 divide-y divide-ink-100">
          {sessions.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink-900">{s.label}</span>
                {s.scope && <span className="mt-0.5 block truncate text-xs text-ink-400">{s.scope}</span>}
              </span>
              <span
                className={`shrink-0 font-display text-lg font-semibold tabular-nums ${muted ? 'text-ink-500' : 'text-people-700'}`}
              >
                {s.metrics.map((metric) => (
                  <span key={metric.kind} className="ml-1 first:ml-0">
                    {metric.count.toLocaleString()} {metric.kind === 'unique' ? t('home.uniqueAttendeesShort') : t('home.recordedShort')}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Home() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { messages: unread } = useUnread();
  const navigate = useNavigate();
  const [attendance, setAttendance] = useState([]);
  const [todayOfferings, setTodayOfferings] = useState({ total: 0, currency: 'TZS' });
  const [byCategory, setByCategory] = useState([]);
  const [pushState, setPushState] = useState('default');
  const [pushError, setPushError] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    const today = todayISO();
    const fetchAll = () => {
      api
        .get('/attendance', { params: { from: today, to: today } })
        .then(({ data }) => {
          setLoadError('');
          setAttendance(data.attendance);
        })
        .catch((err) => setLoadError(apiErrorMessage(err)));
      api
        .get('/offerings/summary', { params: { from: today, to: today } })
        .then(({ data }) => {
          const total = data.byType.reduce((sum, r) => sum + r.total, 0);
          const currency = data.byType[0]?.currency || 'TZS';
          setTodayOfferings({ total, currency });
        })
        .catch((err) => setLoadError(apiErrorMessage(err)));
      api
        .get('/reports/breakdown', { params: { from: today, to: today, groupBy: 'category' } })
        .then(({ data }) => setByCategory(data.breakdown))
        .catch(() => {});
    };

    fetchAll();
    setPushState(getPushSupportState());
    // Poll every 15s so new records from the admin app appear here without a manual refresh.
    const interval = setInterval(fetchAll, 15000);
    function onFocus() {
      fetchAll();
    }
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  /**
   * Today's attendance, one row per recorded session.
   *
   * There is deliberately no single total. Attendance is recorded per service
   * and per sub-session, and the same person can appear in more than one of them
   * (Sunday School and then the Main Service), so summing the rows would count
   * people twice and present a confident number that means nothing. The label
   * format matches the front desk's daily summary exactly, `${service} · ${sub}`
   * so the pastor sees the same names for the same sessions in both places.
   *
   * `rehearsal` marks the practice sessions (mazoezi) so the list can separate
   * them from the services (ibada). A row whose type carries no kind is treated
   * as a service, matching the schema default, so an untyped session is never
   * mistaken for a rehearsal it cannot be shown to be.
   */
  const sessions = useMemo(
    () =>
      (attendance || [])
        .map((a) => ({
          id: a.id,
          label: a.sub_session_name ? `${a.service_type_name} · ${a.sub_session_name}` : a.service_type_name,
          scope: [a.group_name, a.center_name, a.zone_name].filter(Boolean).join(' · '),
          metrics: attendanceMetrics(a),
          rehearsal: a.service_type_kind === 'rehearsal',
        }))
        .sort((x, y) => x.label.localeCompare(y.label)),
    [attendance]
  );

  // Services and rehearsals are listed apart, never interleaved. The reports
  // already keep practice attendance out of the church's service figures
  // (`reports.js` SERVICE_KIND); showing the two mixed here was the one place
  // the split was missing, and it let a choir practice read as part of the
  // day's service attendance. The chart below still plots every session:
  // per-session bars sum nothing, so they cannot double-count the way one
  // combined figure does.
  const serviceSessions = useMemo(() => sessions.filter((s) => !s.rehearsal), [sessions]);
  const rehearsalSessions = useMemo(() => sessions.filter((s) => s.rehearsal), [sessions]);

  async function handleEnablePush() {
    setPushError('');
    try {
      await enablePushNotifications();
      setPushState('granted');
    } catch (err) {
      setPushError(err.message);
      setPushState(getPushSupportState());
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold">{t('home.greeting', { name: user?.name?.split(' ')[0] || '' })}</h1>
        <button
          type="button"
          onClick={() => navigate('/records')}
          className="mt-1.5 inline-flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-900"
        >
          {t('home.openDayReport')} <ChevronRight size={14} />
        </button>
      </div>

      <div className="bento">
        {loadError && (
          <div className="col-span-12">
            <StatusBanner type="error" message={loadError} />
          </div>
        )}

        {/* Attendance: a row per session, never one summed headcount, and
            services (ibada) kept apart from rehearsals (mazoezi). */}
        <section className="tile col-span-12 p-4">
          <h2 className="font-display text-base font-semibold">{t('home.todayAttendance')}</h2>
          <p className="mb-3 mt-0.5 text-xs text-ink-400">{t('home.attendanceBreakdownNote')}</p>
          {sessions.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">{t('home.noAttendanceToday')}</p>
          ) : (
            <div className="space-y-4">
              <SessionGroup
                t={t}
                heading={t('home.servicesHeading')}
                sessions={serviceSessions}
                empty={t('home.noServicesToday')}
              />
              <SessionGroup
                t={t}
                heading={t('home.rehearsalsHeading')}
                note={t('home.rehearsalsNote')}
                sessions={rehearsalSessions}
                empty={t('home.noRehearsalsToday')}
                muted
              />
            </div>
          )}
        </section>

        {/* Offerings stay a single total: each one is a distinct transaction, so
            there is no re-entry to double-count the way there is with people. */}
        <div className="tile col-span-6 p-4 lg:col-span-4">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-400">{t('home.todayOfferings')}</p>
          <p className="mt-1 font-display text-2xl font-semibold">
            {todayOfferings.total.toLocaleString()} {todayOfferings.currency}
          </p>
        </div>

        {/* Notifications: a real count of unread items, and a link into them.
            The number is the same one the nav badge renders (both read the shared
            unread source), so the two can never disagree. */}
        <button
          type="button"
          onClick={() => navigate('/messages')}
          className="tile col-span-6 flex items-center gap-3 p-4 text-left transition-colors hover:border-brand-300 lg:col-span-4"
        >
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700">
            <Bell size={17} strokeWidth={1.75} aria-hidden="true" />
            <CountBadge count={unread} tone="brand" />
          </span>
          <span className="min-w-0">
            <span className="block text-xs font-medium uppercase tracking-wide text-ink-400">{t('home.notifications')}</span>
            <span className="mt-0.5 block truncate text-sm font-semibold text-ink-900">
              {unread > 0 ? t('home.unread', { count: unread }) : t('home.allCaughtUp')}
            </span>
          </span>
          <ChevronRight size={16} className="ml-auto shrink-0 text-ink-300" />
        </button>

        {/* Push permission. Kept in its own tile and labelled for what it is.
            Browsers treat localhost as a secure context, so push works in local
            development too: the only requirement is a browser that supports it
            and permission being granted (the in-app feed works either way). */}
        <div className="tile col-span-12 flex flex-col justify-center gap-2 p-4 lg:col-span-4">
          {pushState === 'default' && (
            <button type="button" onClick={handleEnablePush} className="btn btn-ink w-full">
              <Bell size={16} /> {t('home.enableNotifications')}
            </button>
          )}
          {pushState === 'granted' && (
            <div className="flex items-center gap-2 text-sm text-people-700">
              <Bell size={15} /> {t('home.notificationsEnabled')}
            </div>
          )}
          {pushState === 'denied' && (
            <div className="flex items-center gap-2 text-sm text-amber-800">
              <BellOff size={15} /> {t('home.notificationsBlocked')}
            </div>
          )}
          {pushState === 'unsupported' && (
            <div className="flex items-center gap-2 text-sm text-ink-500">
              <BellOff size={15} /> {t('home.pushUnsupported')}
            </div>
          )}
          {pushState !== 'granted' && <p className="text-xs text-ink-400">{t('home.pushLocalhostNote')}</p>}
        </div>

        {pushError && (
          <div className="col-span-12">
            <StatusBanner type="error" message={pushError} />
          </div>
        )}

        {/* Both charts plot the same rows as the breakdown above, every session,
            services and rehearsals, so the figures on screen can never
            contradict each other. When nothing has been recorded the chart says
            so instead of drawing a 0–4 axis. */}
        <section className="tile col-span-12 p-4 lg:col-span-6">
          <h2 className="mb-3 font-display text-base font-semibold">{t('home.todayBySession')}</h2>
          <BarChart
            data={sessions.map((s) => ({
              label: `${s.label} · ${s.metrics.map((metric) => metric.kind === 'unique' ? t('home.uniqueAttendeesShort') : t('home.recordedShort')).join(' + ')}`,
              value: s.metrics[0]?.count || 0,
            }))}
            valueKey="value"
            tone="people"
            name={t('home.todayAttendance')}
            emptyMessage={t('home.noAttendanceToday')}
          />
        </section>
        <section className="tile col-span-12 p-4 lg:col-span-6">
          <h2 className="mb-3 font-display text-base font-semibold">{t('home.todayGivingByType')}</h2>
          <BarChart
            data={byCategory}
            tone="offering"
            valueKey="amount"
            name={t('home.todayOfferings')}
            format={(v) => `${v.toLocaleString()} ${todayOfferings.currency}`}
            emptyMessage={t('home.noGivingToday')}
          />
        </section>
      </div>
    </div>
  );
}
