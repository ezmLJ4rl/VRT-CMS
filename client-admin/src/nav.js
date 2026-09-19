import {
  AlertTriangle,
  CalendarDays,
  CalendarClock,
  ChartColumn,
  Church,
  ClipboardCheck,
  Layers,
  MapPin,
  MessageSquare,
  Receipt,
  Settings,
  ShieldCheck,
  Target,
  Users,
  UsersRound,
  Wallet,
} from 'lucide-react';

/*
 * What each role may reach, and how the navigation is arranged.
 *
 * FOURTEEN DESTINATIONS IS NOT A MENU. At that size a flat row stops being
 * scannable: a person takes in roughly seven items at a glance, and every
 * screen competes equally for attention, from the front desk's daily entry work
 * to a receipt reprinted once a quarter. So each item below names a `group`, and
 * NAV_GROUPS says how the groups are shown:
 *
 *   primary , always visible: in the bar, and at the top of the drawer. The
 *              screens this role is in all day.
 *   manage  : one dropdown for the structural/configuration screens.
 *   finance : one dropdown for money oversight and record-pulling.
 *   settings: its own item, pushed to the far right of the bar and to the
 *              bottom of the drawer: account and preference territory, kept
 *              apart from the functional navigation.
 *
 * The ORDER WITHIN a group is the order of the role's list, so the sequence of
 * screens inside "Manage" is the one this file has always documented; the bar's
 * own order comes from NAV_GROUPS. An item must name its group: the shape makes
 * the author choose rather than inherit "somewhere in the row".
 *
 * `Icon` is used by the drawer and by the group triggers: icons speed up
 * scanning a vertical list, and a chevron marks a menu as a menu.
 */
export const NAV_GROUPS = [
  // The clusters a role is in all day. No label: they are the navigation.
  { key: 'primary', kind: 'inline' },
  { key: 'manage', kind: 'menu', labelKey: 'groupManage', Icon: Layers },
  { key: 'finance', kind: 'menu', labelKey: 'groupFinance', Icon: Wallet },
  // One item, shown as itself rather than as a one-item dropdown, and set apart
  // from the functional groups.
  { key: 'settings', kind: 'inline', pinned: true },
];

export const NAV_BY_ROLE = {
  receptionist: [
    { to: '/receptionist', key: 'receptionist', Icon: ClipboardCheck, group: 'primary' },
    // The front desk is where members are registered, so the directory is part
    // of its day-to-day work rather than an admin screen it borrows. It can
    // register and edit; deleting a member and deactivating one stay admin-only,
    // and the page hides both rather than offering a button that would 403.
    { to: '/members', key: 'members', Icon: Users, group: 'primary' },
    // The front desk runs the small groups too, so it gets the same cluster an
    // admin does: the same words in the same place, whoever is signed in.
    { to: '/groups', key: 'groups', Icon: UsersRound, group: 'manage' },
    { to: '/centers', key: 'centers', Icon: MapPin, group: 'manage' },
    { to: '/appointments', key: 'appointments', Icon: CalendarClock, group: 'manage' },
    // The front desk pulls records (a service's offering total, a period's
    // giving) but never reconciles or revokes: money screens stay admin-only.
    { to: '/reports', key: 'reports', Icon: ChartColumn, group: 'finance' },
    { to: '/messages', key: 'messages', Icon: MessageSquare, group: 'primary' },
    { to: '/emergencies', key: 'emergencies', Icon: AlertTriangle, group: 'primary' },
  ],
  admin: [
    { to: '/admin', key: 'admin', Icon: ShieldCheck, group: 'primary' },
    // The front desk belongs to the front desk. An administrator reaches the
    // same records through Admin (offerings, attendance) and never needs to
    // stand at the receptionist's screen to do it, so the item is not in their
    // navigation; the route itself stays open to them, so a bookmark or a
    // temporary cover shift still works.
    { to: '/service-types', key: 'serviceTypes', Icon: Church, group: 'manage' },
    { to: '/members', key: 'members', Icon: Users, group: 'primary' },
    { to: '/groups', key: 'groups', Icon: UsersRound, group: 'manage' },
    { to: '/centers', key: 'centers', Icon: MapPin, group: 'manage' },
    { to: '/appointments', key: 'appointments', Icon: CalendarClock, group: 'manage' },
    // Fundraising sits after the people sections: a project is a record with a
    // goal and a ledger, and it is administered by whoever runs the church.
    { to: '/projects', key: 'projects', Icon: Target, group: 'manage' },
    { to: '/events', key: 'events', Icon: CalendarDays, group: 'manage' },
    { to: '/messages', key: 'messages', Icon: MessageSquare, group: 'primary' },
    { to: '/emergencies', key: 'emergencies', Icon: AlertTriangle, group: 'primary' },
    { to: '/reports', key: 'reports', Icon: ChartColumn, group: 'finance' },
    // Reconciliation sits between the reports and the receipts, which is the
    // order the money moves in: a payment arrives, it is matched to a person,
    // and confirming it is what issues the receipt. Admin-only, like receipts:
    // an incoming payment carries payer names and phone numbers.
    { to: '/reconciliation', key: 'reconciliation', Icon: Wallet, group: 'finance' },
    // Receipt verification and reprinting sit next to Reports: both are where an
    // admin goes looking for a record after the fact, and a receipt is the one
    // money record that leaves the building. Admin-only: the front desk prints
    // from its own dashboard and never manages verification.
    { to: '/receipts', key: 'receipts', Icon: Receipt, group: 'finance' },
    { to: '/settings', key: 'settings', Icon: Settings, group: 'settings' },
  ],
  superadmin: [
    { to: '/admin', key: 'admin', Icon: ShieldCheck, group: 'primary' },
    // Same as an admin: the front desk's screen is the front desk's.
    { to: '/service-types', key: 'serviceTypes', Icon: Church, group: 'manage' },
    { to: '/members', key: 'members', Icon: Users, group: 'primary' },
    { to: '/groups', key: 'groups', Icon: UsersRound, group: 'manage' },
    { to: '/centers', key: 'centers', Icon: MapPin, group: 'manage' },
    { to: '/appointments', key: 'appointments', Icon: CalendarClock, group: 'manage' },
    { to: '/projects', key: 'projects', Icon: Target, group: 'manage' },
    { to: '/events', key: 'events', Icon: CalendarDays, group: 'manage' },
    { to: '/messages', key: 'messages', Icon: MessageSquare, group: 'primary' },
    { to: '/emergencies', key: 'emergencies', Icon: AlertTriangle, group: 'primary' },
    { to: '/reports', key: 'reports', Icon: ChartColumn, group: 'finance' },
    { to: '/reconciliation', key: 'reconciliation', Icon: Wallet, group: 'finance' },
    { to: '/receipts', key: 'receipts', Icon: Receipt, group: 'finance' },
    { to: '/settings', key: 'settings', Icon: Settings, group: 'settings' },
  ],
};

/**
 * A role's destinations arranged into the clusters above, in NAV_GROUPS order,
 * each carrying its own items in the role's order. Empty clusters are dropped:
 * the front desk has no Settings, and an empty heading would be a lie.
 *
 * Both presentations render from this, so the bar and the drawer cannot group
 * the same list two different ways.
 */
export function groupedNav(items) {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.group === group.key),
  })).filter((group) => group.items.length > 0);
}

/**
 * The destination an address belongs to: the LONGEST `to` the path sits under,
 * so a detail route lights the section it is part of (`/groups/12` keeps Groups
 * lit) without a second list of paths to maintain. Returns null when the address
 * belongs to no destination (a redirect, a 404).
 */
export function activeNavItem(items, pathname) {
  const matches = items.filter((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  return matches.sort((a, b) => b.to.length - a.to.length)[0] || null;
}
