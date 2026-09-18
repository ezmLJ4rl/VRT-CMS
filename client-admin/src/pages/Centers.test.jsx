import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Centers from './Centers';
import api from '../api';
import { EMPTY_VALUE } from '../emptyValue';
import i18n from '../i18n';

vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

// Mutable so the role-gated parts of the page (trends, center editing) can be
// read from a receptionist's side without a second test file.
const auth = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { role: auth.role } }),
}));

// The profile panel does its own `/members/:id` fetch; these rules are about the
// roster that opens it, so the panel only has to report whose details were asked
// for.
vi.mock('../components/MemberProfile', () => ({
  default: ({ memberId, onClose }) => (
    <div>
      profile for {memberId}
      {onClose && <button type="button" onClick={onClose}>Close</button>}
    </div>
  ),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

const CENTERS = [
  {
    id: 1,
    name: 'Kimara Revival Center',
    is_active: 1,
    sort_order: 1,
    member_count: 4,
    // Zone C holds nobody: the roster still has to show that it exists.
    // One zone led by one member, one led by nobody, and one led by two: one of
    // whom has been deactivated. Those are the states a zone card has to state.
    zones: [
      // One zone with an office recorded, one with nobody leading it, and one
      // whose first bearer has no role (a row written before roles existed) and
      // whose second bearer has since been deactivated.
      { id: 11, name: 'Zone A', is_active: 1, leaders: [{ member_id: 21, name: 'Neema K', role_name: 'Deacon', member_no: 'VRT-0021', is_active: 1 }] },
      { id: 12, name: 'Zone B', is_active: 1, leaders: [] },
      {
        id: 13,
        name: 'Zone C',
        is_active: 1,
        leaders: [
          { member_id: 25, name: 'Asha Kiongozi', role_name: '', member_no: 'VRT-0025', is_active: 0 },
          { member_id: 27, name: 'Ruth Mwenza', role_name: 'Secretary', member_no: 'VRT-0027', is_active: 1 },
        ],
      },
    ],
  },
  { id: 2, name: 'Mbezi Revival Center', is_active: 1, sort_order: 2, member_count: 0, zones: [] },
  // More members than one capped load returns, so the roster has to admit it.
  { id: 3, name: 'Tabata Revival Center', is_active: 1, sort_order: 3, member_count: 9, zones: [] },
  // Zones but nobody filed in them: both zones still have to show, empty.
  {
    id: 4,
    name: 'Kigamboni Revival Center',
    is_active: 1,
    sort_order: 4,
    member_count: 0,
    zones: [
      { id: 41, name: 'Zone A', is_active: 1, leaders: [] },
      { id: 42, name: 'Zone B', is_active: 1, leaders: [] },
    ],
  },
];

// What the member picker finds. It carries the picker's own shape (id, name and
// where the person is filed), which is not the roster row shape.
const PICKER_HITS = [
  { id: 26, name: 'Sifa Leader', center_name: 'Kimara Revival Center', zone_name: 'Zone A' },
];

const TREND_MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];

// Rebuilt per test from CENTERS so a zone leader written during a test is read
// back by the page's next load.
let centersState;

// Center 1 gathers pace, center 3 fades, center 2 has nothing at all: the three
// readings the page exists to tell apart.
const TRENDS = {
  months: TREND_MONTHS,
  centers: [
    { key: 1, attendance: [100, 110, 120, 130, 140, 160], offering: [50000, 60000, 70000, 80000, 90000, 120000] },
    { key: 2, attendance: [0, 0, 0, 0, 0, 0], offering: [0, 0, 0, 0, 0, 0] },
    { key: 3, attendance: [80, 70, 60, 50, 40, 20], offering: [40000, 40000, 30000, 20000, 10000, 5000] },
  ],
};

const ROSTER = [
  { id: 21, member_no: 'VRT-0021', name: 'Neema K', phone: '+255700000021', email: '', is_active: 1, zone_id: 11, zone_name: 'Zone A', group_names: 'Harvest Choir', member_groups: [{ id: 1, name: 'Harvest Choir', has_logo: false }] },
  // Filed with no zone at all: a real state, not a reason to disappear.
  { id: 22, member_no: 'VRT-0022', name: 'Baraka J', phone: '', email: 'baraka@example.com', is_active: 1, zone_id: null, zone_name: null, group_names: null, member_groups: [] },
  { id: 23, member_no: 'VRT-0023', name: 'Zawadi M', phone: '+255700000023', email: '', is_active: 0, zone_id: 11, zone_name: 'Zone A', group_names: 'Watoto', member_groups: [{ id: 3, name: 'Watoto', has_logo: false }] },
  { id: 24, member_no: 'VRT-0024', name: 'Amani T', phone: '+255700000024', email: '', is_active: 1, zone_id: 12, zone_name: 'Zone B', group_names: null, member_groups: [] },
];

// Who a member id belongs to, for the leaders a test assigns: every member the
// mocks can hand back.
const LEADER_NAMES = new Map([
  ...CENTERS.flatMap((c) => c.zones.flatMap((z) => (z.leaders || []).map((l) => [l.member_id, l.name]))),
  ...ROSTER.map((m) => [m.id, m.name]),
  ...PICKER_HITS.map((h) => [h.id, h.name]),
]);

beforeEach(() => {
  auth.role = 'admin';
  // A live copy of the centers, so a write the page performs is visible in the
  // very next read, which is what makes "the line updates without a reload"
  // something the test can actually see rather than assume.
  centersState = structuredClone(CENTERS);
  api.patch.mockImplementation((url, body) => {
    if (url.startsWith('/revival-centers/zones/') && body && Array.isArray(body.leaders)) {
      const id = Number(url.split('/').pop());
      const zone = centersState.flatMap((c) => c.zones).find((z) => z.id === id);
      if (zone) {
        // The write is the whole set, so the mock records the set it was given.
        zone.leaders = body.leaders.map(({ memberId, roleName }) => ({
          member_id: memberId,
          name: LEADER_NAMES.get(memberId) ?? null,
          role_name: roleName || '',
          is_active: 1,
        }));
      }
    }
    return Promise.resolve({ data: {} });
  });
  api.get.mockImplementation((url, config) => {
    if (url === '/revival-centers') return Promise.resolve({ data: { revivalCenters: centersState } });
    if (url === '/reports/center-trends') return Promise.resolve({ data: TRENDS });
    if (url === '/members') {
      // The member picker searches the whole directory by name; the roster is
      // asked for by center: a roster fetched without that filter would show
      // members from every center.
      if (config?.params?.search) return Promise.resolve({ data: { members: PICKER_HITS } });
      return [1, 3].includes(config?.params?.centerId)
        ? Promise.resolve({ data: { members: ROSTER } })
        : Promise.resolve({ data: { members: [] } });
    }
    return Promise.resolve({ data: {} });
  });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

function renderPage() {
  return render(
    <MemoryRouter>
      <Centers />
    </MemoryRouter>
  );
}

/**
 * The zone's own row inside the management panel.
 *
 * Named rather than "the element with this text": the center's leader roll-up
 * also names the zone each person leads, so a text query would find that too.
 * The zone's row is the one that carries the "Zone leaders:" line.
 */
function zoneRow(row, zoneName) {
  return [...row.querySelectorAll('li')].find(
    (li) => within(li).queryByText('Zone leaders:') && within(li).queryByText(zoneName)
  );
}

async function openRoster(user, centerName) {
  // Open the roster on the row we want rather than whichever center is first.
  await screen.findByText(centerName);
  const row = screen.getByText(centerName).closest('li');
  await user.click(within(row).getByRole('button', { name: 'View members' }));
  return { row };
}

describe('Revival Centers', () => {
  it('does not register members, that moved to the Members screen', async () => {
    renderPage();
    await screen.findByText('Kimara Revival Center');
    expect(screen.queryByRole('button', { name: /register/i })).toBeNull();
    // The screen introduces itself as what it manages, and carries no note about
    // registration having moved: the management controls are the whole page.
    expect(screen.getByText(/The revival centers and their zones/)).toBeInTheDocument();
    expect(screen.queryByText(/registered on the Members screen/i)).toBeNull();
  });

  it('opens a read-only roster of the members filed at a center', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Kimara Revival Center');

    await waitFor(() => expect(within(row).getByText('Neema K')).toBeInTheDocument());
    expect(api.get).toHaveBeenCalledWith('/members', { params: { centerId: 1, limit: 500 } });
    // Everyone filed there, active or not, with their zone and contact.
    expect(within(row).getByText('Zawadi M')).toBeInTheDocument();
    expect(within(row).getByText('VRT-0023')).toBeInTheDocument();
    expect(within(row).getByText('+255700000021')).toBeInTheDocument();
    expect(within(row).getByText(/Read-only/)).toBeInTheDocument();
    // No writer on this screen: neither editing nor deleting a member.
    expect(within(row).queryByRole('button', { name: /delete/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /^edit$/i })).toBeNull();
  });

  it('shows a member’s details on demand and closes them again', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Kimara Revival Center');
    await waitFor(() => expect(within(row).getByText('Neema K')).toBeInTheDocument());

    await user.click(within(row).getByText('Neema K'));
    expect(within(row).getByText('profile for 21')).toBeInTheDocument();
    // One profile at a time: opening another person replaces the first.
    await user.click(within(row).getByText('Amani T'));
    expect(within(row).getByText('profile for 24')).toBeInTheDocument();
    expect(within(row).queryByText('profile for 21')).toBeNull();

    await user.click(within(row).getByText('Close'));
    expect(within(row).queryByText('profile for 24')).toBeNull();
  });

  it('separates the roster by zone, each with its own count', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Kimara Revival Center');
    await waitFor(() => expect(within(row).getByText('Neema K')).toBeInTheDocument());

    const zoneA = within(row).getByRole('heading', { name: 'Zone A' }).closest('section');
    const zoneB = within(row).getByRole('heading', { name: 'Zone B' }).closest('section');
    const zoneC = within(row).getByRole('heading', { name: 'Zone C' }).closest('section');

    // Each zone states its own size, and holds only its own members.
    expect(within(zoneA).getByText('2 members')).toBeInTheDocument();
    expect(within(zoneB).getByText('1 member')).toBeInTheDocument();
    expect(within(zoneA).getByText('Neema K')).toBeInTheDocument();
    expect(within(zoneA).getByText('Zawadi M')).toBeInTheDocument();
    expect(within(zoneA).queryByText('Amani T')).toBeNull();
    expect(within(zoneB).getByText('Amani T')).toBeInTheDocument();
    expect(within(zoneB).queryByText('Neema K')).toBeNull();

    // An empty zone keeps its section, so an admin sees the zone exists rather
    // than wondering whether the roster lost it.
    expect(within(zoneC).getByText('No members in Zone C yet.')).toBeInTheDocument();

    // And nobody is unaccounted for: the member with no zone gets a section of
    // their own rather than vanishing from the roster.
    const noZone = within(row).getByRole('heading', { name: 'No zone' }).closest('section');
    expect(within(noZone).getByText('Baraka J')).toBeInTheDocument();
    expect(within(noZone).queryByText('Neema K')).toBeNull();
  });

  it('says who leads each zone on the roster card', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Kimara Revival Center');
    await waitFor(() => expect(within(row).getByText('Neema K')).toBeInTheDocument());

    // A zone says who holds office in it, and for what: a bare list of names
    // would leave the reader unable to tell who is in charge of what.
    const zoneA = within(row).getByRole('heading', { name: 'Zone A' }).closest('section');
    expect(within(zoneA).getByText('Deacon: Neema K')).toBeInTheDocument();

    // An unled zone says so, rather than leaving the reader to guess…
    const zoneB = within(row).getByRole('heading', { name: 'Zone B' }).closest('section');
    expect(within(zoneB).getByText('No leader yet')).toBeInTheDocument();

    // …and a zone with several bearers names each with their office, marking a
    // bearer who has since left so no name reads as current by accident. A role
    // recorded before roles existed shows as a plain Leader.
    const zoneC = within(row).getByRole('heading', { name: 'Zone C' }).closest('section');
    expect(
      within(zoneC).getByText('Leader: Asha Kiongozi (Inactive) · Secretary: Ruth Mwenza')
    ).toBeInTheDocument();

    // A member's own row never claims to be a leader: that is the zone's fact.
    expect(within(row).queryByText('Led by Baraka J')).toBeNull();
  });

  it('states a zone leader as one plain line, not as a selected card', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    const zoneARow = zoneRow(row, 'Zone A');
    const zoneBRow = zoneRow(row, 'Zone B');
    const zoneCRow = zoneRow(row, 'Zone C');

    // A label per zone, and each zone's own leaders beside it with the office
    // each of them holds.
    expect(within(row).getAllByText('Zone leaders:')).toHaveLength(3);
    expect(within(zoneARow).getByText('Deacon')).toBeInTheDocument();
    expect(within(zoneARow).getByText('Neema K')).toBeInTheDocument();
    expect(within(zoneBRow).getByText(EMPTY_VALUE)).toBeInTheDocument();
    // A bearer recorded before roles existed is offered exactly what is missing
    // naming the role: rather than an invented job crowned with a big control.
    expect(within(zoneCRow).getByRole('button', { name: 'Name role' })).toBeInTheDocument();
    expect(within(zoneCRow).getByText('Asha Kiongozi')).toBeInTheDocument();
    // …and the second bearer's own office is named beside them.
    expect(within(zoneCRow).getByText('Secretary')).toBeInTheDocument();
    expect(within(zoneCRow).getByText('Ruth Mwenza')).toBeInTheDocument();

    // One action per zone, whatever it already has, and no form until it is
    // asked for.
    expect(within(row).getAllByRole('button', { name: 'Assign a leader' })).toHaveLength(3);
    expect(within(row).queryByRole('combobox')).toBeNull();
    expect(within(row).queryByText('From the member list')).toBeNull();
  });

  it('assigns a member of the zone, with the office the form gives them', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    const zoneB = zoneRow(row, 'Zone B');
    await user.click(within(zoneB).getByRole('button', { name: 'Assign a leader' }));

    // The people on offer are the ones filed in THIS zone, and nobody else.
    expect(within(zoneB).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a member of this zone',
      'Amani T',
    ]);
    expect(within(zoneB).queryByRole('option', { name: 'Neema K' })).toBeNull();

    // The job is the point of the assignment, so it is required.
    const add = within(zoneB).getByRole('button', { name: 'Add leader' });
    await user.selectOptions(within(zoneB).getByRole('combobox', { name: 'Member' }), '24');
    expect(add).toBeDisabled();
    await user.type(within(zoneB).getByPlaceholderText('e.g. Deacon'), 'Treasurer');
    expect(add).toBeEnabled();
    await user.click(add);

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/revival-centers/zones/12', {
        leaders: [{ memberId: 24, roleName: 'Treasurer' }],
      })
    );
    // The line carries the office and the name, with no page reload in between.
    await waitFor(() => expect(within(zoneB).getByText('Treasurer')).toBeInTheDocument());
    expect(within(zoneB).getByText('Amani T')).toBeInTheDocument();
    expect(within(row).queryByRole('combobox', { name: 'Member' })).toBeNull();
  });

  // Interaction-heavy (opens a member picker, awaits live timers) and starves
  // under the full parallel run: every query in it resolves comfortably in
  // isolation and in pairs; only the 14-worker run starves it past 5s.
  it('shows the new leader before the write has even landed', { timeout: 15000 }, async () => {
    // The line is what the admin just did, so it must not sit empty while the
    // round trip completes, that gap is why the choice is held locally rather
    // than read straight off the reload.
    let release;
    api.patch.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ data: {} }); }));

    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    const zoneB = zoneRow(row, 'Zone B');
    await user.click(within(zoneB).getByRole('button', { name: 'Assign a leader' }));
    await user.selectOptions(within(zoneB).getByRole('combobox', { name: 'Member' }), '24');
    await user.type(within(zoneB).getByPlaceholderText('e.g. Deacon'), 'Treasurer');
    await user.click(within(zoneB).getByRole('button', { name: 'Add leader' }));

    expect(within(zoneB).getByText('Amani T')).toBeInTheDocument();
    expect(within(zoneB).getByText('Treasurer')).toBeInTheDocument();
    release();
  });

  it('offers nobody who already holds an office in that zone', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    // Neema K is filed in Zone A and is already its Deacon, and one member holds
    // one role per zone, so she is not offered a second one.
    const zoneA = zoneRow(row, 'Zone A');
    await user.click(within(zoneA).getByRole('button', { name: 'Assign a leader' }));
    expect(within(zoneA).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a member of this zone',
      'Zawadi M',
    ]);
  });

  it('cannot offer a leader for a zone with nobody filed in it', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    // Zone C has leaders recorded but no members of its own, so nobody could
    // legitimately be given an office there, and the app says why.
    const zoneC = zoneRow(row, 'Zone C');
    const assign = within(zoneC).getByRole('button', { name: 'Assign a leader' });
    expect(assign).toBeDisabled();
    expect(assign).toHaveAttribute('title', 'No members in Zone C yet.');
  });

  it('rolls every zone leader up to the center, with their office and zone', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    // Nobody was ever assigned a "center leader": this is the zones' leaders.
    const rollUp = within(row).getByText('Center leaders').closest('div');
    expect(within(rollUp).getByText('Neema K')).toBeInTheDocument();
    expect(within(rollUp).getByText('Deacon')).toBeInTheDocument();
    expect(within(rollUp).getByText('Zone A')).toBeInTheDocument();
    expect(within(rollUp).getByText('Ruth Mwenza')).toBeInTheDocument();
    expect(within(rollUp).getByText('Secretary')).toBeInTheDocument();
    // Both of Zone C's bearers are named with the zone they lead.
    expect(within(rollUp).getAllByText('Zone C')).toHaveLength(2);
    expect(within(rollUp).getByText(/nothing to assign here/)).toBeInTheDocument();
  });

  it('drops a leader out of the roll-up the moment they leave the zone', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    const zoneA = zoneRow(row, 'Zone A');
    await user.click(within(zoneA).getByRole('button', { name: 'Remove as leader: Neema K' }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/revival-centers/zones/11', { leaders: [] }));
    // The roll-up is computed from the zones, so the two cannot disagree.
    const rollUp = within(row).getByText('Center leaders').closest('div');
    await waitFor(() => expect(within(rollUp).queryByText('Neema K')).toBeNull());
    expect(within(rollUp).getByText('Ruth Mwenza')).toBeInTheDocument();
  });

  it('keeps the other bearers of office when one is removed', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    // Zone C has two; taking one out leaves the other in office, with her role.
    const zoneC = zoneRow(row, 'Zone C');
    await user.click(within(zoneC).getByRole('button', { name: 'Remove as leader: Asha Kiongozi' }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/revival-centers/zones/13', {
        leaders: [{ memberId: 27, roleName: 'Secretary' }],
      })
    );
    await waitFor(() => expect(within(zoneC).queryByText('Asha Kiongozi')).toBeNull());
    expect(within(zoneC).getByText('Secretary')).toBeInTheDocument();
    expect(within(zoneC).getByText('Ruth Mwenza')).toBeInTheDocument();
  });

  it('names the role of somebody already in office, in place, instead of taking it away first', async () => {
    const user = userEvent.setup();
    // A row written before roles existed: Zawadi M holds office in Zone A with
    // no role recorded. Nothing else in the app can give a role to somebody who
    // already leads the zone, and removing then re-adding would be the same
    // write with an interval in which nobody leads it.
    centersState[0].zones.find((z) => z.id === 11).leaders.push({
      member_id: 23, name: 'Zawadi M', role_name: '', member_no: 'VRT-0023', is_active: 1,
    });
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    const zoneA = zoneRow(row, 'Zone A');
    await user.click(within(zoneA).getByRole('button', { name: 'Name role' }));

    // The form opens on that person, who is named rather than chosen again.
    expect(within(zoneA).getByRole('combobox', { name: 'Member' })).toHaveValue('23');
    await user.type(within(zoneA).getByPlaceholderText('e.g. Deacon'), 'Treasurer');
    await user.click(within(zoneA).getByRole('button', { name: 'Save role' }));

    // One entry per person: the office is RENAMED, not held twice.
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/revival-centers/zones/11', {
        leaders: [{ memberId: 21, roleName: 'Deacon' }, { memberId: 23, roleName: 'Treasurer' }],
      })
    );
    await waitFor(() => expect(within(zoneA).getByText('Treasurer')).toBeInTheDocument());
    expect(within(zoneA).getAllByRole('button', { name: /Remove as leader/ })).toHaveLength(2);
    expect(within(zoneA).queryByRole('button', { name: 'Name role' })).toBeNull();
  });

  it('marks an office held by somebody filed in another zone, and leaves the fix one click away', async () => {
    const user = userEvent.setup();
    // A row written before "a leader must be filed in their zone" existed: Neema K
    // holds office in Zone A while the API says she is filed in Zone B. The zone
    // must not be allowed to claim her as its own leader.
    centersState[0].zones.find((z) => z.id === 11).leaders[0].member_zone_id = 12;
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');
    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));

    const zoneA = zoneRow(row, 'Zone A');
    expect(within(zoneA).getByText('not in this zone')).toBeInTheDocument();
    // The roll-up says the same thing. A summary that read correctly while the
    // assignment was wrong would be the one screen worth nothing.
    const rollUp = within(row).getByText('Center leaders').closest('div');
    expect(within(rollUp).getByText('not in this zone')).toBeInTheDocument();

    // Removing it is the fix, and it is right there: nothing rewrites the
    // admin's assignment behind their back.
    await user.click(within(zoneA).getByRole('button', { name: 'Remove as leader: Neema K' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/revival-centers/zones/11', { leaders: [] }));
    await waitFor(() => expect(within(zoneA).queryByText('not in this zone')).toBeNull());
    expect(within(rollUp).queryByText('not in this zone')).toBeNull();
  });

  it('says so on the roster card when a zone’s leader is filed in another zone', async () => {
    const user = userEvent.setup();
    centersState[0].zones.find((z) => z.id === 11).leaders[0].member_zone_id = 12;
    renderPage();
    const { row } = await openRoster(user, 'Kimara Revival Center');

    // The roster lists this zone's members underneath this line, so a leader's
    // name appearing nowhere in that list is exactly the contradiction worth
    // naming on the card itself.
    await waitFor(() => expect(within(row).getByText(/Deacon: Neema K/)).toBeInTheDocument());
    expect(within(row).getByText(/\(not in this zone\)/)).toBeInTheDocument();
  });

  it('keeps a member whose zone is not in the center’s list rather than dropping them', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/revival-centers') return Promise.resolve({ data: { revivalCenters: CENTERS } });
      if (url === '/reports/center-trends') return Promise.resolve({ data: TRENDS });
      if (url === '/members') {
        return Promise.resolve({ data: { members: [{ ...ROSTER[0], id: 31, name: 'Sifa N', zone_id: 99, zone_name: 'Zone Z' }] } });
      }
      return Promise.resolve({ data: {} });
    });
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Kimara Revival Center');

    await waitFor(() => expect(within(row).getByText('Sifa N')).toBeInTheDocument());
    // Filed under a zone this center's list does not know about: still shown,
    // named after the zone they are actually in.
    expect(within(row).getByRole('heading', { name: 'Zone Z' })).toBeInTheDocument();
  });

  it('filters within each zone, and a zone’s header still states its real size', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Kimara Revival Center');
    await waitFor(() => expect(within(row).getByText('Neema K')).toBeInTheDocument());

    await user.type(within(row).getByPlaceholderText('Filter by name…'), 'zawa');
    const zoneA = within(row).getByRole('heading', { name: 'Zone A' }).closest('section');
    expect(within(zoneA).getByText('Zawadi M')).toBeInTheDocument();
    expect(within(zoneA).queryByText('Neema K')).toBeNull();
    // A search narrows the rows; it does not shrink the zone.
    expect(within(zoneA).getByText('2 members')).toBeInTheDocument();

    // Zones with nothing left to show fold away, so a search does not scroll
    // past them to reach the hit.
    await user.clear(within(row).getByPlaceholderText('Filter by name…'));
    await user.type(within(row).getByPlaceholderText('Filter by name…'), 'amani');
    expect(within(row).getByRole('heading', { name: 'Zone B' })).toBeInTheDocument();
    expect(within(row).queryByRole('heading', { name: 'Zone A' })).toBeNull();
    expect(within(row).queryByRole('heading', { name: 'Zone C' })).toBeNull();
  });

  it('filters the roster by name without re-fetching', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Kimara Revival Center');
    await waitFor(() => expect(within(row).getByText('Neema K')).toBeInTheDocument());

    await user.type(within(row).getByPlaceholderText('Filter by name…'), 'zawa');
    expect(within(row).getByText('Zawadi M')).toBeInTheDocument();
    expect(within(row).queryByText('Neema K')).toBeNull();
    // One fetch for the whole roster: filtering is a view, not a query.
    expect(api.get.mock.calls.filter(([url]) => url === '/members')).toHaveLength(1);

    await user.clear(within(row).getByPlaceholderText('Filter by name…'));
    await user.type(within(row).getByPlaceholderText('Filter by name…'), 'nobody');
    expect(within(row).getByText(/No member here matches/i)).toBeInTheDocument();
  });

  it('closes the roster when the toggle is clicked again', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Kimara Revival Center');
    await waitFor(() => expect(within(row).getByText('Neema K')).toBeInTheDocument());

    await user.click(within(row).getByRole('button', { name: 'Hide members' }));
    expect(within(row).queryByText('Neema K')).toBeNull();
  });

  it('says so when a center is bigger than one roster load', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Tabata Revival Center');
    await waitFor(() => expect(within(row).getByText('Neema K')).toBeInTheDocument());
    expect(within(row).getByText('Showing the first 4 of 9 members.')).toBeInTheDocument();
  });

  it('asks for every center’s trend in one request, not one per row', async () => {
    renderPage();
    await screen.findByText('Kimara Revival Center');

    await waitFor(() => expect(screen.getByText(/Per center, over the last 6 complete months/)).toBeInTheDocument());
    expect(screen.getByText(/The current month is not counted yet/)).toBeInTheDocument();
    const trendCalls = api.get.mock.calls.filter(([url]) => url === '/reports/center-trends');
    expect(trendCalls).toHaveLength(1);
    expect(trendCalls[0][1]).toEqual({ params: { months: 6 } });
    // The window is named, and the month in progress is deliberately not in it.
    expect(screen.getByText(/Mar 2026 – Aug 2026/)).toBeInTheDocument();
  });

  it('says which centers are growing and which are fading', async () => {
    renderPage();
    await screen.findByText('Kimara Revival Center');

    const growing = screen.getByText('Kimara Revival Center').closest('li');
    const fading = screen.getByText('Tabata Revival Center').closest('li');
    await waitFor(() => expect(within(growing).getByText('+33%')).toBeInTheDocument());
    expect(within(fading).getByText(/67%/)).toBeInTheDocument();
    // The latest month's figures sit beside the line, so the shape is not the
    // only thing the reader has to go on.
    expect(within(growing).getByText('Aug 2026 · 160')).toBeInTheDocument();
    expect(within(growing).getByText('Aug 2026 · TZS 120k')).toBeInTheDocument();
  });

  it('shows a center only as what it is, until it is opened for management', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const row = screen.getByText('Kimara Revival Center').closest('li');

    // Name, the two counts, and the two actions you take on a center: nothing else.
    expect(within(row).getByText('4 members')).toBeInTheDocument();
    expect(within(row).getByText('3 zones')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'View members' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Disable' })).toBeInTheDocument();

    // The management surface is not on every row at once: no zone rows, no
    // add-zone field, no reorder arrows until the row is opened.
    expect(within(row).queryAllByText('Zone leaders:')).toHaveLength(0);
    expect(within(row).queryByPlaceholderText('Add zone…')).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Move up' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Move down' })).toBeNull();

    await user.click(within(row).getByRole('button', { name: 'Manage zones' }));
    expect(within(row).getAllByText('Zone leaders:')).toHaveLength(3);
    expect(within(row).getByPlaceholderText('Add zone…')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Move up' })).toBeInTheDocument();
  });

  it('opens one center for management at a time, as Service Types does', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');
    const kimara = screen.getByText('Kimara Revival Center').closest('li');
    const mbezi = screen.getByText('Mbezi Revival Center').closest('li');

    await user.click(within(kimara).getByRole('button', { name: 'Manage zones' }));
    expect(within(kimara).getAllByText('Zone leaders:')).toHaveLength(3);

    await user.click(within(mbezi).getByRole('button', { name: 'Manage zones' }));
    // Opening the second closes the first, so nothing editable is on screen twice.
    expect(within(kimara).queryAllByText('Zone leaders:')).toHaveLength(0);
    expect(within(kimara).queryByRole('button', { name: 'Manage zones' })).toBeInTheDocument();
    expect(within(mbezi).getByText('No zones yet.')).toBeInTheDocument();
  });

  it('keeps a silent center’s “no activity” out of the list and answers it in the opened row', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Mbezi Revival Center');
    const silent = screen.getByText('Mbezi Revival Center').closest('li');
    // Wait for the trends themselves, so "nothing is shown" cannot merely mean
    // "nothing has arrived yet".
    await screen.findByText(/Mar 2026 – Aug 2026/);

    // "Nothing to report" repeated down eight centers is not a reading.
    expect(within(silent).queryByText('no activity')).toBeNull();

    await user.click(within(silent).getByRole('button', { name: 'Manage zones' }));
    // It is answered where someone has actually asked about that one center, and
    // for both series: attendance and giving.
    await waitFor(() => expect(within(silent).getAllByText('no activity')).toHaveLength(2));
  });

  it('does not ask for trends a receptionist may not read, and never breaks on a failed one', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/revival-centers') return Promise.resolve({ data: { revivalCenters: CENTERS } });
      if (url === '/reports/center-trends') return Promise.reject(new Error('403'));
      return Promise.resolve({ data: {} });
    });
    auth.role = 'receptionist';
    renderPage();

    await screen.findByText('Kimara Revival Center');
    expect(api.get.mock.calls.filter(([url]) => url === '/reports/center-trends')).toHaveLength(0);

    // And an admin whose trend request fails keeps the centers list itself.
    auth.role = 'admin';
    renderPage();
    await waitFor(() => expect(api.get.mock.calls.filter(([url]) => url === '/reports/center-trends').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Kimara Revival Center').length).toBeGreaterThan(0);
  });

  it('reports an empty center as empty rather than broken', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Mbezi Revival Center');
    await waitFor(() => expect(within(row).getByText(/No members are registered/i)).toBeInTheDocument());
  });

  it('shows every zone of a center that has nobody in it at all', async () => {
    const user = userEvent.setup();
    renderPage();
    const { row } = await openRoster(user, 'Kigamboni Revival Center');

    // The zones exist, so the panel says so and says they are empty: rather
    // than one line that leaves an admin wondering whether the zones are gone.
    const zoneA = (await waitFor(() => within(row).getByRole('heading', { name: 'Zone A' }))).closest('section');
    const zoneB = within(row).getByRole('heading', { name: 'Zone B' }).closest('section');
    expect(within(zoneA).getByText('0 members')).toBeInTheDocument();
    expect(within(zoneA).getByText('No members in Zone A yet.')).toBeInTheDocument();
    expect(within(zoneB).getByText('No members in Zone B yet.')).toBeInTheDocument();
  });
});

describe('Revival Centers: create form lives behind the Add center button', () => {
  it('hides the create form behind the Add center button until asked for', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');

    // The page leads with the list; adding a center is a deliberate act, not a
    // permanent fixture claiming the top of the screen.
    expect(screen.queryByLabelText('New center name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add center/i }));
    const name = screen.getByLabelText('New center name');
    expect(screen.getByRole('button', { name: /create center/i })).toBeInTheDocument();

    // A second click of the header button restarts the form empty, never leaves
    // a half-typed name waiting to be submitted by surprise.
    await user.type(name, 'Half');
    await user.click(screen.getByRole('button', { name: /add center/i }));
    expect(screen.getByLabelText('New center name')).toHaveValue('');
  });

  it('creates through the form, and the form is the submitter, not the header button', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: {} });
    renderPage();
    await screen.findByText('Kimara Revival Center');

    await user.click(screen.getByRole('button', { name: /add center/i }));
    await user.type(screen.getByLabelText('New center name'), 'Kimara Revival Center East');
    // The header button and the form's own submit are different actions: the
    // form's must be the one that fires, or a click could just reset the form.
    await user.click(screen.getByRole('button', { name: /create center/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/revival-centers', { name: 'Kimara Revival Center East' }));
    expect(await screen.findByText('Revival center added.')).toBeInTheDocument();
    // A successful create puts the form away, leaving the list and the banner.
    await waitFor(() => expect(screen.queryByLabelText('New center name')).not.toBeInTheDocument());
  });

  it('puts the create form away on cancel without writing anything', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Kimara Revival Center');

    await user.click(screen.getByRole('button', { name: /add center/i }));
    await user.type(screen.getByLabelText('New center name'), 'Kimara Revival Center East');
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByLabelText('New center name')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('offers no Add center button or form to a receptionist', async () => {
    auth.role = 'receptionist';
    renderPage();
    await screen.findByText('Kimara Revival Center');

    expect(screen.queryByRole('button', { name: /add center/i })).toBeNull();
    expect(screen.queryByLabelText('New center name')).toBeNull();
  });
});
