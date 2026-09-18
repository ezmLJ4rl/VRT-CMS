import { Home, ClipboardList, AlertTriangle, MessageSquare, CalendarDays, MoreHorizontal, Target } from 'lucide-react';

/*
 * What the pastor app navigates to, in one place.
 *
 * Two presentations render this same list, in this same order:
 *   - below lg: the phone bottom bar, one tap away under the thumb;
 *   - at lg and up: the horizontal tab bar in the header, so a wide window
 *     gets a real navigation bar instead of a phone bar stretched across it.
 * Sharing the list is what keeps the two from drifting apart.
 */
export const TABS = [
  { to: '/home', key: 'home', Icon: Home },
  { to: '/records', key: 'records', Icon: ClipboardList },
  { to: '/emergencies', key: 'emergencies', Icon: AlertTriangle },
  { to: '/events', key: 'events', Icon: CalendarDays },
  { to: '/messages', key: 'messages', Icon: MessageSquare },
  // Progress on the church's special projects: read-only, and worth being one
  // tap away rather than buried in More.
  { to: '/projects', key: 'projects', Icon: Target },
  { to: '/settings', key: 'settings', Icon: MoreHorizontal },
];

// Alerts and messages carry a count; everything else does not. The tone follows
// the same job-based colour system as the rest of the app: open alerts are the
// error colour, unread messages are brand attention.
export const BADGE_TONE = { emergencies: 'danger', messages: 'brand' };
