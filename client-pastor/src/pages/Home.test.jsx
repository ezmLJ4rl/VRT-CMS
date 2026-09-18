import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import Home from './Home';
import api from '../api';
import i18n from '../i18n';

// The HTTP client is the only thing faked; apiErrorMessage stays real so these
// tests exercise the app's own error handling. The unread count is mocked
// because it comes from the shared provider, whose own polling is not under test
// here: only that Home renders what it is given.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { get: vi.fn(), patch: vi.fn(), post: vi.fn() } };
});

const state = vi.hoisted(() => ({ unread: 3, refresh: vi.fn() }));

vi.mock('../context/UnreadContext', () => ({
  useUnread: () => ({ messages: state.unread, emergencies: 0, refresh: state.refresh }),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'Reverend Pastor' }, loading: false }),
}));

const push = vi.hoisted(() => ({ support: { current: 'default' } }));

vi.mock('../push', () => ({
  getPushSupportState: () => push.support.current,
  enablePushNotifications: vi.fn(),
}));

// Two sub-sessions of the same service on one day: the case that made a single
// summed number wrong, because a person can be in both.
const ATTENDANCE = [
  { id: 1, service_type_name: '1st Sunday Service', sub_session_name: 'Sunday School', total: 12, count: 12, mode: 'headcount' },
  { id: 2, service_type_name: '1st Sunday Service', sub_session_name: 'Main Service', total: 44, count: 44, mode: 'headcount' },
];

function mockApi({ attendance = ATTENDANCE, byCategory = [{ key: 'zaka', label: 'Zaka (Tithe)', amount: 15000 }], notifications = [] } = {}) {
  api.get.mockImplementation((url) => {
    if (url === '/attendance') return Promise.resolve({ data: { attendance } });
    if (url === '/offerings/summary') return Promise.resolve({ data: { byType: [{ total: 15000, currency: 'TZS' }] } });
    if (url === '/reports/breakdown') return Promise.resolve({ data: { breakdown: byCategory } });
    if (url === '/notifications') return Promise.resolve({ data: { notifications } });
    return Promise.resolve({ data: {} });
  });
}

// A real route for /messages, so "the tile navigates" is asserted by arriving
// somewhere rather than by inspecting a callback.
function renderHome() {
  return render(
    <MemoryRouter initialEntries={['/home']}>
      <Routes>
        <Route path="/home" element={<Home />} />
        <Route path="/messages" element={<p>messages screen</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const breakdown = () => screen.getByRole('heading', { name: "Today's attendance" }).closest('section');
const notificationsTile = () => screen.getByRole('button', { name: /Notifications/ });

// Session labels appear twice on Home, in the breakdown list and in the chart
// legend, so every assertion about the list is scoped to the list's own section
// rather than matching whichever copy the query happens to find first.
async function breakdownContaining(text) {
  await waitFor(() => expect(within(breakdown()).getByText(text)).toBeInTheDocument());
  return within(breakdown());
}

beforeEach(() => {
  state.unread = 3;
  push.support.current = 'default';
  mockApi();
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Home: today\'s attendance is a breakdown, not a blind total', () => {
  it('lists every recorded session against its own service and sub-session', async () => {
    renderHome();

    const section = await breakdownContaining('1st Sunday Service · Sunday School');
    expect(section.getByText('1st Sunday Service · Main Service')).toBeInTheDocument();
  });

  it('never shows the sum of the rows, which would double-count people', async () => {
    renderHome();
    const section = await breakdownContaining('1st Sunday Service · Sunday School');

    // 12 + 44 = 56 would be the old, misleading headline figure.
    expect(screen.queryByText('56')).not.toBeInTheDocument();

    expect(section.getByText(/12\s+recorded/)).toBeInTheDocument();
    expect(section.getByText(/44\s+recorded/)).toBeInTheDocument();
  });

  it('says why there is no single figure, so its absence is not read as a bug', async () => {
    renderHome();

    expect(await screen.findByText(/Each row is labeled recorded headcount or unique attendees/)).toBeInTheDocument();
  });

  it('says nothing was recorded today rather than showing a zero', async () => {
    mockApi({ attendance: [], notifications: [] });
    renderHome();

    // Both the list and the chart say so, in their own place.
    const messages = await screen.findAllByText('No attendance recorded yet today.');
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(within(breakdown()).getByText('No attendance recorded yet today.')).toBeInTheDocument();
  });

  it('keeps offerings as one total: each gift is a distinct transaction', async () => {
    renderHome();

    expect(await screen.findByText(/15,000 TZS/)).toBeInTheDocument();
  });

  it('shows both real measures for a dual-mode named-attendance session', async () => {
    mockApi({
      attendance: [{ id: 11, service_type_name: 'Special Event', sub_session_name: null, count: 44, attendees: ['Asha', 'Baraka'], mode: 'both' }],
    });
    renderHome();

    const section = await breakdownContaining('Special Event');
    expect(section.getByText(/44\s+recorded/)).toBeInTheDocument();
    expect(section.getByText(/2\s+unique attendees/)).toBeInTheDocument();
  });

  it('reports the count from the session rows, including a session with no sub-session', async () => {
    mockApi({
      attendance: [{ id: 9, service_type_name: 'Friday Service', sub_session_name: null, mode: 'named', count: 7 }],
    });
    renderHome();

    const section = await breakdownContaining('Friday Service');
    expect(section.getByText(/7\s+unique attendees/)).toBeInTheDocument();
  });
});

describe('Home: services and rehearsals are listed apart', () => {
  // One service and one rehearsal on the same day: the case where an
  // interleaved list let a choir practice read as service attendance.
  const MIXED = [
    { id: 1, service_type_name: '1st Sunday Service', sub_session_name: 'Main Service', total: 44, service_type_kind: 'service' },
    { id: 2, service_type_name: 'Choir Rehearsal 1', sub_session_name: null, total: 12, service_type_kind: 'rehearsal' },
  ];

  // The heading's own wrapper is the group, so every assertion below is about
  // one side of the split rather than about the section as a whole.
  const group = (name) => within(breakdown()).getByRole('heading', { name }).parentElement;

  async function renderWith(attendance) {
    mockApi({ attendance });
    renderHome();
    await waitFor(() => expect(within(breakdown()).getByText(attendance[0].service_type_name, { exact: false })).toBeInTheDocument());
  }

  it('keeps a rehearsal out of the services list and a service out of the rehearsals list', async () => {
    await renderWith(MIXED);

    expect(within(group('Services')).getByText('1st Sunday Service · Main Service')).toBeInTheDocument();
    expect(within(group('Services')).queryByText('Choir Rehearsal 1')).not.toBeInTheDocument();

    expect(within(group('Rehearsals')).getByText('Choir Rehearsal 1')).toBeInTheDocument();
    expect(within(group('Rehearsals')).queryByText('1st Sunday Service · Main Service')).not.toBeInTheDocument();
  });

  it('explains that rehearsal attendance is not part of the service figures', async () => {
    await renderWith(MIXED);

    expect(within(group('Rehearsals')).getByText(/Attendance only/)).toBeInTheDocument();
  });

  it('says no rehearsal happened rather than dropping the group', async () => {
    await renderWith([MIXED[0]]);

    // Absent group and "none recorded" must not look alike.
    expect(within(group('Rehearsals')).getByText('No rehearsals recorded yet today.')).toBeInTheDocument();
    expect(within(group('Rehearsals')).queryByText('Choir Rehearsal 1')).not.toBeInTheDocument();
  });

  it('treats a session whose type carries no kind as a service, never as a rehearsal', async () => {
    // The schema defaults kind to 'service', so an unclassified row belongs on
    // the services side: guessing "rehearsal" would hide a real service.
    await renderWith([{ id: 3, service_type_name: 'Friday Service', sub_session_name: null, total: 7 }]);

    expect(within(group('Services')).getByText('Friday Service')).toBeInTheDocument();
    expect(within(group('Rehearsals')).queryByText('Friday Service')).not.toBeInTheDocument();
  });
});

describe('Home: notifications are real, not a label', () => {
  it('shows the unread count on a badge and opens the messages view when tapped', async () => {
    const user = userEvent.setup();
    renderHome();

    const tile = await screen.findByRole('button', { name: /Notifications/ });
    expect(within(tile).getByText('3')).toBeInTheDocument();
    expect(within(tile).getByText('3 unread')).toBeInTheDocument();

    await user.click(tile);

    expect(await screen.findByText('messages screen')).toBeInTheDocument();
  });

  it('says it is up to date, with no badge, when nothing is waiting', async () => {
    state.unread = 0;
    renderHome();

    const tile = await screen.findByRole('button', { name: /Notifications/ });
    expect(within(tile).getByText("You're up to date.")).toBeInTheDocument();
    expect(within(tile).queryByText('0')).not.toBeInTheDocument();
  });

  it('distinguishes an unsupported browser from the in-app feed, which works regardless', async () => {
    // Unsupported is the browser, not the transport: browsers treat localhost as
    // a secure context, so dev is not the reason push fails, and the copy must
    // not tell the pastor it is.
    push.support.current = 'unsupported';
    renderHome();

    expect(await screen.findByText("This browser can't do push notifications.")).toBeInTheDocument();
    expect(screen.getByText(/add this app to your Home Screen/i)).toBeInTheDocument();
    expect(screen.queryByText(/HTTPS/i)).not.toBeInTheDocument();
    // The in-app count is unaffected by push being unavailable.
    expect(within(notificationsTile()).getByText('3')).toBeInTheDocument();
  });

});
