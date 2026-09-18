import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';

import AppHeader from './AppHeader';
import { NAV_BY_ROLE, groupedNav } from '../nav';
import i18n from '../i18n';

// Auth and the network are the only faked boundaries: the rules under test are
// about what the navigation renders and how it opens/closes.
const { authState } = vi.hoisted(() => ({
  authState: { user: null, logout: vi.fn() },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('../api', () => ({
  default: { get: vi.fn(), patch: vi.fn() },
  apiErrorMessage: (e, fallback) => e?.response?.data?.error || fallback,
}));

/*
 * The navigation is clustered now (see ../nav.js), so the expectations are
 * written as the clusters rather than as one list: what is visible in the bar,
 * what each cluster holds, and the order the drawer lays them out in. Fourteen
 * equal-weight tabs is exactly what this structure exists to stop coming back.
 */
// The front desk's own screen is not in an administrator's navigation: the
// front desk runs it, and an admin reaches the same records through Admin.
const BAR_LINKS = ['Admin', 'Members', 'Messages', 'Emergencies', 'Settings'];
const CLUSTERS = {
  Manage: ['Service types', 'Groups', 'Centers', 'Special Projects', 'Events'],
  Finance: ['Reports', 'Reconciliation', 'Receipts'],
};
const DRAWER_SECTIONS = {
  '': ['Admin', 'Members', 'Messages', 'Emergencies'],
  Manage: CLUSTERS.Manage,
  Finance: CLUSTERS.Finance,
  Settings: ['Settings'],
};
const DRAWER_LABELS = [
  ...DRAWER_SECTIONS[''],
  ...DRAWER_SECTIONS.Manage,
  ...DRAWER_SECTIONS.Finance,
  'Settings',
];

const SW_BAR_LINKS = ['Msimamizi', 'Wanachama', 'Ujumbe', 'Dharura', 'Mipangilio'];
const SW_CLUSTER_ITEMS = ['Aina za ibada', 'Vikundi', 'Vituo', 'Miradi Maalum', 'Matukio'];

/** The destinations a role may reach, in the order the drawer shows them. */
const destinationsFor = (role = 'superadmin') =>
  groupedNav(NAV_BY_ROLE[role]).flatMap((group) => group.items.map((item) => item.to));

function PathProbe() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="path">{pathname}</p>
      <button type="button" onClick={() => navigate('/reports')}>
        go to reports
      </button>
    </>
  );
}

function renderHeader(initialPath = '/admin') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppHeader />
      <PathProbe />
    </MemoryRouter>
  );
}

// Addressed by id rather than by accessible name so these helpers stay valid
// when the interface language changes.
const tabs = () => document.getElementById('app-nav-tabs');
const drawer = () => document.getElementById('app-nav-drawer');
const trigger = () => screen.getByRole('button', { name: 'Menu' });
const path = () => screen.getByTestId('path').textContent;
// The cluster triggers are buttons, not links: a top-level item that opens a
// menu is not a destination.
const cluster = (label) => within(tabs()).getByRole('button', { name: label });
// The bar's top-level items in reading order: the links and the cluster
// triggers, which are what the roving focus moves between.
const barItems = () => [...tabs().querySelectorAll('[data-nav-item]')];
const tabStops = () => barItems().filter((el) => el.tabIndex === 0);
// By cluster key (`manage`, `finance`), not by label: the id must not move when
// the interface language does.
const menu = (key) => document.getElementById(`app-nav-menu-${key}`);

beforeEach(() => {
  i18n.changeLanguage('en');
  authState.user = { id: 1, name: 'Super Admin', role: 'superadmin', language_pref: 'en' };
});

afterEach(() => {
  i18n.changeLanguage('en');
});

describe('AppHeader navigation: desktop bar', () => {
  it('keeps one row: the clusters fit without wrapping or scrolling sideways', () => {
    renderHeader('/admin');

    // The contract, not cosmetics. Clustering is what keeps the bar to one
    // line, so a destination no longer has to be traded away for a tidy header:
    // the classes that would let the row wrap or scroll are gone, and what is
    // left at the top level is a handful of choices rather than fourteen.
    expect(tabs().className).toContain('lg:flex');
    expect(tabs().className).toContain('hidden');
    expect(tabs().className).not.toContain('flex-wrap');
    expect(tabs().className).not.toContain('overflow-x-auto');

    const topLevel = within(tabs()).getAllByRole('link').length + within(tabs()).getAllByRole('button').length;
    expect(topLevel).toBeLessThanOrEqual(8);
  });

  it('shows the day-to-day destinations, with Settings pinned apart from them', () => {
    renderHeader('/admin');

    const links = within(tabs()).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(BAR_LINKS);

    // Settings is deliberately not part of the clusters: it sits at the far
    // right, on its own.
    const settings = within(tabs()).getByRole('link', { name: 'Settings' });
    expect(settings.className).toContain('ml-auto');
  });

  it('names the clusters it hides things in', () => {
    renderHeader('/admin');

    expect(within(tabs()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Manage', 'Finance']);
  });

  it('reaches every destination the role may reach, in the bar or inside a cluster', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    const hrefs = within(tabs()).getAllByRole('link').map((l) => l.getAttribute('href'));

    for (const [label, items] of Object.entries(CLUSTERS)) {
      await user.click(cluster(label));
      const inside = within(menu(label.toLowerCase())).getAllByRole('link');
      expect(inside.map((l) => l.textContent)).toEqual(items);
      hrefs.push(...inside.map((l) => l.getAttribute('href')));
      await user.keyboard('{Escape}');
    }

    // Nothing was quietly dropped in the regrouping, and nothing appears twice.
    expect(hrefs.sort()).toEqual(NAV_BY_ROLE.superadmin.map((i) => i.to).sort());
  });

  it('opens a cluster on click and closes it again on a second click', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    expect(menu('manage')).toBeNull();
    await user.click(cluster('Manage'));
    expect(cluster('Manage')).toHaveAttribute('aria-expanded', 'true');
    expect(menu('manage')).toBeInTheDocument();

    await user.click(cluster('Manage'));
    expect(cluster('Manage')).toHaveAttribute('aria-expanded', 'false');
    expect(menu('manage')).toBeNull();
  });

  it('opens on hover, and takes it back when the pointer leaves', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.hover(cluster('Manage'));
    expect(cluster('Manage')).toHaveAttribute('aria-expanded', 'true');
    expect(menu('manage')).toBeInTheDocument();

    // Passing over the bar is not asking for it: the menu goes when the pointer
    // does.
    await user.unhover(cluster('Manage'));
    expect(menu('manage')).toBeNull();
  });

  it('keeps a menu that was clicked open, whatever the pointer does next', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.hover(cluster('Finance'));
    await user.click(cluster('Finance')); // the click is what pins it
    await user.unhover(cluster('Finance'));

    expect(menu('finance')).toBeInTheDocument();
    expect(cluster('Finance')).toHaveAttribute('aria-expanded', 'true');

    // A pinned menu is closed the same way any other menu is.
    await user.keyboard('{Escape}');
    expect(menu('finance')).toBeNull();
    expect(cluster('Finance')).toHaveFocus();
  });

  it('ignores hover from a pointing device that only has a tap', async () => {
    renderHeader('/admin');

    // Touch fires pointerenter as well; if that opened the menu, the tap that
    // follows would immediately close the menu it had just opened.
    fireEvent.pointerOver(cluster('Manage'), { pointerType: 'touch' });
    expect(menu('manage')).toBeNull();
  });

  it('leaves a hovered menu open while the keyboard works inside it', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.hover(cluster('Manage'));
    await user.keyboard('{Tab}');

    expect(menu('manage')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(menu('manage')).toBeNull();
  });

  it('closes on a click outside, without navigating', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Finance'));
    await user.click(screen.getByTestId('path'));

    expect(menu('finance')).toBeNull();
    expect(path()).toBe('/admin');
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    await user.keyboard('{Escape}');

    expect(menu('manage')).toBeNull();
    expect(cluster('Manage')).toHaveFocus();
  });

  it('opens from the trigger with the arrow keys, landing on the item they aimed at', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    cluster('Manage').focus();
    await user.keyboard('{ArrowDown}');

    expect(menu('manage')).toBeInTheDocument();
    // Down opens at the top, which is where that arrow was pointing.
    expect(within(menu('manage')).getByRole('link', { name: 'Service types' })).toHaveFocus();
  });

  it('opens upwards on ArrowUp, landing on the last item', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    cluster('Finance').focus();
    await user.keyboard('{ArrowUp}');

    expect(within(menu('finance')).getByRole('link', { name: 'Receipts' })).toHaveFocus();
  });

  it('moves through the links with the arrows, wrapping at both ends', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    const item = (name) => within(menu('manage')).getByRole('link', { name });

    item('Service types').focus();
    await user.keyboard('{ArrowDown}');
    expect(item('Groups')).toHaveFocus();

    await user.keyboard('{ArrowUp}{ArrowUp}');
    // Past the top, round the bottom: the ends wrap rather than dead-ending.
    expect(item('Events')).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(item('Service types')).toHaveFocus();
  });

  it('jumps to the ends with Home and End', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    const item = (name) => within(menu('manage')).getByRole('link', { name });

    await user.keyboard('{End}');
    expect(item('Events')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(item('Service types')).toHaveFocus();
  });

  it('returns focus to the trigger when Escape closes it from inside the menu', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Finance'));
    within(menu('finance')).getByRole('link', { name: 'Reports' }).focus();
    await user.keyboard('{Escape}');

    expect(menu('finance')).toBeNull();
    // The bar is where the keyboard user came from, and where they can carry on.
    expect(cluster('Finance')).toHaveFocus();
  });

  it('keeps the arrow keys from scrolling the page out from under the menu', () => {
    renderHeader('/admin');

    // fireEvent returns false when the default was prevented: the arrow moved
    // focus instead of scrolling, which is the whole point of handling it.
    expect(fireEvent.keyDown(cluster('Manage'), { key: 'ArrowDown' })).toBe(false);
    // A key it does not act on is left alone.
    expect(fireEvent.keyDown(cluster('Manage'), { key: 'a' })).toBe(true);
  });

  it('does not dismiss itself on a keystroke, so Tab can reach the links', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    await user.keyboard('{Tab}');

    // These items are links, not actions: a menu that shut on the first Tab
    // would be a menu only a mouse could use.
    expect(menu('manage')).toBeInTheDocument();
  });

  it('navigates and closes when a destination inside a cluster is chosen', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Finance'));
    await user.click(within(menu('finance')).getByRole('link', { name: 'Receipts' }));

    expect(path()).toBe('/receipts');
    expect(menu('finance')).toBeNull();
  });

  it('marks the active destination', () => {
    renderHeader('/members');

    const active = within(tabs()).getByRole('link', { name: 'Members' });
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(within(tabs()).getByRole('link', { name: 'Emergencies' })).not.toHaveAttribute(
      'aria-current'
    );
  });

  it('marks the cluster that contains the current page, so “somewhere inside” survives a shut menu', async () => {
    const user = userEvent.setup();
    renderHeader('/reconciliation');

    // The page is not in the bar, so the cluster says where it is.
    expect(cluster('Finance')).toHaveAttribute('aria-current', 'true');
    expect(cluster('Finance').className).toContain('bg-brand-600');
    expect(cluster('Manage')).not.toHaveAttribute('aria-current');

    await user.click(cluster('Finance'));
    expect(within(menu('finance')).getByRole('link', { name: 'Reconciliation' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('keeps a cluster marked through a detail route', () => {
    // /groups/12 is still the Groups screen: the section is lit by the longest
    // matching destination, not by an exact string.
    renderHeader('/groups/12');

    expect(cluster('Manage')).toHaveAttribute('aria-current', 'true');
    expect(cluster('Finance')).not.toHaveAttribute('aria-current');
  });

  it('is one stop in the tab order, however long the bar is', () => {
    renderHeader('/admin');

    // Exactly one top-level item can be tabbed to; the arrows walk the rest, so a
    // keyboard user passes the whole header in one press of Tab. The count is
    // derived, every inline destination is its own entry, every menu cluster
    // collapses into one trigger, so adding a destination cannot leave this
    // asserting a number that is no longer the bar.
    const clusters = groupedNav(NAV_BY_ROLE.superadmin).filter((g) => g.kind === 'menu').length;
    expect(barItems()).toHaveLength(BAR_LINKS.length + clusters);
    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0]).toHaveTextContent('Admin');
  });

  it('walks the whole bar with Left and Right, wrapping at both ends', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    barItems()[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(barItems()[1]).toHaveFocus(); // Members
    // …and the tab stop travels with the focus, so leaving and returning lands
    // where the user was.
    expect(tabStops()[0]).toBe(barItems()[1]);

    // Through the two cluster triggers, which sit where the bar shows them.
    barItems().find((el) => el.textContent.includes('Members')).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}');
    expect(cluster('Manage')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(cluster('Finance')).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(within(tabs()).getByRole('link', { name: 'Settings' })).toHaveFocus();

    // Off the right end, round to the left.
    await user.keyboard('{ArrowRight}');
    expect(barItems()[0]).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(within(tabs()).getByRole('link', { name: 'Settings' })).toHaveFocus();
  });

  it('jumps to the ends of the bar with Home and End', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    cluster('Manage').focus();
    await user.keyboard('{End}');
    expect(within(tabs()).getByRole('link', { name: 'Settings' })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(barItems()[0]).toHaveFocus();
  });

  it('leaves Home and End to the menu once focus is inside one', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    within(menu('manage')).getByRole('link', { name: 'Groups' }).focus();
    await user.keyboard('{End}');

    // The inner surface wins: the ends of the menu, not the ends of the bar.
    expect(within(menu('manage')).getByRole('link', { name: 'Events' })).toHaveFocus();
  });

  it('closes an open cluster when the arrows carry focus to another destination', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    expect(menu('manage')).toBeInTheDocument();

    await user.keyboard('{ArrowRight}');

    expect(cluster('Finance')).toHaveFocus();
    expect(menu('manage')).toBeNull();
  });

  it('closes when focus leaves the cluster by another route', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    within(menu('manage')).getByRole('link', { name: 'Groups' }).focus();

    // The bar's arrows are not the only way out: Tab, or a click that moves focus
    // into the page, is covered by the menu watching its own group. Wrapped in
    // `act` because a bare .focus() is not one of userEvent's calls: the focus
    // events do fire (jsdom dispatches focusin/focusout), but the state update
    // they cause is not flushed without it.
    act(() => screen.getByRole('button', { name: /Log out/ }).focus());

    expect(menu('manage')).toBeNull();
  });

  it('walks out of an open menu to the next destination', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    within(menu('manage')).getByRole('link', { name: 'Centers' }).focus();

    // Focus inside a menu belongs to its trigger as far as the bar is concerned,
    // so Right leaves the cluster rather than doing nothing.
    await user.keyboard('{ArrowRight}');

    expect(cluster('Finance')).toHaveFocus();
    expect(menu('manage')).toBeNull();
  });

  it('keeps the bar keys from scrolling the page sideways', () => {
    renderHeader('/admin');

    expect(fireEvent.keyDown(cluster('Manage'), { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(cluster('Manage'), { key: 'Tab' })).toBe(true);
  });

  it('shows only the destinations the signed-in role may reach', async () => {
    const user = userEvent.setup();
    authState.user = { id: 9, name: 'Front Desk', role: 'receptionist' };
    renderHeader('/receptionist');

    expect(within(tabs()).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Front Desk',
      // The directory is the front desk's own working screen: it registers
      // members, and registering them is what this role does all day.
      'Members',
      'Messages',
      'Emergencies',
    ]);
    // Same clusters, fewer things in them, and no Settings, which this role
    // does not have.
    expect(within(tabs()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Manage', 'Finance']);

    await user.click(cluster('Manage'));
    expect(within(menu('manage')).getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Groups',
      'Centers',
    ]);
    expect(within(menu('manage')).getByRole('link', { name: 'Groups' })).toHaveAttribute(
      'href',
      '/groups'
    );
  });
});

/*
 * The panel's position is measured from the trigger and the viewport, so these
 * tests supply the geometry jsdom does not have: only the cluster's own
 * container answers with a real rect, and only the panel reports a width. The
 * assertions then read the shift back out of the DOM and check the INVARIANT it
 * exists for: the panel's edges stay inside the viewport, rather than only
 * echoing the arithmetic that produced it.
 */
const PANEL_MARGIN = 8;
const PANEL_WIDTH = 200;
const VIEWPORT = 1024;
const ZERO_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
};

function stubGeometry({ triggerLeft, panelWidth = PANEL_WIDTH, viewport = VIEWPORT }) {
  vi.stubGlobal('innerWidth', viewport);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (!this.hasAttribute?.('data-nav-group')) return ZERO_RECT;
    return { ...ZERO_RECT, x: triggerLeft, y: 80, left: triggerLeft, right: triggerLeft, top: 80, bottom: 120, height: 40 };
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
    return this.id?.startsWith('app-nav-menu-') ? panelWidth : 0;
  });
}

/** How far the panel's box has been slid left, read back from the rendered style. */
const panelShift = (key) => Number.parseFloat(menu(key).parentElement.style.left || '0');

/** Where the panel's right edge lands for a trigger at `triggerLeft`. */
const panelRightEdge = (key, triggerLeft, panelWidth = PANEL_WIDTH) =>
  triggerLeft + panelShift(key) + panelWidth;

const panelLeftEdge = (key, triggerLeft) => triggerLeft + panelShift(key);

describe('AppHeader navigation: cluster panels stay on screen', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete document.fonts;
  });

  it('leaves the panel under its trigger when there is room for it', async () => {
    const user = userEvent.setup();
    stubGeometry({ triggerLeft: 100 });
    renderHeader('/admin');

    await user.click(cluster('Manage'));

    // The ordinary case must stay unshifted: a panel that always drifted left
    // would be as wrong as one that hung off the screen.
    expect(panelShift('manage')).toBe(0);
    expect(panelRightEdge('manage', 100)).toBeLessThanOrEqual(VIEWPORT - PANEL_MARGIN);
  });

  it('slides the panel back inside when its trigger is near the right edge', async () => {
    const user = userEvent.setup();
    stubGeometry({ triggerLeft: 900 });
    renderHeader('/admin');

    await user.click(cluster('Manage'));

    // Exactly the overflow (900 + 200 + 8 − 1024), so the panel lands on the
    // margin instead of past it.
    expect(panelShift('manage')).toBe(-84);
    expect(panelRightEdge('manage', 900)).toBe(VIEWPORT - PANEL_MARGIN);
  });

  it('slides further left when wider labels overflow more', async () => {
    const user = userEvent.setup();
    // Kiswahili labels are longer words; a wider panel overflows sooner.
    stubGeometry({ triggerLeft: 800, panelWidth: 308 });
    renderHeader('/admin');

    await user.click(cluster('Manage'));

    expect(panelRightEdge('manage', 800, 308)).toBe(VIEWPORT - PANEL_MARGIN);
    expect(panelLeftEdge('manage', 800)).toBeGreaterThanOrEqual(PANEL_MARGIN);
  });

  it('never trades a right overflow for a left one', async () => {
    const user = userEvent.setup();
    // A viewport barely wider than the panel: neither side can hold it, so the
    // shift stops at the left margin and the width cap does the rest.
    stubGeometry({ triggerLeft: 300, panelWidth: 384, viewport: 400 });
    renderHeader('/admin');

    await user.click(cluster('Manage'));

    expect(panelLeftEdge('manage', 300)).toBe(PANEL_MARGIN);
    expect(panelShift('manage')).toBe(-292);
  });

  it('re-fits when the window shrinks while the panel is open', async () => {
    const user = userEvent.setup();
    stubGeometry({ triggerLeft: 400 });
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    expect(panelShift('manage')).toBe(0);

    // A resize re-renders nothing on its own, so the panel watches the window
    // itself while it is open.
    vi.stubGlobal('innerWidth', 520);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(panelShift('manage')).toBe(-88);
    expect(panelRightEdge('manage', 400)).toBe(520 - PANEL_MARGIN);
  });

  it('re-measures on every opening instead of carrying the last shift over', async () => {
    const user = userEvent.setup();
    stubGeometry({ triggerLeft: 900 });
    renderHeader('/admin');

    await user.click(cluster('Manage'));
    expect(panelShift('manage')).toBe(-84);
    await user.click(cluster('Manage'));

    // Reopened with room: the shift is derived, not remembered, so it cannot
    // accumulate across openings.
    vi.restoreAllMocks();
    stubGeometry({ triggerLeft: 100 });
    await user.click(cluster('Manage'));
    expect(panelShift('manage')).toBe(0);
  });

  it('re-fits when the web fonts arrive, which re-lays the labels out unrendered', async () => {
    const user = userEvent.setup();
    // jsdom implements no font loading, so this stands in for the swap a first
    // visit gets: wider labels under an already-open panel, with no render and no
    // resize to notice it.
    let settleFonts;
    const fonts = { ready: new Promise((resolve) => { settleFonts = resolve; }) };
    Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });

    stubGeometry({ triggerLeft: 100 });
    renderHeader('/admin');
    await user.click(cluster('Manage'));
    expect(panelShift('manage')).toBe(0);

    // The fonts land: same trigger, wider panel.
    vi.restoreAllMocks();
    stubGeometry({ triggerLeft: 800, panelWidth: 400 });
    await act(async () => {
      settleFonts();
      await fonts.ready;
    });

    expect(panelShift('manage')).toBe(-184);
    expect(panelRightEdge('manage', 800, 400)).toBe(VIEWPORT - PANEL_MARGIN);
  });

  it('caps the panel at the viewport so long labels cannot run it off the screen', async () => {
    const user = userEvent.setup();
    stubGeometry({ triggerLeft: 100 });
    renderHeader('/admin');

    await user.click(cluster('Manage'));

    // The last line of defence: the shift can always be computed, but only if the
    // panel is not wider than the space it has.
    expect(menu('manage').className).toContain('w-max');
    expect(menu('manage').className).toContain('max-w-[calc(100vw-1rem)]');
  });
});

describe('AppHeader navigation: mobile drawer', () => {
  it('starts closed, with the drawer absent and the trigger collapsed', () => {
    renderHeader('/admin');

    expect(drawer()).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('aria-controls', 'app-nav-drawer');
    // Closed means one link per destination: the two presentations never both
    // render, so nothing is reachable twice or hidden-but-focusable.
    expect(screen.getAllByRole('link', { name: 'Members' })).toHaveLength(1);
  });

  it('opens on the trigger and lists every destination once, in order, with icons', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());

    const panel = drawer();
    expect(panel).toHaveAccessibleName('Menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');

    const links = within(panel).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(DRAWER_LABELS);
    expect(links.map((l) => l.getAttribute('href'))).toEqual(destinationsFor());
    // A leading icon per row, from the app's own lucide set.
    for (const link of links) expect(link.querySelector('svg')).toBeTruthy();
  });

  it('carries the same clusters into the drawer, as labeled sections', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());

    // A drawer is a vertical list that already scrolls, so the clusters are
    // headings rather than dropdowns, but the same clusters, with the same
    // contents, so the bar and the drawer teach one structure.
    for (const [label, items] of Object.entries(CLUSTERS)) {
      const section = within(drawer()).getByRole('group', { name: label });
      expect(within(section).getAllByRole('link').map((l) => l.textContent)).toEqual(items);
    }
    const primary = within(drawer())
      .getAllByRole('link')
      .slice(0, DRAWER_SECTIONS[''].length)
      .map((l) => l.textContent);
    expect(primary).toEqual(DRAWER_SECTIONS['']);
  });

  it('moves focus into the drawer so Escape can close it', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());
    expect(drawer()).toHaveFocus();

    await user.keyboard('{Escape}');
    // Focus is handed back at once, while the panel is still sliding away.
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(drawer()).not.toBeInTheDocument());
  });

  it('toggles shut on a second tap of the trigger', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());
    expect(drawer()).toBeInTheDocument();

    await user.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(drawer()).not.toBeInTheDocument());
  });

  it('dismisses by sliding out rather than vanishing', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());
    await user.click(trigger());

    // Still on screen, and taking its scrim with it: the dismissal is a slide,
    // not a disappearance. Both are gone once the slide is over.
    expect(drawer()).toBeInTheDocument();
    expect(screen.getByTestId('nav-drawer-overlay')).toBeInTheDocument();
    await waitFor(() => expect(drawer()).not.toBeInTheDocument());
    expect(screen.queryByTestId('nav-drawer-overlay')).not.toBeInTheDocument();
  });

  it('navigates and closes when a destination is tapped', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());
    await user.click(within(drawer()).getByRole('link', { name: 'Members' }));

    expect(path()).toBe('/members');
    expect(drawer()).not.toBeInTheDocument();
  });

  it('closes on a tap outside the drawer without navigating', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());
    await user.click(screen.getByTestId('nav-drawer-overlay'));

    expect(path()).toBe('/admin');
    await waitFor(() => expect(drawer()).not.toBeInTheDocument());
  });

  it('marks the active section in the drawer the same way as on desktop', async () => {
    const user = userEvent.setup();
    renderHeader('/members');

    const desktopActive = within(tabs()).getByRole('link', { name: 'Members' });
    await user.click(trigger());
    const drawerActive = within(drawer()).getByRole('link', { name: 'Members' });

    expect(drawerActive).toHaveAttribute('aria-current', 'page');
    // Same brand fill as the tab, i.e. the same navigation system.
    for (const el of [desktopActive, drawerActive]) {
      expect(el.className).toContain('bg-brand-600');
      expect(el.className).not.toContain('bg-people');
    }
  });

  it('settles into its final position even if the slide never runs', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());
    // Mid-slide Motion owns the transform, so no settled class yet.
    expect(drawer().className).not.toContain('motion-settled');

    // Once the slide would be over, the resting position is asserted from the
    // stylesheet, `.motion-settled` carries `transform: none !important`, which
    // is the one thing that beats the inline transform Motion wrote. A renderer
    // that never advanced the animation therefore still ends up with a visible,
    // positioned drawer (index.css explains the rule; motionUi.test.jsx pins it).
    await waitFor(() => expect(drawer().className).toContain('motion-settled'));
    expect(drawer()).toBeInTheDocument();
  });

  it('hands the exit back to the transform once it is dismissed', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());
    await waitFor(() => expect(drawer().className).toContain('motion-settled'));

    await user.click(trigger());
    // The settle is dropped with the panel, so the slide out is not pinned in
    // place by the rule that guarantees the resting position.
    await waitFor(() => expect(drawer().className).not.toContain('motion-settled'));
  });

  it('locks background scrolling while open and restores it on close', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');
    const before = document.body.style.overflow;

    await user.click(trigger());
    expect(document.body.style.overflow).toBe('hidden');

    await user.keyboard('{Escape}');
    // Held through the exit: the page must not scroll under a panel that is
    // still on screen, sliding away.
    expect(document.body.style.overflow).toBe('hidden');
    await waitFor(() => expect(document.body.style.overflow).toBe(before));
  });

  it('closes when the route changes under it', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(trigger());
    expect(drawer()).toBeInTheDocument();

    // A navigation the drawer did not initiate (browser back, a programmatic
    // redirect) must not leave it stranded open over the new page.
    await user.click(screen.getByRole('button', { name: 'go to reports' }));

    expect(path()).toBe('/reports');
    await waitFor(() => expect(drawer()).not.toBeInTheDocument());
  });
});

describe('AppHeader chrome', () => {
  it('follows the selected language instead of hardcoding labels', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    i18n.changeLanguage('sw');
    await waitFor(() =>
      expect(within(tabs()).getAllByRole('link').map((l) => l.textContent)).toEqual(SW_BAR_LINKS)
    );
    // The cluster labels are interface words too, not English leaks.
    expect(within(tabs()).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Usimamizi',
      'Fedha',
    ]);

    await user.click(within(tabs()).getByRole('button', { name: 'Usimamizi' }));
    expect(within(menu('manage')).getAllByRole('link').map((l) => l.textContent)).toEqual(
      SW_CLUSTER_ITEMS
    );

    expect(screen.getByRole('button', { name: 'Menyu' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Menyu' }));
    expect(drawer()).toHaveAccessibleName('Menyu');
    expect(within(drawer()).getAllByRole('link')).toHaveLength(NAV_BY_ROLE.superadmin.length);
  });

  it('logs out from the header', async () => {
    const user = userEvent.setup();
    renderHeader('/admin');

    await user.click(screen.getByRole('button', { name: /Log out/ }));

    expect(authState.logout).toHaveBeenCalledTimes(1);
    expect(path()).toBe('/login');
  });

  it('offers no navigation to a signed-out visitor', () => {
    authState.user = null;
    renderHeader('/login');

    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument();
    expect(tabs()).toBeNull();
  });
});
