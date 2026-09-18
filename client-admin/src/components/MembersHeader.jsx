import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUpDown, Check, ListFilter, Plus, Search } from 'lucide-react';
import GroupLogo from './GroupLogo';
import useDismissable from './useDismissable';

/**
 * The Members page header: one row carrying the title and its live count, the
 * search box, the sort control, the filter panel and the primary action.
 *
 * Two decisions worth stating:
 *
 * - The count is the server's, not `members.length`. The list is capped by a
 *   `limit`, so counting rows on screen would under-report a directory of any
 *   size, and would silently become the page size instead of the church.
 *   `total` is what the current filters match; `grandTotal` is the whole
 *   directory, shown as "N of M" whenever a filter or search is narrowing it.
 * - Sort and Filter are secondary buttons, deliberately the same weight as each
 *   other and lighter than Add Member, so the row has exactly one primary
 *   action. They are popovers rather than native selects because the filter
 *   holds four fields, and a native `<option>` cannot render the group logos
 *   the rest of the screen shows.
 */
const SORTS = [
  { key: 'recent', labelKey: 'members.sortRecent' },
  { key: 'name', labelKey: 'members.sortName' },
  { key: 'name_desc', labelKey: 'members.sortNameDesc' },
  { key: 'number', labelKey: 'members.sortNumber' },
];

export default function MembersHeader({
  total,
  grandTotal,
  search,
  onSearch,
  sort,
  onSort,
  filters,
  onFilter,
  onClearFilters,
  centers,
  groups,
  onAddMember,
  children,
}) {
  const { t } = useTranslation();
  const [panel, setPanel] = useState(null); // null | 'sort' | 'filter'
  useDismissable(panel !== null, () => setPanel(null));

  const activeFilterCount = ['centerId', 'zoneId', 'groupId', 'active', 'gender'].filter((k) => filters[k]).length;
  const currentSort = SORTS.find((s) => s.key === sort) || SORTS[0];
  const zones = centers.find((c) => String(c.id) === String(filters.centerId))?.zones || [];
  const chosenGroup = groups.find((g) => String(g.id) === String(filters.groupId));
  const filtered = total !== grandTotal;

  // One row from lg up, where a laptop actually has the width for it; below
  // that the controls wrap under the title rather than being squeezed.
  return (
    <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <h1 className="font-display text-2xl font-semibold">
        {t('members.titleAll')}{' '}
        <span className="tabular-nums text-ink-400">
          {filtered ? `(${t('members.countOf', { shown: total, total: grandTotal })})` : `(${total})`}
        </span>
      </h1>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-0 flex-1 sm:min-w-[240px]">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label={t('members.searchLabel')}
            placeholder={t('members.searchPlaceholder')}
            className="w-full rounded-md border border-ink-200 py-2.5 pl-9 pr-3 text-base focus-visible:border-brand-600"
          />
        </div>

        {/* Sort: the button reads as the current order, so the state is legible
            without opening it. */}
        <span className="relative" data-popover>
          <button
            type="button"
            onClick={() => setPanel(panel === 'sort' ? null : 'sort')}
            aria-expanded={panel === 'sort'}
            aria-haspopup="menu"
            aria-label={t('members.sortMenu')}
            className="btn btn-secondary w-full sm:w-auto"
          >
            <ArrowUpDown size={15} />
            {t(currentSort.labelKey)}
          </button>
          {panel === 'sort' && (
            <div role="menu" className="absolute right-0 z-20 mt-1 w-52 rounded-lg border border-ink-200 bg-paper py-1 shadow-lg">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPanel(null);
                    onSort(s.key);
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-ink-100 ${
                    s.key === currentSort.key ? 'font-medium text-ink-900' : 'text-ink-700'
                  }`}
                >
                  {t(s.labelKey)}
                  {s.key === currentSort.key && <Check size={14} />}
                </button>
              ))}
            </div>
          )}
        </span>

        <span className="relative" data-popover>
          <button
            type="button"
            onClick={() => setPanel(panel === 'filter' ? null : 'filter')}
            aria-expanded={panel === 'filter'}
            aria-haspopup="true"
            aria-label={t('members.filterMenu')}
            className="btn btn-secondary w-full sm:w-auto"
          >
            <ListFilter size={15} />
            {t('members.filterBy')}
            {activeFilterCount > 0 && (
              <span className="ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-600 px-1 text-[11px] font-semibold text-white">
                {activeFilterCount}
              </span>
            )}
          </button>
          {panel === 'filter' && (
            <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-ink-200 bg-paper p-3 shadow-lg">
              <label className="mb-1 block text-xs font-medium text-ink-500" htmlFor="f-center">
                {t('members.center')}
              </label>
              <select
                id="f-center"
                value={filters.centerId}
                onChange={(e) => onFilter({ centerId: e.target.value, zoneId: '' })}
                className="mb-3 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
              >
                <option value="">{t('members.allCenters')}</option>
                {centers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>

              <label className="mb-1 block text-xs font-medium text-ink-500" htmlFor="f-zone">
                {t('members.zone')}
              </label>
              <select
                id="f-zone"
                value={filters.zoneId}
                onChange={(e) => onFilter({ zoneId: e.target.value })}
                disabled={!filters.centerId}
                className="mb-3 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600 disabled:bg-ink-50 disabled:text-ink-400"
              >
                <option value="">{t('members.allZones')}</option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>{z.name}</option>
                ))}
              </select>

              <label className="mb-1 block text-xs font-medium text-ink-500" htmlFor="f-group">
                {t('members.groupFilterLabel')}
              </label>
              {/* The chosen group's logo rides beside the select: a native option
                  cannot render an image (same rule as the rest of the app). */}
              <span className="mb-3 flex items-center gap-2">
                {chosenGroup && (
                  <GroupLogo groupId={chosenGroup.id} name={chosenGroup.name} has={chosenGroup.has_logo} round size={22} />
                )}
                <select
                  id="f-group"
                  value={filters.groupId}
                  onChange={(e) => onFilter({ groupId: e.target.value })}
                  className="min-w-0 flex-1 rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
                >
                  <option value="">{t('members.allGroups')}</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}</option>
                  ))}
                </select>
              </span>

              <label className="mb-1 block text-xs font-medium text-ink-500" htmlFor="f-gender">
                {t('members.gender')}
              </label>
              <select
                id="f-gender"
                value={filters.gender}
                onChange={(e) => onFilter({ gender: e.target.value })}
                className="mb-3 w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
              >
                <option value="">{t('members.genderAll')}</option>
                <option value="male">{t('members.genderMale')}</option>
                <option value="female">{t('members.genderFemale')}</option>
                <option value="other">{t('members.genderOther')}</option>
              </select>

              <label className="mb-1 block text-xs font-medium text-ink-500" htmlFor="f-status">
                {t('members.status')}
              </label>
              <select
                id="f-status"
                value={filters.active}
                onChange={(e) => onFilter({ active: e.target.value })}
                className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus-visible:border-brand-600"
              >
                <option value="">{t('members.statusAll')}</option>
                <option value="1">{t('members.statusActive')}</option>
                <option value="0">{t('members.statusInactive')}</option>
              </select>

              {activeFilterCount > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setPanel(null);
                    onClearFilters();
                  }}
                  className="mt-3 w-full rounded-md border border-ink-200 px-3 py-2 text-sm text-ink-700 hover:border-brand-600 hover:text-brand-800"
                >
                  {t('members.clearFilters')}
                </button>
              )}
            </div>
          )}
        </span>

        {/* The two actions wrap as a pair. Left loose, a narrower window
            stranded "Add member" alone on its own line: the one thing on the
            row that most wants a neighbour. */}
        <span className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          {children}
          <button type="button" onClick={onAddMember} className="btn btn-primary w-full sm:w-auto">
            <Plus size={16} /> {t('members.add')}
          </button>
        </span>
      </div>
    </div>
  );
}
