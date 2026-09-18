import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, Star, Users } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import StatusBanner from '../components/StatusBanner';

/**
 * One group's current membership, read live.
 *
 * This is the page a group update points at, and the reason the update itself
 * carries no roster: whoever wants to know who is in the group reads it here,
 * where it comes from the group's own records (GET /api/groups/:id), and is
 * therefore true when it is read. A list embedded in a message is true only on
 * the day it was sent: two of those, from different days, contradict each other
 * as soon as somebody leaves, and nothing in a feed can say which one is still
 * right.
 *
 * Read-only on purpose. Membership is written where the member is registered and
 * edited (the church office's Members screen), which is what keeps one list as
 * the single answer to "who is in this group now".
 */
export default function GroupDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [group, setGroup] = useState(null);
  const [members, setMembers] = useState([]);
  const [counts, setCounts] = useState({ total: 0, leaders: 0, members: 0 });
  const [error, setError] = useState('');

  // `alive` guards the response: opening one group and then another must not let
  // the first answer land on the second group's page.
  useEffect(() => {
    let alive = true;
    api
      .get(`/groups/${id}`)
      .then(({ data }) => {
        if (!alive) return;
        setGroup(data.group);
        setMembers(data.members || []);
        setCounts(data.counts || { total: (data.members || []).length, leaders: 0, members: 0 });
        setError('');
      })
      .catch((err) => {
        if (alive) setError(apiErrorMessage(err));
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // Read rather than stored: a group whose id is not the one in the URL is still
  // the previous group's data, so the page waits instead of showing it under the
  // wrong name (the group's own page is the one screen where a stale roster is
  // exactly the mistake this feature exists to prevent).
  const stale = group !== null && String(group.id) !== String(id);
  const loading = !error && (group === null || stale);

  return (
    <div className="space-y-5">
      <Link to="/messages" className="inline-flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-900">
        <ArrowLeft size={14} aria-hidden="true" /> {t('group.back')}
      </Link>

      {error ? (
        <StatusBanner type="error" message={error} />
      ) : loading ? (
        <p className="text-sm text-ink-400">{t('common.loading')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-xl font-semibold text-ink-900">{group.name}</h1>
            {group.kind && <span className="cat-chip category-ink">{t(`groupKinds.${group.kind}`)}</span>}
            {!group.is_active && (
              <span className="cat-chip category-amber">
                <AlertCircle size={12} /> {t('group.disabled')}
              </span>
            )}
          </div>
          {group.description && <p className="text-sm text-ink-500">{group.description}</p>}

          <div className="bento">
            <div className="tile col-span-4 p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
                <Users size={13} aria-hidden="true" /> {t('group.membersHeading')}
              </p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{counts.total}</p>
            </div>
            <div className="tile col-span-4 p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
                <Star size={13} aria-hidden="true" /> {t('group.leadersHeading')}
              </p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{counts.leaders}</p>
            </div>
          </div>

          <section className="rounded-xl border border-ink-200 bg-paper p-4 shadow-sm">
            <h2 className="mb-2 font-display text-base font-semibold">{t('group.rosterHeading')}</h2>
            {members.length === 0 ? (
              <p className="py-4 text-center text-sm text-ink-400">{t('group.noMembers')}</p>
            ) : (
              <ul className="divide-y divide-ink-100">
                {members.map((m) => (
                  <li key={m.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 ${m.is_active ? '' : 'opacity-60'}`}>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">{m.name}</span>
                    {m.member_no && <span className="shrink-0 text-xs tabular-nums text-ink-400">{m.member_no}</span>}
                    <span className="shrink-0 rounded-full bg-ink-100 px-2 py-0.5 text-xs capitalize text-ink-600">
                      {t(`group.role_${m.role || 'member'}`)}
                    </span>
                    {(m.center_name || m.zone_name) && (
                      <span className="w-full text-xs text-ink-400">
                        {[m.center_name, m.zone_name].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-ink-400">{t('group.managedInOffice')}</p>
          </section>
        </>
      )}
    </div>
  );
}
