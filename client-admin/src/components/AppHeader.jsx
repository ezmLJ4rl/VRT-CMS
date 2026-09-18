import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, LogOut, Menu, X } from 'lucide-react';
import { m } from 'motion/react';
import { useAuth } from '../context/AuthContext';
import LanguageSwitcher from './LanguageSwitcher';
import VrtLogo from './VrtLogo';
import useDismissable from './useDismissable';
import { NAV_BY_ROLE, activeNavItem, groupedNav } from '../nav';
import { LOGO_SIZE } from '../logoSize';
import { CHURCH_NAME, CHURCH_ADDRESS } from '../i18n/common';
import { DURATION, EASE, settled, useSettled } from '../motion';

/*
 * Responsive navigation, driven by NAV_BY_ROLE (see ../nav.js), which clusters
 * the destinations so the bar never grows into a wall of equal choices:
 *
 *   >= lg (1024px, the width the bento dashboard reflows at), one row: the
 *      primary links inline, "Manage" and "Finance" as dropdowns, and Settings
 *      pushed to the far right, apart from the functional groups. The row does
 *      not wrap and does not scroll sideways: the clustering is what keeps it to
 *      one line, so a hidden destination is not traded for a tidy header.
 *   < lg: a hamburger opening a slide-out drawer below the header (the header
 *      itself stays visible and usable, never covered). The drawer shows the
 *      SAME clusters, as labeled sections: a dropdown inside a drawer would be a
 *      menu inside a menu, and the drawer already scrolls.
 *
 * Grouping happens in nav.js, both presentations render from `groupedNav`, so
 * the bar and the drawer cannot arrange the same role two different ways.
 */

// One active treatment for both presentations: the brand fill, so the drawer
// reads as the same navigation system as the tabs, just laid out vertically.
const tabClass = (isActive, extra = '') =>
  `whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
    isActive ? 'bg-brand-600 text-white' : 'text-ink-700 hover:bg-ink-100'
  }${extra ? ` ${extra}` : ''}`;

const DRAWER_ITEM_CLASS = ({ isActive }) =>
  `flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors ${
    isActive ? 'bg-brand-600 text-white' : 'text-ink-700 hover:bg-ink-100'
  }`;

const DRAWER_HEADING_CLASS = 'px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-ink-400';

// The gap a cluster's panel keeps from the viewport's edges, in px.
const PANEL_MARGIN = 8;

/**
 * One cluster of the bar, shown as a dropdown ("Manage", "Finance").
 *
 * The pattern is the app's own: same panel and same item styling as the row ⋮
 * menus (RowMenu.jsx), same outside-click dismissal through useDismissable, so
 * there is nothing new to learn, in look or in behaviour. It is deliberately NOT
 * animated, also for consistency: every other popover in the app appears at
 * once, and a menu that faded in among them would be the odd one out.
 *
 * Escape closes and hands focus back to the trigger, the courtesy the drawer
 * extends too. Two things differ from the row menus, both because these are
 * LINKS: a keystroke does not dismiss it (Tab has to reach the items), and the
 * trigger carries `aria-current` while one of its pages is open, so "I am
 * somewhere inside Finance" survives the menu being shut.
 *
 * HOVER OPENS, CLICK OWNS. A pointing device that passes over the trigger gets
 * the menu, and gets it taken away again when it leaves: the bar is on the way
 * to other things (Settings, the language switcher), and a menu that stayed open
 * behind a passing cursor would be an obstacle. Clicking PINS it, because that
 * is someone deliberately asking for it: no amount of subsequent pointer
 * movement closes a pinned menu, only Escape, a click outside, or a
 * navigation. The keyboard reaches the same pinned state, since Enter and Space
 * are clicks. Touch is ignored here entirely: it fires pointerenter too, and the
 * tap that follows would then toggle the menu it had just opened.
 *
 * THE ARROWS MOVE THROUGH THE ITEMS, and they do it from the trigger as well:
 * ArrowDown opens a shut menu and lands on its first item, ArrowUp on its last,
 * which is the menu-button convention and the difference between a keyboard user
 * reading a menu and tabbing through it. Home and End go to the ends of THIS
 * menu, and the keys it acts on are `stopPropagation`-ed, so the bar's own
 * Home/End (the ends of the bar) cannot fire underneath them. Tab still works
 * exactly as it did: the arrows are an addition, not a replacement, since these
 * are links a person may well want to tab past. Left and Right are deliberately
 * NOT handled here: they belong to the bar, so they carry focus out of a menu to
 * the next destination rather than through the menu's own items.
 *
 * STAYING ON SCREEN. A panel hangs off the right edge of the viewport and it
 * drags a horizontal scrollbar across the whole page, and the panel's width is
 * its labels' width, so Kiswahili (longer words) makes it wider. So the panel is
 * measured against the viewport and slid back inside when it would overflow, and
 * its width is capped at the viewport for the cases where even that is not
 * enough.
 *
 * WHICH MENU IS OPEN LIVES IN THE BAR, not in here. One slot means one menu at a
 * time for free (hovering Finance closes Manage), and it lets the bar close what
 * its own Left/Right moves away from: a rule that must not depend on a focus
 * event arriving, since "focus left the menu" is exactly the kind of thing a
 * renderer or a webview can decline to report. The menu still closes itself on
 * blur, because that covers every OTHER way focus can leave (Tab, a click into
 * the page). `{ key, at, pinned }`, or null for the group it does not belong to.
 */
function NavGroupMenu({ group, active, tabIndex, openMenu, onOpenMenu }) {
  const { t } = useTranslation();
  const { key: locationKey } = useLocation();
  const menu = openMenu && openMenu.key === group.key ? openMenu : null;
  // `at` is the location the menu was opened at, so any navigation, a link
  // inside it, a programmatic redirect, the back button, closes it by
  // DERIVATION, in the same commit that renders the next page, with nothing to
  // remember to call.
  const setMenu = useCallback(
    (next) => onOpenMenu(next ? { ...next, key: group.key } : null),
    [onOpenMenu, group.key]
  );
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const panelInnerRef = useRef(null);
  // How far left the panel has been slid to fit, in px. Zero in the ordinary
  // case, where the panel simply starts under its trigger.
  const [shift, setShift] = useState(0);
  // Where an arrow key asked to land, for the case where that key ALSO opened
  // the menu: the item does not exist yet when the key is handled, so the wish is
  // recorded and honoured by the effect below, after the panel commits.
  const pendingFocus = useRef(null);
  const open = menu !== null && menu.at === locationKey;
  const pinned = open && menu.pinned;
  const close = useCallback(() => setMenu(null), [setMenu]);
  const closeAndRefocus = useCallback(() => {
    setMenu(null);
    triggerRef.current?.focus();
  }, [setMenu]);
  useDismissable(open, close, 'data-nav-group', { anyKey: false });

  /** The menu's links, in the order they are read. */
  function menuItems() {
    return panelRef.current ? [...panelRef.current.querySelectorAll('a')] : [];
  }

  /**
   * Measure the open panel and slide it back inside the viewport if it would
   * hang off the right edge.
   *
   * The shift is computed ABSOLUTE, from the trigger's left edge, the panel's
   * own width and the viewport, and never accumulated from where the panel
   * currently sits, so applying it cannot feed back into the next measurement and
   * oscillate. It is also capped so the panel never slides off the LEFT edge
   * instead: when neither side can hold it, the width cap below is what saves it.
   */
  const fitPanel = useCallback(() => {
    const inner = panelInnerRef.current;
    const container = containerRef.current;
    if (!inner || !container) return;
    const { left } = container.getBoundingClientRect();
    const overflow = Math.max(0, left + inner.offsetWidth - (window.innerWidth - PANEL_MARGIN));
    const wanted = -Math.min(overflow, Math.max(0, left - PANEL_MARGIN));
    setShift((prev) => (prev === wanted ? prev : wanted));
  }, []);

  // While open, every render re-fits: the panel's width is its labels' width, so
  // a language switch or a late font swap changes it with no resize to notice.
  useLayoutEffect(() => {
    if (open) fitPanel();
  });

  // …and the two things that change the room a panel has without re-rendering:
  // a resize or a browser zoom, and a late web font, which re-lays the labels out
  // under an already-open panel.
  useEffect(() => {
    if (!open) return undefined;
    window.addEventListener('resize', fitPanel);
    let live = true;
    document.fonts?.ready.then(() => {
      if (live) fitPanel();
    });
    return () => {
      live = false;
      window.removeEventListener('resize', fitPanel);
    };
  }, [open, fitPanel]);

  useEffect(() => {
    if (!open || !pendingFocus.current) return;
    const items = menuItems();
    const wanted = pendingFocus.current === 'last' ? items[items.length - 1] : items[0];
    pendingFocus.current = null;
    wanted?.focus();
  }, [open]);

  /**
   * The keyboard's way through the cluster: up/down, Home/End, Escape. Handled on
   * the whole group rather than on the panel, so the same keys work with focus on
   * the trigger (where ArrowDown is also the way IN) as with focus on an item.
   */
  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeAndRefocus();
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation();
      const items = menuItems();
      (e.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const forward = e.key === 'ArrowDown';
    if (!open) {
      pendingFocus.current = forward ? 'first' : 'last';
      setMenu({ at: locationKey, pinned: true });
      return;
    }
    const items = menuItems();
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement);
    // -1 means focus is on the trigger (or nowhere in the menu), which is where
    // ArrowDown starts at the top and ArrowUp at the bottom; otherwise the ends
    // wrap, so the list is never a dead end.
    const next = at === -1 ? (forward ? 0 : items.length - 1) : (at + (forward ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  /** A pointer passing over opens the menu, but never takes over a clicked one. */
  function handlePointerEnter(e) {
    if (e.pointerType !== 'mouse' || open) return;
    setMenu({ at: locationKey, pinned: false });
  }

  /** …and the pointer leaving closes only what the pointer opened. */
  function handlePointerLeave(e) {
    if (e.pointerType !== 'mouse' || !open || pinned) return;
    setMenu(null);
  }

  /**
   * Focus leaving the whole group closes the menu, which is what makes the
   * bar's Left/Right honest: moving to the next destination on the bar closes the
   * cluster being walked away from, instead of leaving it hanging open under a
   * focused item that is no longer in it.
   */
  function handleBlur(e) {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setMenu(null);
  }

  const menuId = `app-nav-menu-${group.key}`;

  return (
    <div
      ref={containerRef}
      className="relative"
      data-nav-group
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
    >
      <button
        ref={triggerRef}
        type="button"
        tabIndex={tabIndex}
        data-nav-item
        onClick={() => {
          // A click PINS whatever is there: it opens a closed menu (the keyboard's
          // way in, since Enter and Space are clicks), and it takes ownership of
          // one the pointer merely opened. Only an already-pinned menu closes on
          // a click, otherwise the click that pins could never be told apart
          // from the click that dismisses.
          if (pinned) close();
          else setMenu({ at: locationKey, pinned: true });
        }}
        aria-expanded={open}
        aria-controls={menuId}
        aria-haspopup="true"
        aria-current={active ? 'true' : undefined}
        className={tabClass(active)}
      >
        {t(`nav.${group.labelKey}`)}
        <ChevronDown size={14} aria-hidden="true" className={`ml-1 inline ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        // Padding rather than a margin above the panel: a margin would leave a
        // strip of "outside" between trigger and menu, and a pointer crossing it
        // would close the menu it was on its way into.
        <div ref={panelRef} className="absolute top-full z-40 pt-1" style={{ left: shift }}>
          {/* `w-max` keeps the width independent of the panel's position (so the
              measurement above is stable); the cap is what a panel does when it
              genuinely cannot fit: it stops growing and its labels truncate. */}
          <div
            ref={panelInnerRef}
            id={menuId}
            className="w-max min-w-44 max-w-[calc(100vw-1rem)] rounded-lg border border-ink-200 bg-paper py-1 shadow-lg"
          >
            {group.items.map(({ to, key, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-2 text-sm ${
                    isActive ? 'bg-brand-600 font-medium text-white' : 'text-ink-700 hover:bg-ink-100'
                  }`
                }
              >
                <Icon size={16} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                <span className="truncate">{t(`nav.${key}`)}</span>
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AppHeader() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const headerRef = useRef(null);
  const triggerRef = useRef(null);
  const drawerRef = useRef(null);
  // The drawer's lifecycle: three states, not one boolean, because the slide
  // is animated and "dismissed" is therefore not the same moment as "gone":
  //
  //   open -> closing -> closed, and any location change -> closed at once.
  //
  // `key` is the location the drawer was opened at, so a navigation closes it BY
  // DERIVATION: the drawer belongs to a screen, and leaving that screen ends it.
  // `token` is fresh for every opening, which is what lets an animation be
  // restarted (and what the settle below is keyed on).
  const [drawer, setDrawer] = useState({ key: null, token: 0, phase: 'closed' });
  const menuOpen = drawer.phase === 'open' && drawer.key === location.key;
  const closing = drawer.phase === 'closing';
  const mounted = drawer.phase !== 'closed';
  // The drawer hangs off the bottom edge of the header so the header (logo,
  // church name, language switcher, log out) stays visible and tappable.
  const [menuTop, setMenuTop] = useState(0);

  const navItems = user ? NAV_BY_ROLE[user.role] || [] : [];
  // Which cluster the current address belongs to: the longest matching
  // destination's group, so /groups/12 keeps "Manage" lit.
  const active = activeNavItem(navItems, location.pathname);
  const navGroups = groupedNav(navItems);
  // The bar's top-level items, in the order they are read: an inline cluster
  // contributes its links, a menu cluster contributes its trigger.
  const barItems = navGroups.flatMap((group) =>
    group.kind === 'menu'
      ? [{ kind: 'menu', group }]
      : group.items.map((item) => ({ kind: 'link', item, pinned: group.pinned }))
  );
  // ROVING FOCUS ACROSS THE BAR: the bar is one stop in the tab order, not eight.
  // Exactly one top-level item carries tabIndex 0, the last one that had focus,
  // or the first until then, and Left/Right walk the rest. That is how a
  // horizontal menu bar behaves everywhere else, and it turns "eight presses of
  // Tab to get past the header" into one press plus a couple of arrows.
  const navRef = useRef(null);
  const [roving, setRoving] = useState(0);

  // MENUS ARE THE BAR'S BUSINESS: which menu is open, and closing one with the
  // arrows that walk past it.
  const [openMenu, setOpenMenu] = useState(null);

  /** Every top-level item currently in the bar, in reading order. */
  function barItemElements() {
    return navRef.current ? [...navRef.current.querySelectorAll('[data-nav-item]')] : [];
  }

  /**
   * Which top-level item owns the tab stop: the focused one, or, when focus is
   * inside an open menu, the trigger it belongs to, so leaving and coming back
   * returns to the cluster rather than to the start of the bar.
   */
  function rovingIndexOf(el) {
    const items = barItemElements();
    const own = items.indexOf(el);
    if (own !== -1) return own;
    const group = el.closest?.('[data-nav-group]');
    return group ? items.indexOf(group.querySelector('[data-nav-item]')) : -1;
  }

  function handleBarFocus(e) {
    const index = rovingIndexOf(e.target);
    if (index !== -1) setRoving(index);
  }

  /**
   * Left/Right along the bar, Home/End to its ends. Focus inside an open menu is
   * treated as its trigger, so Right walks out of a menu to the next destination
   * and the menu's own handler stops up/down and Home/End before they reach
   * here, so the two surfaces never act on the same key.
   */
  function handleBarKeyDown(e) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const items = barItemElements();
    if (items.length === 0) return;
    const from = rovingIndexOf(e.target);
    if (from === -1) return;
    e.preventDefault();
    const to =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : (from + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
    items[to].focus();
    setRoving(to);
    // Walking away from a cluster closes it. Said here rather than inferred from
    // the menu's blur, so the rule holds even where focus events are not
    // reported; the menu's own blur still covers leaving by Tab or by a click.
    setOpenMenu(null);
  }

  const closeMenu = useCallback(() => {
    setDrawer((d) => (d.phase === 'closed' ? d : { ...d, phase: 'closing' }));
  }, []);

  // The route moved out from under the drawer: a programmatic redirect, the
  // back button, logging out. Adjusting during render rather than in an effect
  // is the whole guarantee: the drawer is gone in the same commit that renders
  // the next page, so it cannot be left stranded over a screen it does not
  // belong to, and returning to this location later cannot resurrect it.
  if (drawer.phase !== 'closed' && drawer.key !== location.key) {
    setDrawer((d) => ({ ...d, phase: 'closed' }));
  }

  // The exit is timed rather than event-driven, so the panel is held for exactly
  // as long as its slide whether or not a frame was ever painted.
  useEffect(() => {
    if (!closing) return undefined;
    const timer = setTimeout(() => setDrawer((d) => ({ ...d, phase: 'closed' })), DURATION.drawer * 1000 + 40);
    return () => clearTimeout(timer);
  }, [closing]);

  // Once the slide would be over, the panel's resting position is asserted from
  // the stylesheet (see index.css): the promise the old keyframe class used to
  // make, now that Motion owns the transform. Not applied while closing: the
  // exit is the one moment the panel is meant to be off-screen.
  const seated = useSettled(menuOpen ? drawer.token : null, DURATION.drawer * 1000 + 60);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  // Measured as the drawer opens: body scroll is locked while it is open, so
  // the geometry cannot drift afterwards.
  function handleToggleMenu() {
    if (drawer.phase === 'open') {
      closeMenu();
      return;
    }
    const el = headerRef.current;
    setMenuTop(el ? Math.max(0, el.getBoundingClientRect().bottom) : 0);
    setDrawer((d) => ({ key: location.key, token: d.token + 1, phase: 'open' }));
  }

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        closeMenu();
        triggerRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, closeMenu]);

  // Background scrolling while the drawer covers the page feels broken on
  // touch, so lock it, and restore whatever was there before. Held through the
  // exit as well: the page must not scroll under a panel still sliding away.
  useEffect(() => {
    if (!mounted) return undefined;
    const previous = document.body.style.overflow;      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = previous;
      };
    }, [mounted]);

  // Keep the panel under the header if the header is resized while the drawer
  // is open: a viewport change, or a longer church name/label.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const el = headerRef.current;
    const measure = () => {
      if (el) setMenuTop(Math.max(0, el.getBoundingClientRect().bottom));
    };
    window.addEventListener('resize', measure);
    let observer;
    if (el && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure);
      observer.observe(el);
    }
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [menuOpen]);

  // Focus moves into the panel so Escape and the arrow keys work immediately.
  useEffect(() => {
    if (menuOpen) drawerRef.current?.focus();
  }, [menuOpen]);

  return (
    <header ref={headerRef} className="border-b border-ink-200 bg-paper">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          {navGroups.length > 0 && (
            <button
              ref={triggerRef}
              type="button"
              onClick={handleToggleMenu}
              aria-label={t('nav.menu')}
              aria-expanded={menuOpen}
              aria-controls="app-nav-drawer"
              title={t('nav.menu')}
              className="btn btn-secondary h-11 w-11 shrink-0 p-0 lg:hidden"
            >
              {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
            </button>
          )}
          <VrtLogo size={LOGO_SIZE.header} className="shrink-0" />
          <div className="min-w-0 leading-tight">
            <h1 className="truncate font-display text-lg font-semibold tracking-tight text-ink-900 sm:text-xl">
              {CHURCH_NAME}
            </h1>
            <p className="truncate text-xs text-ink-400">{CHURCH_ADDRESS}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <LanguageSwitcher />
          {user && (
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 rounded-md border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:border-danger-400 hover:text-danger-700"
            >
              <LogOut size={15} aria-hidden="true" /> {t('nav.logout')}
            </button>
          )}
        </div>
      </div>
      <div className="h-0.5 w-full bg-gradient-to-r from-brand-600 via-people-600 to-transparent" />
      {barItems.length > 0 && (
        <nav
          id="app-nav-tabs"
          ref={navRef}
          aria-label={t('nav.mainNav')}
          onFocus={handleBarFocus}
          onKeyDown={handleBarKeyDown}
          className="mx-auto hidden max-w-6xl items-center gap-1 px-4 pt-2 pb-2 lg:flex"
        >
          {barItems.map((entry, index) =>
            entry.kind === 'menu' ? (
              <NavGroupMenu
                key={entry.group.key}
                group={entry.group}
                active={active?.group === entry.group.key}
                tabIndex={index === roving ? 0 : -1}
                openMenu={openMenu}
                onOpenMenu={setOpenMenu}
              />
            ) : (
              // The pinned cluster (Settings) is pushed to the far right, apart
              // from the functional groups.
              <NavLink
                key={entry.item.to}
                to={entry.item.to}
                tabIndex={index === roving ? 0 : -1}
                data-nav-item
                className={({ isActive }) => tabClass(isActive, entry.pinned ? 'ml-auto' : '')}
              >
                {t(`nav.${entry.item.key}`)}
              </NavLink>
            )
          )}
        </nav>
      )}
      {mounted && navGroups.length > 0 && (
        <>
          {/* The scrim fades with the panel, in both directions: one dismissal,
              one motion. */}
          <m.div
            data-testid="nav-drawer-overlay"
            aria-hidden="true"
            onClick={closeMenu}
            style={{ top: menuTop }}
            initial={{ opacity: 0 }}
            animate={{ opacity: closing ? 0 : 1 }}
            transition={{ duration: DURATION.drawer, ease: EASE }}
            className={settled('fixed inset-x-0 bottom-0 z-30 bg-ink-900/40 lg:hidden', seated)}
          />
          <m.nav
            id="app-nav-drawer"
            ref={drawerRef}
            tabIndex={-1}
            aria-label={t('nav.menu')}
            style={{ top: menuTop }}
            initial={{ x: '-100%' }}
            animate={{ x: closing ? '-100%' : 0 }}
            transition={{ duration: DURATION.drawer, ease: EASE }}
            className={settled('fixed bottom-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col overflow-y-auto rounded-r-xl border-r border-ink-200 bg-paper py-2 shadow-xl lg:hidden', seated)}
          >
            {/* The same clusters as the bar, as labeled sections. Settings keeps
                its "apart from the rest" position: last, behind a divider. */}
            {navGroups.map((group) => (
              <div
                key={group.key}
                {...(group.labelKey
                  ? { role: 'group', 'aria-labelledby': `app-nav-drawer-${group.key}` }
                  : {})}
                className={group.pinned ? 'mt-2 border-t border-ink-100 pt-2' : undefined}
              >
                {group.labelKey && (
                  <p id={`app-nav-drawer-${group.key}`} className={DRAWER_HEADING_CLASS}>
                    {t(`nav.${group.labelKey}`)}
                  </p>
                )}
                {group.items.map(({ to, key, Icon }) => (
                  <NavLink key={to} to={to} onClick={closeMenu} className={DRAWER_ITEM_CLASS}>
                    <Icon size={18} strokeWidth={1.75} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">{t(`nav.${key}`)}</span>
                  </NavLink>
                ))}
              </div>
            ))}
          </m.nav>
        </>
      )}
    </header>
  );
}
