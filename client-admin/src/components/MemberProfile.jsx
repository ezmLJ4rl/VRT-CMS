import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X, MapPin, Users, Phone, Mail, CalendarDays, HandCoins, ClipboardCheck, Info } from 'lucide-react';
import api, { apiErrorMessage } from '../api';
import DataTable from './DataTable';
import StatusBanner from './StatusBanner';
import GroupLogo from './GroupLogo';
import { EMPTY_VALUE } from '../emptyValue';
import { formatDate } from '../format';

const ROLE_KEY = { member: 'roleMember', leader: 'roleLeader', 'co-leader': 'roleCoLeader' };

// The seed scripts (scripts/sample-giving.js) mark the members they had to
// create with a note that names the script. That marker is what makes the
// sample data findable and purgeable, but it is plumbing, not a story about the
// person — so it is filtered here rather than shown. A note a human typed is
// kept; anything that matches a known seed marker is dropped (and logged in
// development only, so a stray marker in real data is still findable).
const SEED_NOTE_MARKERS = ['Sample giving data', 'scripts/sample-giving.js', 'scripts/sample-trends.js'];

function isSeedNote(notes) {
  return typeof notes === 'string' && SEED_NOTE_MARKERS.some((marker) => notes.includes(marker));
}

function money(amount, currency) {
  const value = Number(amount) || 0;
  return `${value.toLocaleString()} ${currency || 'TZS'}`.trim();
}

/**
 * A member's whole story in one panel: who they are, where they sit, the groups
 * they belong to, and the individual attendance and giving records behind the
 * summary numbers. Fetches `/members/:id` itself so any roster can drop it in
 * under a row.
 *
 * `actions` lets the embedding screen put its row actions (edit, delete) in the
 * panel's overflow menu, so the header is one block whatever the screen.
 */
export default function MemberProfile({ memberId, onClose, actions }) {
  const { t, i18n } = useTranslation();
  // Tagged with the member it belongs to, so a response that arrives after the
  // reader has switched rows can never be shown against the wrong person and no
  // state reset is needed when memberId changes.
  const [result, setResult] = useState(null);

  useEffect(() => {
    let alive = true;
    api
      .get(`/members/${memberId}`)
      .then(({ data: payload }) => { if (alive) setResult({ memberId, data: payload }); })
      .catch((err) => { if (alive) setResult({ memberId, error: apiErrorMessage(err) }); });
    return () => { alive = false; };
  }, [memberId]);

  const current = result && result.memberId === memberId ? result : null;

  if (current?.error) {
    return (
      <div className="p-4">
        <StatusBanner type="error" message={current.error} />
      </div>
    );
  }

  if (!current) {
    return <p className="p-4 text-sm text-ink-400">{t('common.loading')}</p>;
  }

  const data = current.data;

  const { member, groups, stats, history } = data;
  const attendance = history?.attendance || [];
  const giving = history?.offerings || [];
  const notes = isSeedNote(member.notes) ? null : member.notes;
  if (import.meta.env.DEV && isSeedNote(member.notes)) {
    // Dev-only: the seed marker belongs to whoever seeded the database, not on
    // the member's profile.
    console.info(`[MemberProfile] hiding seed-script note on member ${member.member_no || member.id}`);
  }

  return (
    <div className="p-4">
      {/* ONE header: name, member ID, status, where they sit, how to reach them,
          when they joined, the overflow menu. Nothing is repeated below it. */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-base font-semibold text-ink-900">{member.name}</h3>
            {member.member_no && (
              <span className="inline-flex items-center gap-1">
                <span className="cat-chip category-people tabular-nums">{member.member_no}</span>
                {/* What the number chip is FOR, on demand instead of permanently:
                    it is the code the member quotes when they pay by bank or
                    mobile money, and the reconciliation screen matches an
                    incoming payment on it. Tap works too (focus shows it), so a
                    desk worker on a tablet can still reach the explanation. */}
                <button
                  type="button"
                  className="group relative inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-400 hover:text-brand-700 focus-visible:text-brand-700"
                  aria-label={t('memberProfile.givingCodeHintTitle')}
                  tabIndex={0}
                >
                  <Info size={12} />
                  <span
                    role="tooltip"
                    className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden w-64 -translate-x-1/2 rounded-md border border-ink-200 bg-paper px-2.5 py-1.5 text-left text-xs font-normal normal-case tracking-normal text-ink-700 shadow-lg group-hover:block group-focus:block"
                  >
                    {t('memberProfile.givingCodeHint', { code: member.member_no })}
                  </span>
                </button>
              </span>
            )}
            {member.is_active ? (
              <span className="cat-chip category-people">{t('centers.active')}</span>
            ) : (
              <span className="cat-chip category-amber">{t('members.inactive')}</span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
            {member.center_name && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={11} /> {member.center_name}
                {member.zone_name ? ` · ${member.zone_name}` : ''}
              </span>
            )}
            {member.phone && (
              <span className="inline-flex items-center gap-1"><Phone size={11} /> {member.phone}</span>
            )}
            {member.email && (
              <span className="inline-flex items-center gap-1"><Mail size={11} /> {member.email}</span>
            )}
            {member.date_joined && (
              <span className="inline-flex items-center gap-1">
                <CalendarDays size={11} /> {t('memberProfile.joinedOn', { date: formatDate(member.date_joined, i18n.language) })}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {actions}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1 rounded-md border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-600 hover:border-brand-600 hover:text-brand-800"
            >
              <X size={13} /> {t('memberProfile.close')}
            </button>
          )}
        </div>
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-ink-200 bg-paper px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
            <ClipboardCheck size={12} /> {t('memberProfile.attendanceLabel')}
          </div>
          <div className="mt-0.5 text-sm font-semibold text-ink-900">
            {t('memberProfile.sessions90', { count: stats.attendance.sessions })}
          </div>
        </div>
        <div className="rounded-lg border border-ink-200 bg-paper px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
            <HandCoins size={12} /> {t('memberProfile.givingLabel')}
          </div>
          <div className="mt-0.5 text-sm font-semibold text-ink-900">
            {t('memberProfile.givingTotal', { gifts: stats.offerings.gifts, total: money(stats.offerings.total) })}
          </div>
        </div>
        <div className="rounded-lg border border-ink-200 bg-paper px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
            <Users size={12} /> {t('memberProfile.groupsLabel')}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {groups.length === 0 ? (
              <span className="text-sm text-ink-400">{t('memberProfile.noGroups')}</span>
            ) : (
              groups.map((g) => (
                <span key={g.id} className="cat-chip category-people">
                  <GroupLogo groupId={g.id} name={g.name} has={g.has_logo} round size={14} />
                  {g.name} · {t(`memberProfile.${ROLE_KEY[g.role] || 'roleMember'}`)}
                </span>
              ))
            )}
          </div>
        </div>
      </div>

      {notes && <p className="mb-4 text-sm text-ink-500">{notes}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
            {t('memberProfile.attendanceHeading')}
          </h4>
          {/* The one shared table pattern (components/DataTable): fixed
              columns, sticky header, card reflow on phones. */}
          {attendance.length === 0 ? (
            <p className="text-sm text-ink-400">{t('memberProfile.noAttendance')}</p>
          ) : (
            <div className="rounded-lg border border-ink-200 p-3">
              <DataTable
                columns={[
                  { key: 'date', header: t('memberProfile.date'), width: 16, render: (a) => <span className="whitespace-nowrap text-ink-600">{formatDate(a.date, i18n.language)}</span> },
                  {
                    key: 'service',
                    header: t('memberProfile.service'),
                    render: (a) => (
                      <span className="text-ink-700">
                        {a.service_name}
                        {/* The session often shares its type's name: don't say it twice. */}
                        {a.service_type_name && a.service_type_name !== a.service_name ? ` · ${a.service_type_name}` : ''}
                      </span>
                    ),
                  },
                  { key: 'group', header: t('memberProfile.group'), width: 20, render: (a) => <span className="text-ink-500">{a.group_name || EMPTY_VALUE}</span> },
                  { key: 'count', header: t('memberProfile.count'), width: 12, align: 'right', cardValue: true, render: (a) => <span className="tabular-nums text-ink-700">{a.count ?? EMPTY_VALUE}</span> },
                ]}
                rows={attendance}
                keyOf={(a) => a.id}
                empty={null}
              />
            </div>
          )}
        </section>

        <section>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
            {t('memberProfile.givingHeading')}
          </h4>
          {giving.length === 0 ? (
            <p className="text-sm text-ink-400">{t('memberProfile.noGiving')}</p>
          ) : (
            <div className="rounded-lg border border-ink-200 p-3">
              <DataTable
                columns={[
                  {
                    key: 'date',
                    header: t('memberProfile.date'),
                    width: 18,
                    render: (o) => <span className="whitespace-nowrap text-ink-600">{formatDate((o.timestamp || '').slice(0, 10) || o.service_date, i18n.language)}</span>,
                  },
                  { key: 'type', header: t('memberProfile.type'), render: (o) => <span className="text-ink-700">{o.category_name || o.type}</span> },
                  { key: 'receipt', header: t('memberProfile.receipt'), width: 20, render: (o) => <span className="font-mono text-xs text-ink-500">{o.receipt_number || EMPTY_VALUE}</span> },
                  {
                    key: 'amount',
                    header: t('memberProfile.amount'),
                    width: 24,
                    align: 'right',
                    cardValue: true,
                    render: (o) => <span className="whitespace-nowrap tabular-nums text-ink-700">{money(o.amount, o.currency)}</span>,
                  },
                ]}
                rows={giving}
                keyOf={(o) => o.id}
                empty={null}
              />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
