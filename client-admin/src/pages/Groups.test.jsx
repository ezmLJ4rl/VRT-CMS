import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Groups from './Groups';
import api from '../api';
import i18n from '../i18n';

// The shell brings in the auth context and the language switcher: neither is
// touched by the rules under test. Only the HTTP client is faked. Rows link into
// per-group pages, so the page is rendered inside a router.
vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

// One group of every kind the schema defines, so a badge that ignored `kind` and
// printed one label for everything would be caught rather than tolerated.
// has_logo mirrors the real payload (the logo bytes themselves never ride along).
const GROUPS = [
  {
    id: 1,
    name: "Men's Choir",
    kind: 'choir',
    description: 'Sings at the first service',
    is_active: 1,
    member_count: 2,
    sort_order: 0,
    has_logo: true,
  },
  {
    id: 2,
    name: 'Youth Fellowship',
    kind: 'fellowship',
    description: '',
    is_active: 0,
    member_count: 1,
    sort_order: 1,
    has_logo: false,
  },
  { id: 3, name: 'Worship Team', kind: 'worship_team', description: '', is_active: 1, member_count: 0, sort_order: 2, has_logo: false },
  { id: 4, name: 'Wednesday Home Group', kind: 'small_group', description: '', is_active: 1, member_count: 4, sort_order: 3, has_logo: false },
];

const rowFor = (name) => screen.getByRole('link', { name }).closest('li');
const nameField = (name) => within(rowFor(name)).getByRole('textbox', { name: 'Group name' });
// Edit lives inside the row's ⋮ menu, so the helper opens the menu first and
// returns the menu item. (It must be awaited by callers now.)
const menuButton = (name) => within(rowFor(name)).getByRole('button', { name: 'More actions' });
const editButton = (name) => within(rowFor(name)).getByRole('menuitem', { name: 'Edit' });
const saveButton = (name) => within(rowFor(name)).getByRole('button', { name: /save changes/i });

async function renderLoaded() {
  render(
    <MemoryRouter>
      <Groups />
    </MemoryRouter>
  );
  await screen.findByRole('link', { name: "Men's Choir" });
}

async function openEditor(user, name) {
  await user.click(menuButton(name));
  await user.click(editButton(name));
  await screen.findByRole('textbox', { name: 'Group name' });
}

beforeEach(() => {
  api.get.mockImplementation((url) => {
    if (url === '/groups') return Promise.resolve({ data: { groups: GROUPS } });
    return Promise.resolve({ data: {} });
  });
  api.patch.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: { added: 1, memberCount: 2 } });
  api.delete.mockResolvedValue({ data: { success: true } });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Groups: the type badge reads the group\'s own kind', () => {
  it('labels each group from its stored kind, with four distinct labels', async () => {
    await renderLoaded();

    const expected = [
      ["Men's Choir", 'Choir'],
      ['Youth Fellowship', 'Fellowship'],
      ['Worship Team', 'Worship team'],
      ['Wednesday Home Group', 'Small group'],
    ];
    for (const [name, label] of expected) {
      expect(within(rowFor(name)).getByText(label)).toBeInTheDocument();
    }
    // Four different kinds, four different labels: a single hardcoded or
    // defaulted label could not satisfy this.
    const labels = expected.map(([, l]) => l);
    expect(new Set(labels).size).toBe(4);
  });

  it('reads the count the member records produce, and pluralises it', async () => {
    await renderLoaded();

    expect(within(rowFor("Men's Choir")).getByText('2 members')).toBeInTheDocument();
    expect(within(rowFor('Youth Fellowship')).getByText('1 member')).toBeInTheDocument();
    expect(within(rowFor('Worship Team')).getByText('0 members')).toBeInTheDocument();
  });

  it('reads its metadata through the one neutral badge style', async () => {
    await renderLoaded();

    const row = rowFor("Men's Choir");
    for (const badge of [within(row).getByText('Choir'), within(row).getByText('2 members')]) {
      expect(badge).toHaveClass('cat-chip', 'category-ink');
      // Never the offerings/money colour or a brand fill.
      expect(badge.className).not.toMatch(/offering|brand/);
    }
    // The disabled state is an amber status chip.
    expect(within(rowFor('Youth Fellowship')).getByText('Disabled')).toHaveClass('cat-chip', 'category-amber');
  });
});

describe('Groups: membership is read from the member, not edited here', () => {
  it('links every row into the group that lists its members', async () => {
    await renderLoaded();

    for (const g of GROUPS) {
      expect(within(rowFor(g.name)).getByRole('link', { name: 'Members' })).toHaveAttribute(
        'href',
        `/groups/${g.id}`
      );
    }
  });

  it('offers no membership control anywhere, closed or open', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    expect(screen.queryByRole('button', { name: /remove member/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/search members/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /add members/i })).toBeNull();

    await openEditor(user, "Men's Choir");

    expect(screen.queryByRole('button', { name: /remove member/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/search members/i)).toBeNull();
    expect(screen.queryByRole('combobox', { name: /role for/i })).toBeNull();
  });

  it('writes nothing but the group itself when saving', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");
    await user.type(nameField("Men's Choir"), ' (Men)');
    await user.click(saveButton("Men's Choir"));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/groups/1', {
        name: "Men's Choir (Men)",
        kind: 'choir',
        description: 'Sings at the first service',
        isActive: true,
      })
    );
    // The old page pushed a membership diff after this call; there is no longer
    // any path from here that adds or removes a member.
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('points at the Members screen as the place membership is set', async () => {
    await renderLoaded();

    expect(screen.getByRole('link', { name: 'Assign members' })).toHaveAttribute('href', '/members');
    expect(screen.getAllByText(/set on the member's own record/).length).toBeGreaterThan(0);
  });
});

describe('Groups: one group editable at a time', () => {
  it('opens the editor for the clicked group only', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");

    expect(screen.getAllByRole('textbox', { name: 'Group name' })).toHaveLength(1);
    expect(nameField("Men's Choir")).toHaveValue("Men's Choir");
    expect(within(rowFor('Youth Fellowship')).queryAllByRole('textbox')).toHaveLength(0);
  });

  it('keeps exactly one editor open when the admin moves between groups', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");
    await user.click(within(rowFor("Men's Choir")).getByRole('button', { name: /cancel/i }));
    await openEditor(user, 'Youth Fellowship');

    expect(screen.getAllByRole('textbox', { name: 'Group name' })).toHaveLength(1);
    expect(nameField('Youth Fellowship')).toHaveValue('Youth Fellowship');
  });

  it('will not open another group while the open one has unsaved changes', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");
    await user.type(nameField("Men's Choir"), ' Two');

    await user.click(menuButton('Youth Fellowship'));
    expect(editButton('Youth Fellowship')).toBeDisabled();
  });
});

describe('Groups: Save is gated on a real change', () => {
  it('opens neutral and disabled, then turns into the one filled action', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");

    const save = saveButton("Men's Choir");
    expect(save).toBeDisabled();
    expect(save).toHaveClass('btn-secondary');
    expect(save).toHaveAttribute('title', 'No changes to save yet.');

    await user.type(nameField("Men's Choir"), ' (Men)');

    expect(saveButton("Men's Choir")).toBeEnabled();
    expect(saveButton("Men's Choir")).toHaveClass('btn-ink');
    // The money colour stays reserved for money.
    expect(saveButton("Men's Choir").className).not.toContain('btn-offering');
  });

  it('counts a changed type as something to save', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");
    expect(saveButton("Men's Choir")).toBeDisabled();

    await user.selectOptions(within(rowFor("Men's Choir")).getByRole('combobox', { name: 'Type' }), 'fellowship');

    expect(saveButton("Men's Choir")).toBeEnabled();
  });

  // Starves under the full parallel run (passes in isolation and in pairs):
  // same treatment as the interaction-heavy Members tests.
  it('goes back to disabled when the edit is undone', { timeout: 15000 }, async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");
    await user.type(nameField("Men's Choir"), 'x');

    await user.clear(nameField("Men's Choir"));
    await user.type(nameField("Men's Choir"), "Men's Choir");

    expect(saveButton("Men's Choir")).toBeDisabled();
    expect(saveButton("Men's Choir")).toHaveClass('btn-secondary');
  });

  it('refuses to save a blank group name', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");
    await user.clear(nameField("Men's Choir"));

    expect(saveButton("Men's Choir")).toBeDisabled();
    expect(saveButton("Men's Choir")).toHaveAttribute('title', 'Give the group a name.');
  });

  it('discards the draft on Cancel, with no writes at all', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");
    await user.type(nameField("Men's Choir"), ' renamed');
    await user.click(within(rowFor("Men's Choir")).getByRole('button', { name: /cancel/i }));

    expect(api.patch).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();

    await openEditor(user, "Men's Choir");
    expect(nameField("Men's Choir")).toHaveValue("Men's Choir");
  });
});

describe('Groups: saving commits the edit', () => {
  it('closes the editor and reloads after a successful save', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, "Men's Choir");
    await user.type(nameField("Men's Choir"), ' (Men)');
    await user.click(saveButton("Men's Choir"));

    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryAllByRole('textbox', { name: 'Group name' })).toHaveLength(0));
    expect(await screen.findByRole('status')).toHaveTextContent('Changes saved.');
  });

  it('hides the create form behind the Add group button until asked for', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    // The page leads with the list; creating is a deliberate act, not a fixture.
    expect(screen.queryByLabelText('New group name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add group/i }));
    const name = screen.getByLabelText('New group name');
    expect(screen.getByLabelText('Type')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create group/i })).toBeInTheDocument();

    // A second click of the header button restarts the form empty, never leaves
    // a half-typed name waiting to be submitted by surprise.
    await user.type(name, 'Half');
    await user.click(screen.getByRole('button', { name: /add group/i }));
    expect(screen.getByLabelText('New group name')).toHaveValue('');
  });

  it('can still be created and deactivated from here', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add group/i }));
    await user.type(screen.getByLabelText('New group name'), 'Harvest Choir');
    await user.selectOptions(screen.getByLabelText('Type'), 'choir');
    // The header button and the form's own submit are different actions: the
    // form's must be the one that fires, or a click could just reset the form.
    await user.click(screen.getByRole('button', { name: /create group/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/groups', { name: 'Harvest Choir', kind: 'choir' }));

    await openEditor(user, 'Worship Team');
    await user.click(within(rowFor('Worship Team')).getByRole('button', { name: /^disable$/i }));
    expect(saveButton('Worship Team')).toBeEnabled();
  });

  it('puts the create form away on cancel, and after a successful create', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add group/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByLabelText('New group name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add group/i }));
    await user.type(screen.getByLabelText('New group name'), 'Harvest Choir');
    await user.click(screen.getByRole('button', { name: /create group/i }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText('New group name')).not.toBeInTheDocument());
    expect(await screen.findByRole('status')).toHaveTextContent('Group created.');
  });
});

describe('Groups: receptionist parity', () => {
  it('renders the edit surface without a Pastor notification action', async () => {
    await renderLoaded();

    // The page is the same for a receptionist as for an admin, but membership
    // housekeeping has no Pastor notification action.
    await userEvent.setup().click(menuButton("Men's Choir"));
    expect(editButton("Men's Choir")).toBeEnabled();
    expect(within(rowFor("Men's Choir")).queryByRole('button', { name: /send to pastor/i })).toBeNull();
    expect(within(rowFor("Men's Choir")).getByRole('link', { name: 'Members' })).toBeInTheDocument();
  });

  // The delete guard is a typed confirmation, so a native confirm must never be
  // reached: spying it to throw fails loudly if one is ever reintroduced.
  function forbidNativeConfirm() {
    return vi.spyOn(window, 'confirm').mockImplementation(() => {
      throw new Error('window.confirm must not be used: destructive deletes go through the typed dialog');
    });
  }

  it('carries a delete action in the menu, and DELETEs only once the name is retyped', async () => {
    api.delete.mockResolvedValue({ data: { success: true, deleted: true } });
    await renderLoaded();
    const user = userEvent.setup();
    const confirmSpy = forbidNativeConfirm();

    await user.click(menuButton("Men's Choir"));
    await user.click(within(rowFor("Men's Choir")).getByRole('menuitem', { name: /delete/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent("Delete Men's Choir?");
    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(api.delete).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Type Men's Choir to confirm"), "Men's Choir");
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/groups/1'));
    confirmSpy.mockRestore();
  });

  it('a cancelled confirmation sends nothing', async () => {
    await renderLoaded();
    const user = userEvent.setup();
    const confirmSpy = forbidNativeConfirm();

    await user.click(menuButton('Youth Fellowship'));
    await user.click(within(rowFor('Youth Fellowship')).getByRole('menuitem', { name: /delete/i }));

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(api.delete).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
    confirmSpy.mockRestore();
  });
});

describe('Groups: logos', () => {
  it('a group known to have no logo shows the initials fallback and fetches nothing', async () => {
    await renderLoaded();

    const row = rowFor('Wednesday Home Group');
    expect(within(row).getByText('WH')).toBeInTheDocument(); // initials from the name
    expect(api.get).not.toHaveBeenCalledWith('/groups/4/logo', expect.anything());
  });

  it('a group with has_logo fetches its image through the authenticated client', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/groups') return Promise.resolve({ data: { groups: GROUPS } });
      if (url === '/groups/1/logo') return Promise.resolve({ data: new Blob(['png'], { type: 'image/png' }) });
      return Promise.resolve({ data: {} });
    });
    await renderLoaded();

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/groups/1/logo', expect.objectContaining({ responseType: 'blob' })));
    const img = within(rowFor("Men's Choir")).getByRole('img', { name: "Men's Choir logo" });
    expect(img).toHaveAttribute('src', expect.stringContaining('blob:'));
  });

  it('upload PUTs the file immediately, not with the draft save', async () => {
    api.put = vi.fn().mockResolvedValue({ data: { success: true } });
    await renderLoaded();
    const userReal = userEvent.setup();
    await userReal.click(menuButton("Men's Choir"));
    await userReal.click(editButton("Men's Choir"));
    await screen.findByRole('textbox', { name: 'Group name' });

    const input = screen.getByLabelText(/upload logo/i);
    await userReal.upload(input, new File(['png-bytes'], 'wwk.png', { type: 'image/png' }));

    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      '/groups/1/logo',
      expect.any(FormData),
      expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'multipart/form-data' }) })
    ));
  });

  it('remove DELETEs the logo immediately', async () => {
    api.delete.mockClear();
    await renderLoaded();
    const userReal = userEvent.setup();
    await userReal.click(menuButton("Men's Choir"));
    await userReal.click(editButton("Men's Choir"));
    await screen.findByRole('textbox', { name: 'Group name' });

    await userReal.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/groups/1/logo'));
  });
});
