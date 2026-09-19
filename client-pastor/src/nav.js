import { Home, ClipboardList, AlertTriangle, MessageSquare, CalendarDays, CalendarClock, MoreHorizontal, Target } from 'lucide-react';

/*
 * What the pastor app navigates to, in one place.
 *
 * Two presentations render this same list, in this same order:
 *   - below lg: the phone bottom bar, one tap away under the thumb;
 *   - at lg and up: the horizontal tab bar in the header, so a wide window
 *     gets a real navigation bar instead of a phone bar stretched across it.
 * Sharing the list is what keeps the two from drifting apart.
 */
export const PRIMARY_TABS = [
  { to: '/home', key: 'home', Icon: Home },
  { to: '/records', key: 'records', Icon: ClipboardList },
  { to: '/emergencies', key: 'emergencies', Icon: AlertTriangle },
  { to: '/messages', key: 'messages', Icon: MessageSquare },
];

// Keep lower-frequency destinations out of the thumb bar. Add future
// occasional screens here by default instead of expanding PRIMARY_TABS.
export const MORE_TABS = [
  { to: '/events', key: 'events', Icon: CalendarDays },
  { to: '/appointments', key: 'appointments', Icon: CalendarClock },
  { to: '/projects', key: 'projects', Icon: Target },
  { to: '/settings', key: 'settings', Icon: MoreHorizontal },
];

// Kept as a compatibility export for consumers that only need every destination.
export const TABS = [...PRIMARY_TABS, ...MORE_TABS];

// Alerts and messages carry a count; everything else does not. The tone follows
// the same job-based colour system as the rest of the app: open alerts are the
// error colour, unread messages are brand attention.
export const BADGE_TONE = { emergencies: 'danger', messages: 'brand' };
