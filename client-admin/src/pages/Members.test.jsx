import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Members from './Members';
import api from '../api';
import i18n from '../i18n';

vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

// The profile panel is a separate screen's worth of queries and is only rendered
// when a row is expanded, which these rules never do.
vi.mock('../components/MemberProfile', () => ({ default: () => <div /> }));

// The role decides which row controls exist, the front desk edits members but
// never deletes or deactivates one, so it is mutable rather than fixed.
const auth = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: auth.role } }),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

// One group per kind, plus a disabled one: a member already in a disabled group
// must keep it on screen or re-saving their details would silently drop them.
// has_logo mirrors the real payload; the logoless groups must not fire fetches.
const GROUPS = [
  { id: 1, name: 'Harvest Choir', kind: 'choir', is_active: 1, member_count: 2, has_logo: true },
  { id: 3, name: 'Watoto', kind: 'small_group', is_active: 1, member_count: 4, has_logo: false },
  { id: 9, name: 'Old Fellowship', kind: 'fellowship', is_active: 0, member_count: 0, has_logo: false },
];

const MEMBERS = [
  { id: 5, member_no: 'VRT-0005', name: 'Neema K', phone: '+255700000005', email: '', is_active: 1, center_name: null, zone_name: null, group_names: 'Harvest Choir', group_count: 1, member_groups: [{ id: 1, name: 'Harvest Choir', has_logo: true }] },
  { id: 6, member_no: 'VRT-0006', name: 'Baraka J', phone: '', email: '', is_active: 1, center_name: null, zone_name: null, group_names: null, group_count: 0, member_groups: [] },
];

beforeEach(() => {
  auth.role = 'admin';
  api.get.mockImplementation((url) => {
    if (url === '/groups') return Promise.resolve({ data: { groups: GROUPS } });
    if (url === '/revival-centers') return Promise.resolve({ data: { revivalCenters: [] } });
    if (url === '/groups/1/logo') return Promise.resolve({ data: new Blob(['png'], { type: 'image/png' }) });
    if (url === '/members/5') {
      return Promise.resolve({
        data: {
          member: MEMBERS[0],
          // Neema is in Harvest Choir and in a group that has since been disabled.
          groups: [
            { id: 1, name: 'Harvest Choir', role: 'member' },
            { id: 9, name: 'Old Fellowship', role: 'member' },
          ],
        },
      });
    }
    if (url === '/members') return Promise.resolve({ data: { members: MEMBERS } });
    return Promise.resolve({ data: {} });
  });
  // Reset first: a `...Once` value queued by a test that failed before consuming
  // it would otherwise be handed to the next test and mask a real regression.
  api.post.mockReset();
  api.delete.mockReset();
  api.post.mockResolvedValue({ data: { member: { id: 7, name: 'Neema K' } } });
  api.patch.mockImplementation((url, body) =>
    Promise.resolve({ data: { member: { ...MEMBERS[0], ...(body || {}) } } })
  );
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

async function renderLoaded() {
  render(
    <MemoryRouter>
      <Members />
    </MemoryRouter>
  );
  await screen.findByText('Neema K');
}

const chip = (name) => screen.getByRole('button', { name: new RegExp(`^${name}`) });

// Edit and Delete live in each row's ⋮ menu, the same pattern as the Groups
// rows, so these helpers open the menu of the first row and return the item.
// (Rows render in payload order; every caller here means "the first row".)
async function openRowMenu(user) {
  await user.click(screen.getAllByRole('button', { name: 'More actions' })[0]);
}
const editItems = () => screen.getAllByRole('menuitem', { name: /^edit$/i });
const deleteItems = () => screen.getAllByRole('menuitem', { name: /^delete$/i });
// …and the version that answers "none" instead of throwing when there is none.
const deleteItemsOrNone = () => screen.queryAllByRole('menuitem', { name: /^delete$/i });

describe('Members: groups are assigned where the member is registered', () => {
  // Interaction-heavy (a typed name plus four chip clicks) and run against real
  // timers: under the full suite's parallel workers the default 5s budget is
  // not about the code under test, so this test carries its own.
  it('sends the chosen groups with the new member', { timeout: 15000 }, async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add member/i }));
    await user.type(screen.getByLabelText('Full name'), 'Neema K');

    // Nothing selected yet: both are unpressed.
    expect(chip('Harvest Choir')).toHaveAttribute('aria-pressed', 'false');

    await user.click(chip('Harvest Choir'));
    await user.click(chip('Watoto'));
    expect(chip('Harvest Choir')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Watoto')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /save member/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/members',
        expect.objectContaining({ name: 'Neema K', groupIds: [1, 3], isActive: true })
      )
    );
  });

  it('deselects a group that was clicked twice, so "none" is expressible', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add member/i }));
    await user.type(screen.getByLabelText('Full name'), 'Neema K');
    await user.click(chip('Harvest Choir'));
    await user.click(chip('Harvest Choir'));

    await user.click(screen.getByRole('button', { name: /save member/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/members', expect.objectContaining({ groupIds: [] })));
  });

  it('shows a disabled group the member is already in, so a save cannot drop it', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openRowMenu(user);
    await user.click(editItems()[0]);

    // Loaded from the member's own record, not assumed.
    await waitFor(() => expect(chip('Harvest Choir')).toHaveAttribute('aria-pressed', 'true'));
    expect(chip('Old Fellowship')).toHaveAttribute('aria-pressed', 'true');

    // And untouched groups nobody belongs to stay hidden: the disabled one is
    // visible only because this member is in it.
    expect(screen.queryByRole('button', { name: /^Old/ })).not.toBeNull();
  });

  it('sends the same groups back when the member is edited', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openRowMenu(user);
    await user.click(editItems()[0]);
    await waitFor(() => expect(chip('Harvest Choir')).toHaveAttribute('aria-pressed', 'true'));

    await user.click(screen.getByRole('button', { name: /save member/i }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/members/5', expect.objectContaining({ groupIds: [1, 9] }))
    );
  });

  it('never lets the activate/deactivate toggle touch the roster', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getAllByRole('button', { name: /^deactivate$/i })[0]);

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [, body] = api.patch.mock.calls[0];
    // The server only reconciles groups when the field is present, so its
    // absence here is what keeps a one-click toggle from emptying a roster.
    expect(body).toEqual({ isActive: false });
    expect('groupIds' in body).toBe(false);
  });

  it('shows which groups a member is in on their row', async () => {
    await renderLoaded();

    const row = screen.getByText('Neema K').closest('li');
    expect(row.textContent).toContain('Harvest Choir');
  });
});

// Entering assign mode is what makes the selection UI exist at all, so every
// bulk test starts here rather than assuming a checkbox column.
async function enterAssignMode(user) {
  await user.click(screen.getByRole('button', { name: /^assign to group$/i }));
}

describe('Members: the list is read-only until assigning is asked for', () => {
  it('shows no checkboxes or group bar on a plain visit', async () => {
    await renderLoaded();

    expect(screen.queryByLabelText('Select Neema K')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Select all')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add to group/i })).not.toBeInTheDocument();
    // The per-row actions that a read-only row does offer are still there,
    // inside its ⋮ menu (one menu per row: Neema's and Baraka's).
    expect(screen.getAllByRole('button', { name: 'More actions' }).length).toBe(2);
    await openRowMenu(userEvent.setup());
    expect(editItems().length).toBe(1);
    expect(deleteItems().length).toBe(1);
  });

  it('reveals the selection UI only once assign mode is entered, and drops it again', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await enterAssignMode(user);
    expect(screen.getByLabelText('Select Neema K')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Select Neema K'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    // Leaving the mode takes the tick with it: a selection can never survive
    // into a state where its checkbox is gone but its effect is not.
    await user.click(screen.getByRole('button', { name: /finish assigning/i }));
    expect(screen.queryByLabelText('Select Neema K')).not.toBeInTheDocument();
  });
});

describe('Members: filling a group from the directory in one go', () => {
  it('adds every ticked member to the chosen group in a single request', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValueOnce({ data: { added: 2 } });
    await renderLoaded();

    await enterAssignMode(user);
    await user.click(screen.getByLabelText('Select Neema K'));
    await user.click(screen.getByLabelText('Select Baraka J'));
    await user.selectOptions(screen.getByLabelText('Group to add them to'), '1');
    await user.click(screen.getByRole('button', { name: /add to group/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/groups/1/members', { memberIds: [5, 6] })
    );
  });

  it('offers no group action until at least one member is ticked', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await enterAssignMode(user);

    // The action exists but is inert, and says what to do.
    expect(screen.getByRole('button', { name: /add to group/i })).toBeDisabled();
    expect(screen.getByText(/tick the people to add/i)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Select Neema K'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    // Still inert: a group must be chosen as well as a person.
    expect(screen.getByRole('button', { name: /add to group/i })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Group to add them to'), '1');
    expect(screen.getByRole('button', { name: /add to group/i })).toBeEnabled();
  });

  it('select-all ticks every listed member, and unticks them again', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await enterAssignMode(user);
    await user.click(screen.getByLabelText('Select all'));
    expect(screen.getByLabelText('Select Neema K')).toBeChecked();
    expect(screen.getByLabelText('Select Baraka J')).toBeChecked();
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Select all'));
    expect(screen.getByLabelText('Select Neema K')).not.toBeChecked();
  });

  it('reports when everyone ticked was already in the group', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValueOnce({ data: { added: 0 } });
    await renderLoaded();

    await enterAssignMode(user);
    await user.click(screen.getByLabelText('Select Neema K'));
    await user.selectOptions(screen.getByLabelText('Group to add them to'), '1');
    await user.click(screen.getByRole('button', { name: /add to group/i }));

    expect(await screen.findByText(/already in Harvest Choir/i)).toBeInTheDocument();
  });

  it("fetches a revival center's own members so a whole center can join at once", async () => {
    const user = userEvent.setup();
    const base = api.get.getMockImplementation();
    const centerMembers = [
      { id: 21, member_no: 'VRT-0021', name: 'Zawadi N', phone: '', email: '', is_active: 1, center_name: 'Mbezi', zone_name: null, group_names: null, group_count: 0 },
      { id: 22, member_no: 'VRT-0022', name: 'Faraja S', phone: '', email: '', is_active: 1, center_name: 'Mbezi', zone_name: null, group_names: null, group_count: 0 },
    ];
    api.get.mockImplementation((url, config) => {
      if (url === '/revival-centers') return Promise.resolve({ data: { revivalCenters: [{ id: 7, name: 'Mbezi', zones: [] }] } });
      if (url === '/members' && String(config?.params?.centerId) === '7') return Promise.resolve({ data: { members: centerMembers } });
      return base(url, config);
    });
    api.post.mockResolvedValueOnce({ data: { added: 2 } });

    await renderLoaded();
    await enterAssignMode(user);

    // Picking a center pulls its roster in and ticks it: no one is re-typed.
    await user.selectOptions(screen.getByLabelText('Fill from a revival center…'), '7');
    await screen.findByText('Zawadi N');
    expect(screen.getByLabelText('Select Zawadi N')).toBeChecked();
    expect(screen.getByLabelText('Select Faraja S')).toBeChecked();
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Group to add them to'), '1');
    await user.click(screen.getByRole('button', { name: /add to group/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/groups/1/members', { memberIds: [21, 22] })
    );
  });
});

// A native confirm is one Enter keypress, which is not a guard on a screen where
// Delete sits two rows below the cursor, so window.confirm must not be reached
// at all any more. Spying it to throw fails the test loudly if it comes back.
function forbidNativeConfirm() {
  return vi.spyOn(window, 'confirm').mockImplementation(() => {
    throw new Error('window.confirm must not be used: destructive deletes go through the typed dialog');
  });
}

const nameField = (name) => screen.getByLabelText(`Type ${name} to confirm`);

async function typeAndConfirm(user, name) {
  await user.type(nameField(name), name);
  await user.click(screen.getByRole('button', { name: 'Delete' }));
}

describe('Members: deleting one, and history that must survive it', () => {
  it('asks for the name to be retyped, then reports which rung of the ladder ran', async () => {
    const user = userEvent.setup();
    const confirm = forbidNativeConfirm();
    api.delete.mockResolvedValueOnce({ data: { success: true, deactivated: true } });
    await renderLoaded();

    await openRowMenu(user);
    await user.click(deleteItems()[0]);

    // The dialog names the row, and the name is the only thing that opens the
    // gate: no Enter, no stray click.
    expect(screen.getByRole('dialog')).toHaveTextContent('Delete Neema K?');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();

    await typeAndConfirm(user, 'Neema K');

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/members/5'));
    // The server deactivates a member with history; saying "deleted" here would
    // be a lie the front desk would act on.
    expect(await screen.findByText(/deactivated instead of deleted/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    confirm.mockRestore();
  });

  it('says a member was deleted when there was no history to preserve', async () => {
    const user = userEvent.setup();
    const confirm = forbidNativeConfirm();
    api.delete.mockResolvedValueOnce({ data: { success: true, deleted: true } });
    await renderLoaded();

    await openRowMenu(user);
    await user.click(deleteItems()[0]);
    await typeAndConfirm(user, 'Neema K');

    expect(await screen.findByText(/was deleted/i)).toBeInTheDocument();
    confirm.mockRestore();
  });

  it('sends nothing while the typed name does not match, and nothing at all on cancel', async () => {
    const user = userEvent.setup();
    const confirm = forbidNativeConfirm();
    await renderLoaded();

    await openRowMenu(user);
    await user.click(deleteItems()[0]);

    // A different member's name is not a confirmation.
    await user.type(nameField('Neema K'), 'Baraka J');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(api.delete).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    confirm.mockRestore();
  });

  it('closes the row menu when the dialog takes over, so only one is on screen', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openRowMenu(user);
    await user.click(deleteItems()[0]);

    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('Members: a shared name is a question, not a wall', () => {
  it('asks instead of failing when the name already exists, and registers on confirmation', async () => {
    const user = userEvent.setup();
    api.post
      .mockRejectedValueOnce({
        response: {
          data: {
            error: 'A member named Neema K already exists. Is this the same person?',
            code: 'duplicate_name',
            duplicates: [{ id: 5, name: 'Neema K', memberNo: 'VRT-0005' }],
          },
        },
      })
      .mockResolvedValueOnce({ data: { member: { id: 8, name: 'Neema K' } } });
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add member/i }));
    await user.type(screen.getByLabelText('Full name'), 'Neema K');
    await user.click(screen.getByRole('button', { name: /save member/i }));

    // The question, with the record it is about, and NOT an error banner.
    expect(await screen.findByText(/Possible duplicate/i)).toBeInTheDocument();
    // The existing record is named, so the front desk can go and look it up.
    expect(screen.getAllByText(/VRT-0005/).length).toBeGreaterThan(0);
    expect(api.post).toHaveBeenLastCalledWith('/members', expect.not.objectContaining({ confirmNameDuplicate: true }));

    await user.click(screen.getByRole('button', { name: /register as a different person/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenLastCalledWith(
        '/members',
        expect.objectContaining({ name: 'Neema K', confirmNameDuplicate: true })
      )
    );
  });

  it('blocks a duplicate email outright without any confirmation path', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValueOnce({
      response: { data: { error: 'A member with this email already exists (Neema K, VRT-0005).', code: 'duplicate_email' } },
    });
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add member/i }));
    await user.type(screen.getByLabelText('Full name'), 'Neema K');
    await user.type(screen.getByLabelText('Email address'), 'neema@example.com');
    await user.click(screen.getByRole('button', { name: /save member/i }));

    expect(await screen.findByText(/email already exists/i)).toBeInTheDocument();
    expect(screen.queryByText(/Possible duplicate/i)).not.toBeInTheDocument();
  });
});

// A leadership office is held in a zone, and the API refuses to move its holder
// out of it. So the form must not offer a zone that can only fail on save: the
// options are judged against the member's offices, and a locked one says why.
describe('Members: the zone a member leads is the only one they can move to', () => {
  const FILED_IN_HELD_ZONE = { ...MEMBERS[0], revival_center_id: 7, zone_id: 11 };
  const FILED_ELSEWHERE = { ...MEMBERS[0], revival_center_id: 7, zone_id: 12 };
  const CENTERS = [
    {
      id: 7,
      name: 'Mbezi',
      member_count: 2,
      zones: [
        { id: 11, name: 'Zone A', leaders: [{ member_id: 5, name: 'Neema K', role_name: 'Deacon' }] },
        { id: 12, name: 'Zone B', leaders: [] },
      ],
    },
    { id: 8, name: 'Kigamboni', member_count: 0, zones: [{ id: 21, name: 'Zone A', leaders: [] }] },
  ];

  function mockMember(member) {
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) => {
      if (url === '/revival-centers') return Promise.resolve({ data: { revivalCenters: CENTERS } });
      if (url === '/members/5') return Promise.resolve({ data: { member, groups: [] } });
      if (url === '/members') return Promise.resolve({ data: { members: [member, MEMBERS[1]] } });
      return base(url, config);
    });
  }

  async function openEditForm(user, member = FILED_IN_HELD_ZONE) {
    mockMember(member);
    await renderLoaded();
    await openRowMenu(user);
    await user.click(editItems()[0]);
    return screen.getByLabelText('Zone');
  }

  it('disables the zones the member cannot move to, and names the office in the way', async () => {
    const user = userEvent.setup();
    const zone = await openEditForm(user);

    expect(zone).toHaveValue('11');
    // Where she is filed stays pickable, and so does the zone she leads.
    expect(within(zone).getByRole('option', { name: /^Zone A/ })).toBeEnabled();
    const blocked = within(zone).getByRole('option', { name: /^Zone B/ });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveTextContent(/not available: this member leads Zone A/);
    // Unfiling her would leave the office behind, so "None" is out as well.
    expect(within(zone).getByRole('option', { name: /^None/ })).toBeDisabled();
  });

  it('explains the lock once, under the picker, and says where to undo it', async () => {
    const user = userEvent.setup();
    await openEditForm(user);

    expect(screen.getByText(/leads Zone A at Mbezi/i)).toBeInTheDocument();
    expect(screen.getByText(/Centers screen/i)).toBeInTheDocument();
  });

  it('locks the other centers too, since landing in one would strand the office', async () => {
    const user = userEvent.setup();
    await openEditForm(user);

    const center = screen.getByLabelText('Revival center');
    expect(within(center).getByRole('option', { name: 'Mbezi' })).toBeEnabled();
    const other = within(center).getByRole('option', { name: /^Kigamboni/ });
    expect(other).toBeDisabled();
    expect(other).toHaveTextContent(/leads Zone A/);
    expect(within(center).getByRole('option', { name: /^None/ })).toBeDisabled();
  });

  it('keeps the zone when the same center is re-picked, so a save cannot unfile her', async () => {
    const user = userEvent.setup();
    await openEditForm(user);

    // Re-picking the center she is already in is not a move.
    await user.selectOptions(screen.getByLabelText('Revival center'), '7');
    expect(screen.getByLabelText('Zone')).toHaveValue('11');

    await user.click(screen.getByRole('button', { name: /save member/i }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/members/5', expect.objectContaining({ zoneId: 11 }))
    );
  });

  it('still allows moving her INTO the zone she leads, which is how a mismatched row is fixed', async () => {
    const user = userEvent.setup();
    const zone = await openEditForm(user, FILED_ELSEWHERE);

    expect(zone).toHaveValue('12');
    // Filed in Zone B, leading Zone A: Zone A is the one place she may go.
    expect(within(zone).getByRole('option', { name: /^Zone A/ })).toBeEnabled();
    expect(within(zone).getByRole('option', { name: /^Zone B/ })).toBeEnabled();

    await user.selectOptions(zone, '11');
    await user.click(screen.getByRole('button', { name: /save member/i }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/members/5', expect.objectContaining({ zoneId: 11 }))
    );
  });

  it('offers every zone plainly to a member who leads nothing', async () => {
    const user = userEvent.setup();
    mockMember(MEMBERS[0]);
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add member/i }));
    await user.selectOptions(screen.getByLabelText('Revival center'), '7');

    const zone = screen.getByLabelText('Zone');
    expect(within(zone).getByRole('option', { name: 'Zone B' })).toBeEnabled();
    expect(within(zone).getByRole('option', { name: /^None/ })).toBeEnabled();
    expect(screen.queryByText(/not available/)).not.toBeInTheDocument();
  });
});

describe('Members: group logos ride with the pickers', () => {
  it('each assignable chip carries the group\'s own logo, fetched only when it has one', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/groups') return Promise.resolve({ data: { groups: GROUPS } });
      if (url === '/revival-centers') return Promise.resolve({ data: { revivalCenters: [] } });
      if (url === '/members') return Promise.resolve({ data: { members: MEMBERS } });
      if (url === '/members/5') return Promise.resolve({ data: { member: MEMBERS[0], groups: [] } });
      if (url === '/groups/1/logo') return Promise.resolve({ data: new Blob(['png'], { type: 'image/png' }) });
      return Promise.resolve({ data: {} });
    });
    await renderLoaded();

    await screen.findByRole('button', { name: /add member/i });
    await userEvent.setup().click(screen.getByRole('button', { name: /add member/i }));

    // The logoed group's chip holds an image; the logoless one must not fetch.
    const chipRow = screen.getByRole('button', { name: /Harvest Choir/ });
    await waitFor(() => expect(chipRow.querySelector('img')).toBeTruthy());
    expect(api.get).toHaveBeenCalledWith('/groups/1/logo', expect.objectContaining({ responseType: 'blob' }));
    expect(api.get).not.toHaveBeenCalledWith('/groups/3/logo', expect.anything());
  });

  it('a member row shows one chip per group with its logo, not the joined string', async () => {
    await renderLoaded();

    const row = screen.getByText('Neema K').closest('li');
    const chipEl = within(row).getByText('Harvest Choir').closest('span');
    expect(chipEl).toHaveClass('cat-chip');
    await waitFor(() => expect(chipEl.querySelector('img')).toBeTruthy());
    // Baraka is in no group: no chips at all, and no fallback string.
    const otherRow = screen.getByText('Baraka J').closest('li');
    expect(within(otherRow).queryByText('Harvest Choir')).toBeNull();
  });

  it("the list filter shows the selected group's logo beside the select", async () => {
    api.get.mockImplementation((url) => {
      if (url === '/groups') return Promise.resolve({ data: { groups: GROUPS } });
      if (url === '/revival-centers') return Promise.resolve({ data: { revivalCenters: [] } });
      if (url === '/members') return Promise.resolve({ data: { members: MEMBERS } });
      if (url === '/members/5') return Promise.resolve({ data: { member: MEMBERS[0], groups: [] } });
      if (url === '/groups/1/logo') return Promise.resolve({ data: new Blob(['png'], { type: 'image/png' }) });
      return Promise.resolve({ data: {} });
    });
    await renderLoaded();

    // Group filtering now lives in the header's Filter panel, which is a
    // popover: it has to be opened before its fields exist.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Filter members' }));
    const filter = screen.getByLabelText('Filter by group');
    await userEvent.setup().selectOptions(filter, '1');

    // Scoped to the filter's own wrapper: a member row's chip can carry the
    // same logo, and an unscoped query would find that one too.
    const wrapper = filter.closest('div');
    await waitFor(() => expect(within(wrapper).getByAltText('Harvest Choir logo')).toBeTruthy());
    // Changing back to All clears it.
    await userEvent.setup().selectOptions(filter, '');
    await waitFor(() => expect(within(wrapper).queryByAltText('Harvest Choir logo')).not.toBeInTheDocument());
  });
});

describe('Members: the header row', () => {
  const CENTERS = [
    { id: 7, name: 'Mbezi', zones: [{ id: 11, name: 'Zone A', leaders: [] }] },
  ];

  function mockList(listData) {
    api.get.mockImplementation((url) => {
      if (url === '/groups') return Promise.resolve({ data: { groups: GROUPS } });
      if (url === '/revival-centers') return Promise.resolve({ data: { revivalCenters: CENTERS } });
      if (url === '/members') return Promise.resolve({ data: listData });
      if (url === '/groups/1/logo') return Promise.resolve({ data: new Blob(['png'], { type: 'image/png' }) });
      return Promise.resolve({ data: {} });
    });
  }

  it('shows the server count, which is the directory rather than the rows on screen', async () => {
    // The list is capped by a limit, so counting rendered rows would report the
    // page size instead of the church.
    mockList({ members: MEMBERS, total: 100, grandTotal: 100 });
    await renderLoaded();

    expect(screen.getByRole('heading', { name: 'All Members (100)' })).toBeInTheDocument();
  });

  it('reads "N of M" once search or a filter narrows the list, and returns to one number', async () => {
    const user = userEvent.setup();
    mockList({ members: MEMBERS, total: 100, grandTotal: 100 });
    await renderLoaded();
    expect(screen.getByRole('heading', { name: 'All Members (100)' })).toBeInTheDocument();

    mockList({ members: [MEMBERS[0]], total: 1, grandTotal: 100 });
    await user.type(screen.getByLabelText('Search members'), 'Nee');

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'All Members (1 of 100)' })).toBeInTheDocument()
    );

    mockList({ members: MEMBERS, total: 100, grandTotal: 100 });
    await user.clear(screen.getByLabelText('Search members'));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'All Members (100)' })).toBeInTheDocument()
    );
  });

  it('asks the server for the order the admin picks, and says which order is showing', async () => {
    const user = userEvent.setup();
    mockList({ members: MEMBERS, total: 2, grandTotal: 2 });
    await renderLoaded();

    // The button reads as the current order, so the state is legible shut.
    const sortButton = screen.getByRole('button', { name: 'Sort members' });
    expect(sortButton).toHaveTextContent('Recently Added');

    await user.click(sortButton);
    await user.click(screen.getByRole('menuitem', { name: 'Name A–Z' }));

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        '/members',
        expect.objectContaining({ params: expect.objectContaining({ sort: 'name' }) })
      )
    );
    expect(screen.getByRole('button', { name: 'Sort members' })).toHaveTextContent('Name A–Z');
  });

  it('sends a search term and a filter together instead of one replacing the other', async () => {
    const user = userEvent.setup();
    mockList({ members: MEMBERS, total: 2, grandTotal: 2 });
    await renderLoaded();

    await user.type(screen.getByLabelText('Search members'), 'Nee');
    await user.click(screen.getByRole('button', { name: 'Filter members' }));
    await user.selectOptions(screen.getByLabelText('Revival center'), '7');

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        '/members',
        expect.objectContaining({
          params: expect.objectContaining({ search: 'Nee', centerId: '7' }),
        })
      )
    );
    // The filter's own state is on the button, so an active filter is visible
    // without opening the panel.
    expect(screen.getByRole('button', { name: 'Filter members' })).toHaveTextContent('1');
  });

  it('clears every filter at once, and keeps the primary action the only one', async () => {
    const user = userEvent.setup();
    mockList({ members: MEMBERS, total: 2, grandTotal: 2 });
    await renderLoaded();

    // Add Member is the row's single primary action: the brand colour already
    // used for primary buttons elsewhere, not a one-off pink.
    expect(screen.getByRole('button', { name: /add member/i })).toHaveClass('btn-primary');
    expect(screen.getByRole('button', { name: 'Sort members' })).toHaveClass('btn-secondary');
    expect(screen.getByRole('button', { name: 'Filter members' })).toHaveClass('btn-secondary');

    await user.click(screen.getByRole('button', { name: 'Filter members' }));
    await user.selectOptions(screen.getByLabelText('Revival center'), '7');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        '/members',
        expect.objectContaining({ params: expect.objectContaining({ centerId: undefined }) })
      )
    );
    expect(screen.getByRole('button', { name: 'Filter members' })).not.toHaveTextContent('1');
  });

  it('opens Add member, so the header is the only way in and it works', async () => {
    const user = userEvent.setup();
    mockList({ members: MEMBERS, total: 2, grandTotal: 2 });
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add member/i }));
    expect(screen.getByRole('heading', { name: 'New member' })).toBeInTheDocument();
  });

  it('survives a server that reports no counts, falling back to what it returned', async () => {
    // Older payloads (and the test mocks above) carry no totals; the header must
    // still read sensibly rather than showing "undefined".
    mockList({ members: MEMBERS });
    await renderLoaded();

    expect(screen.getByRole('heading', { name: 'All Members (2)' })).toBeInTheDocument();
  });

  it('refreshes the count after a member is added, so the header cannot go stale', async () => {
    const user = userEvent.setup();
    mockList({ members: MEMBERS, total: 7, grandTotal: 7 });
    api.post.mockResolvedValueOnce({ data: { member: { id: 9, name: 'Amani T' } } });
    await renderLoaded();
    expect(screen.getByRole('heading', { name: 'All Members (7)' })).toBeInTheDocument();

    // The directory grew by one while the form was open.
    mockList({ members: [...MEMBERS, { ...MEMBERS[1], id: 9, name: 'Amani T' }], total: 8, grandTotal: 8 });
    await user.click(screen.getByRole('button', { name: /add member/i }));
    await user.type(screen.getByLabelText('Full name'), 'Amani T');
    await user.click(screen.getByRole('button', { name: /^save/i }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'All Members (8)' })).toBeInTheDocument()
    );
  });

  it('refreshes the count after a delete, and keeps the order and filters that were on', async () => {
    const user = userEvent.setup();
    const confirm = forbidNativeConfirm();
    mockList({ members: MEMBERS, total: 7, grandTotal: 7 });
    api.delete.mockResolvedValueOnce({ data: { success: true, deleted: true } });
    await renderLoaded();

    // Name order, so the refetch has something to preserve: the hand-rolled
    // refetch this replaced dropped both the order and the filters.
    await user.click(screen.getByRole('button', { name: 'Sort members' }));
    await user.click(screen.getByRole('menuitem', { name: 'Name A–Z' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/members', expect.objectContaining({ params: expect.objectContaining({ sort: 'name' }) })));

    mockList({ members: [MEMBERS[1]], total: 6, grandTotal: 6 });
    await openRowMenu(user);
    await user.click(deleteItems()[0]);
    await typeAndConfirm(user, 'Neema K');

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'All Members (6)' })).toBeInTheDocument()
    );
    // Still sorted by name, not silently back to most-recent-by-default.
    expect(api.get).toHaveBeenCalledWith('/members', expect.objectContaining({ params: expect.objectContaining({ sort: 'name' }) }));
    confirm.mockRestore();
  });

  it('closes the sort and filter panels when the pointer lands elsewhere', async () => {
    const user = userEvent.setup();
    mockList({ members: MEMBERS, total: 2, grandTotal: 2 });
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: 'Sort members' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();

    // Only one panel at a time: opening Filter folds Sort away.
    await user.click(screen.getByRole('button', { name: 'Sort members' }));
    await user.click(screen.getByRole('button', { name: 'Filter members' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByLabelText('Revival center')).toBeInTheDocument();
  });
});

/*
 * The front desk registers members, so it uses this screen, but deleting a
 * member and deactivating one are an administrator's decisions. The API refuses
 * both for a receptionist, so the page must not offer them: a control that can
 * only come back 403 teaches a user that the screen is broken.
 */
describe('Members: what the front desk may do with a member', () => {
  it('offers the row’s full set of actions to an administrator', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    expect(screen.getAllByRole('button', { name: /^deactivate$/i })).toHaveLength(MEMBERS.length);
    await openRowMenu(user);
    expect(deleteItems()).toHaveLength(1);
  });

  it('leaves deleting and deactivating to an administrator', async () => {
    auth.role = 'receptionist';
    const user = userEvent.setup();
    await renderLoaded();

    // Registering a member and correcting their details is the front desk's
    // work, so Edit stays…
    await openRowMenu(user);
    expect(editItems()).toHaveLength(1);
    // …while the two the API would refuse are not offered at all, in any row.
    expect(deleteItemsOrNone()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^(de|)activate$/i })).toBeNull();
  });

  it('never sends isActive when the front desk edits a member', async () => {
    auth.role = 'receptionist';
    const user = userEvent.setup();
    await renderLoaded();

    // The server rejects a status change from a receptionist outright, and the
    // edit form has no status field, so the request must carry no isActive at
    // all rather than a false one that would read as "deactivate".
    await openRowMenu(user);
    await user.click(editItems()[0]);
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/members/5', expect.any(Object)));
    const [, body] = api.patch.mock.calls[0];
    expect(body).not.toHaveProperty('isActive');
  });
});
