import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  ChevronRight,
  HandHeart,
  Mail,
  Phone,
  Power,
  Star,
  Users,
} from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import AppShell from '../components/AppShell';
import DataTable from '../components/DataTable';
import GroupLogo from '../components/GroupLogo';
import MemberLink from '../components/MemberLink';
import StatusBanner from '../components/StatusBanner';

/**
 * One group's roster.
 *
 * The Groups list shows a count; this is where the people behind it are read.
 * Everything on this page is derived from member records: there is no edit
 * affordance for membership here on purpose, because membership is written where
 * the member is (see pages/Members.jsx). The only actions are the ones this page
 * owns: showing the live roster and editing the group itself.
 */
export default function GroupDetail() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [group, setGroup] = useState(null);
  const [members, setMembers] = useState([]);
  const [counts, setCounts] = useState({ total: 0, leaders: 0, members: 0 });
  const [banner, setBanner] = useState(null);

  // `alive` guards the response: opening one group and then another must not let
  // the first answer land on the second group's page.
  useEffect(() => {
    let alive = true;
    api
      .get(`/groups/${id}`)
      .then(({ data }) => {
        if (!alive) return;
        setGroup(data.group);
        setMembers(data.members);
        setCounts(data.counts || { total: data.members.length, leaders: 0, members: data.members.length });
        setBanner(null);
      })
      .catch((err) => {
        if (alive) setBanner({ type: 'error', message: apiErrorMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [id]);

  // Read rather than stored: a group whose id is not the one in the URL is still
  // the previous group's data, so the page waits instead of showing it under the
  // wrong name.
  const loading = !group || String(group.id) !== String(id);

  const roleLabel = (role) => t(`groups.role_${role}`);

  return (
    <AppShell>
      <Link to="/groups" className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-ink-500 hover:text-ink-900">
        <ArrowLeft size={14} /> {t('groups.backToList')}
      </Link>

      {banner && (
        <div className="mb-5">
          <StatusBanner type={banner.type} message={banner.message} />
        </div>
      )}

      {loading && !banner ? (
        <p className="text-sm text-ink-400">{t('common.loading')}</p>
      ) : !group ? (
        <p className="rounded-xl border border-ink-200 bg-paper p-6 text-center text-sm text-ink-400">
          {t('groups.notFound')}
        </p>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <GroupLogo groupId={group.id} name={group.name} has={group.has_logo} size={56} />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display text-2xl font-semibold">{group.name}</h1>
                  <span className="cat-chip category-ink">{t(`groups.kind_${group.kind}`)}</span>
                  {!group.is_active && (
                    <span className="cat-chip category-amber">
                      <Power size={12} /> {t('groups.disabled')}
                    </span>
                  )}
                </div>
                {group.description && <p className="mt-1 text-sm text-ink-400">{group.description}</p>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link to="/groups" className="btn btn-secondary">
                <ChevronRight size={14} /> {t('groups.editInList')}
              </Link>
            </div>
          </div>

          <div className="bento mb-5">
            <div className="tile col-span-4 p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
                <Users size={13} /> {t('groups.membersHeading')}
              </p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{counts.total}</p>
            </div>
            <div className="tile col-span-4 p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
                <Star size={13} /> {t('groups.leadersHeading')}
              </p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{counts.leaders}</p>
            </div>
            <div className="tile col-span-4 p-4">
              <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
                <HandHeart size={13} /> {t('groups.plainMembersHeading')}
              </p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{counts.members}</p>
            </div>
          </div>

          <section className="tile p-4">
            <h2 className="mb-3 font-display text-base font-semibold">{t('groups.rosterTitle')}</h2>
            {/* The one shared table pattern (components/DataTable): fixed
                columns, sticky header, card reflow on phones. */}
            {members.length === 0 ? (
              <div className="rounded-lg border border-dashed border-ink-200 p-6 text-center">
                <p className="text-sm text-ink-500">{t('groups.rosterEmpty')}</p>
                <p className="mx-auto mt-1 max-w-md text-xs text-ink-400">{t('groups.rosterEmptyHint')}</p>
                <Link to="/members" className="btn btn-secondary mt-3">
                  {t('groups.membershipHintLink')}
                </Link>
              </div>
            ) : (
              <DataTable
                columns={[
                  {
                    key: 'member',
                    header: t('groups.colMember'),
                    render: (m) => (
                      <MemberLink memberId={m.id} className="font-medium text-ink-900">
                        {m.name}
                        {m.member_no && <span className="ml-2 text-xs text-ink-400">{m.member_no}</span>}
                        {!m.is_active && <span className="cat-chip category-amber ml-2">{t('members.inactive')}</span>}
                      </MemberLink>
                    ),
                  },
                  {
                    key: 'role',
                    header: t('groups.colRole'),
                    width: 20,
                    // Only a real leadership role is chipped; a plain member
                    // needs no badge to say they are one.
                    render: (m) =>
                      m.role === 'member' ? (
                        <span className="text-ink-500">{roleLabel(m.role)}</span>
                      ) : (
                        <span className="cat-chip category-ink">
                          <Star size={11} /> {roleLabel(m.role)}
                        </span>
                      ),
                  },
                  {
                    key: 'center',
                    header: t('groups.colCenter'),
                    width: 26,
                    render: (m) =>
                      m.center_name ? (
                        <span className="text-ink-600">
                          {m.center_name}
                          {m.zone_name ? ` · ${m.zone_name}` : ''}
                        </span>
                      ) : (
                        <span className="text-ink-400">{t('common.none')}</span>
                      ),
                  },
                  {
                    key: 'contact',
                    header: t('groups.colContact'),
                    width: 26,
                    align: 'right',
                    render: (m) =>
                      m.phone || m.email ? (
                        <span className="flex flex-col items-end gap-0.5 text-xs text-ink-600">
                          {m.phone && (
                            <span className="inline-flex items-center gap-1">
                              <Phone size={11} className="text-ink-400" /> {m.phone}
                            </span>
                          )}
                          {m.email && (
                            <span className="inline-flex items-center gap-1">
                              <Mail size={11} className="text-ink-400" /> {m.email}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-xs text-ink-400">{t('common.none')}</span>
                      ),
                  },
                ]}
                rows={members}
                keyOf={(m) => m.id}
                empty={null}
              />
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}
