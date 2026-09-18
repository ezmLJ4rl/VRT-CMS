import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import api from '../api';

/*
 * The pastor's attention counts, in one place.
 *
 * Both the nav badge and the Home notifications tile read from here, so they
 * cannot drift apart. The previous arrangement had each screen report its own
 * count upward (Messages loaded it, Home separately asked for open emergencies),
 * which meant two sources of truth for one number and a badge that could sit
 * stale after a screen unmounted. Now one poll owns the value, every consumer
 * renders it, and any screen that changes it calls refresh() instead of
 * computing its own.
 *
 * GET /api/messages/unread returns { unread, notifications, total }:
 *   unread       : unread direct threads + unread broadcasts
 *   notifications, unread in-app rows that have no message twin
 *   total        , the single number every badge shows
 */
const UnreadContext = createContext({ messages: 0, emergencies: 0, refresh: () => {} });

export function UnreadProvider({ children }) {
  const [counts, setCounts] = useState({ messages: 0, emergencies: 0 });
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    // Each request degrades on its own: a failure keeps the last known value
    // rather than resetting a badge to zero and inventing an "all read" state.
    const [messages, emergencies] = await Promise.all([
      api
        .get('/messages/unread')
        .then(({ data }) => data.total ?? data.unread ?? 0)
        .catch(() => null),
      api
        .get('/emergencies', { params: { status: 'open' } })
        .then(({ data }) => data.emergencies?.length || 0)
        .catch(() => null),
    ]);
    if (!alive.current) return;
    setCounts((prev) => ({
      messages: messages === null ? prev.messages : messages,
      emergencies: emergencies === null ? prev.emergencies : emergencies,
    }));
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh();
    // Polls while the app is open, and again whenever it regains focus, so a
    // summary sent from the front desk shows up without a manual reload.
    const interval = setInterval(refresh, 15000);
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);

  return <UnreadContext.Provider value={{ ...counts, refresh }}>{children}</UnreadContext.Provider>;
}

export function useUnread() {
  return useContext(UnreadContext);
}
