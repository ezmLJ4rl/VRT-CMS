import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ServiceTypes from './ServiceTypes';
import api from '../api';
import i18n from '../i18n';

// The shell brings in the router, the auth context and the language switcher:
// none of which the rules under test touch, and all of which would need their
// own network stubs.
vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

// Only the HTTP client is faked. apiErrorMessage stays real so these tests see
// the same error handling the app does.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});

const TYPES = [
  {
    id: 1,
    name: '1st Sunday Service',
    key: '1st_sunday_service',
    kind: 'service',
    attendance_mode: 'headcount',
    is_active: 1,
    sort_order: 0,
    subSessions: [
      { id: 11, name: 'Sunday School', is_active: 1 },
      { id: 12, name: 'Main Service', is_active: 1 },
    ],
  },
  {
    id: 2,
    name: 'Choir Rehearsal 1',
    key: 'choir_rehearsal_1',
    kind: 'rehearsal',
    attendance_mode: 'both',
    is_active: 1,
    sort_order: 1,
    subSessions: [],
  },
  {
    id: 3,
    name: 'Friday Service',
    key: 'friday_service',
    kind: 'service',
    attendance_mode: 'headcount',
    is_active: 0,
    sort_order: 2,
    subSessions: [],
  },
];

const rowFor = (name) => screen.getByText(name).closest('li');
const nameField = (name) => within(rowFor(name)).getByRole('textbox', { name: 'Name' });
const saveButton = (name) => within(rowFor(name)).getByRole('button', { name: /save changes/i });

async function renderLoaded() {
  render(<ServiceTypes />);
  await screen.findByText('1st Sunday Service');
}

async function openEditor(user, name) {
  await user.click(within(rowFor(name)).getByRole('button', { name: 'Edit' }));
}

beforeEach(() => {
  api.get.mockResolvedValue({ data: { serviceTypes: TYPES } });
  api.patch.mockResolvedValue({ data: {} });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Service Types: collapsed rows', () => {
  it('gives each collapsed row one action and nothing else', async () => {
    await renderLoaded();

    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(TYPES.length);

    for (const row of rows) {
      // One affordance per row, and it is labelled rather than a bare icon.
      expect(within(row).getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['Edit']);
      // No permanent editing surface: no fields, no selects, no toggles.
      expect(within(row).queryAllByRole('textbox')).toHaveLength(0);
      expect(within(row).queryAllByRole('combobox')).toHaveLength(0);
    }
  });

  it('shows the mode and type as muted metadata badges', async () => {
    await renderLoaded();

    const row = rowFor('Choir Rehearsal 1');
    // Exact text, so the row's own title ("Choir Rehearsal 1") is not matched.
    const badges = [within(row).getByText('Headcount + named'), within(row).getByText('Rehearsal')];
    for (const badge of badges) {
      // One shared, low-saturation badge style, never a category/action colour.
      expect(badge).toHaveClass('cat-chip', 'category-ink');
    }
  });

  it('keeps sub-session names readable with no way to delete them', async () => {
    await renderLoaded();

    const row = rowFor('1st Sunday Service');
    expect(within(row).getByText(/Sunday School/)).toBeInTheDocument();
    expect(within(row).getByText(/Main Service/)).toBeInTheDocument();
    // The remove control only exists inside the editor.
    expect(within(row).queryAllByRole('button', { name: /remove/i })).toHaveLength(0);
    expect(within(row).queryAllByRole('textbox')).toHaveLength(0);
  });
});

describe('Service Types: one row editable at a time', () => {
  it('opens an editor for the clicked row only', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, 'Choir Rehearsal 1');

    const fields = screen.getAllByRole('textbox', { name: 'Name' });
    expect(fields).toHaveLength(1);
    expect(fields[0]).toHaveValue('Choir Rehearsal 1');
  });

  it('reveals the remove controls and the secondary add action only while editing', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');

    expect(within(rowFor('1st Sunday Service')).getAllByRole('button', { name: /remove/i })).toHaveLength(2);
    const add = within(rowFor('1st Sunday Service')).getByRole('button', { name: /add sub-session/i });
    // Outlined secondary, not a competing filled control.
    expect(add).toHaveClass('btn-secondary');
  });

  it('keeps at most one row open when the admin moves between rows', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');
    await openEditor(user, 'Friday Service');

    expect(screen.getAllByRole('textbox', { name: 'Name' })).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Friday Service');
  });

  it('refuses to open another row while the current edit is unsaved', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');
    await user.type(nameField('1st Sunday Service'), ' edited');

    const blocked = within(rowFor('Friday Service')).getByRole('button', { name: 'Edit' });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAttribute('title', 'Save or cancel your current changes first.');

    // Cancelling discards the draft and frees the other rows again.
    await user.click(within(rowFor('1st Sunday Service')).getByRole('button', { name: /cancel/i }));

    expect(within(rowFor('Friday Service')).getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.queryAllByRole('textbox', { name: 'Name' })).toHaveLength(0);
  });
});

describe('Service Types: save is gated on a real change', () => {
  it('opens with Save visibly disabled and neutral', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');

    const save = saveButton('1st Sunday Service');
    expect(save).toBeDisabled();
    expect(save).toHaveClass('btn-secondary');
    expect(save).not.toHaveClass('btn-ink');
    expect(save).toHaveAttribute('title', 'No changes to save yet.');
  });

  it('becomes the filled primary once a field actually differs', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');
    await user.type(nameField('1st Sunday Service'), ' edited');

    expect(saveButton('1st Sunday Service')).toBeEnabled();
    expect(saveButton('1st Sunday Service')).toHaveClass('btn-ink');
  });

  it('goes back to disabled when the edit is undone', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');
    await user.type(nameField('1st Sunday Service'), ' edited');
    expect(saveButton('1st Sunday Service')).toBeEnabled();

    await user.clear(nameField('1st Sunday Service'));
    await user.type(nameField('1st Sunday Service'), '1st Sunday Service');

    expect(saveButton('1st Sunday Service')).toBeDisabled();
    expect(saveButton('1st Sunday Service')).toHaveClass('btn-secondary');
  });

  it('counts a sub-session rename as a change', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');
    const [firstSub] = within(rowFor('1st Sunday Service')).getAllByRole('textbox', { name: 'Sub-session' });
    await user.type(firstSub, ' II');

    expect(saveButton('1st Sunday Service')).toBeEnabled();
  });

  it('counts an added sub-session as a change, but refuses to save a blank one', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');
    await user.click(within(rowFor('1st Sunday Service')).getByRole('button', { name: /add sub-session/i }));

    const subs = within(rowFor('1st Sunday Service')).getAllByRole('textbox', { name: 'Sub-session' });
    expect(subs).toHaveLength(3);
    // A nameless sub-session would be dropped by the API as a deletion, so it blocks the save.
    expect(saveButton('1st Sunday Service')).toBeDisabled();
    expect(saveButton('1st Sunday Service')).toHaveAttribute('title', 'Give each sub-session a name, or remove it.');

    await user.type(subs[2], 'Youth Hour');
    expect(saveButton('1st Sunday Service')).toBeEnabled();
  });

  it('stages the disable toggle instead of writing immediately, and discards it on cancel', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');
    const row = rowFor('1st Sunday Service');
    await user.click(within(row).getByRole('button', { name: 'Disable' }));

    // No write yet: the change is only staged.
    expect(api.patch).not.toHaveBeenCalled();
    // The row reports what is about to be saved.
    expect(within(rowFor('1st Sunday Service')).getByText('Disabled')).toBeInTheDocument();
    expect(saveButton('1st Sunday Service')).toBeEnabled();
    expect(within(rowFor('1st Sunday Service')).getByRole('button', { name: 'Enable' })).toBeInTheDocument();

    await user.click(within(rowFor('1st Sunday Service')).getByRole('button', { name: /cancel/i }));

    // Scoped to this row: another fixture row is genuinely inactive.
    expect(within(rowFor('1st Sunday Service')).queryByText('Disabled')).not.toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('Service Types: saving', () => {
  it('PATCHes the staged row and closes the editor', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openEditor(user, '1st Sunday Service');
    await user.type(nameField('1st Sunday Service'), ' (edited)');
    await user.click(saveButton('1st Sunday Service'));

    expect(api.patch).toHaveBeenCalledTimes(1);
    expect(api.patch).toHaveBeenCalledWith('/service-types/1', {
      name: '1st Sunday Service (edited)',
      kind: 'service',
      isActive: true,
      subSessions: [
        { id: 11, name: 'Sunday School', isActive: true },
        { id: 12, name: 'Main Service', isActive: true },
      ],
    });

    await waitFor(() => expect(screen.queryAllByRole('textbox', { name: 'Name' })).toHaveLength(0));
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
  });
});

describe('Service Types: language', () => {
  it('follows the app language setting rather than hardcoding one', async () => {
    const user = userEvent.setup();
    await act(async () => {
      await i18n.changeLanguage('sw');
    });
    await renderLoaded();

    expect(screen.getByRole('heading', { name: 'Aina za ibada' })).toBeInTheDocument();
    // The create form's placeholder used to be hardcoded English. The form is
    // hidden until asked for, so the button that reveals it is asserted too.
    expect(screen.getByRole('button', { name: 'Ongeza aina' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ongeza aina' }));
    expect(screen.getByPlaceholderText('mf. Ibada ya uinjilisti')).toBeInTheDocument();
    expect(within(rowFor('1st Sunday Service')).getByRole('button', { name: 'Hariri' })).toBeInTheDocument();
    expect(within(rowFor('1st Sunday Service')).getByText('Idadi ya watu')).toBeInTheDocument();
    expect(within(rowFor('1st Sunday Service')).getByText('Ibada')).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('en');
    });

    expect(screen.getByRole('heading', { name: 'Service types' })).toBeInTheDocument();
    expect(within(rowFor('1st Sunday Service')).getByText('Headcount')).toBeInTheDocument();
  });
});

describe('Service Types: create form lives behind the Add type button', () => {
  it('hides the create form behind the Add type button until asked for', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    // The page leads with the list; creating is a deliberate act, not a fixture.
    expect(screen.queryByLabelText('New service type name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add type/i }));
    const name = screen.getByLabelText('New service type name');
    expect(screen.getByLabelText('Type')).toBeInTheDocument();
    expect(screen.getByLabelText('Attendance mode')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create type/i })).toBeInTheDocument();

    // A second click of the header button restarts the form empty, never leaves
    // a half-typed name waiting to be submitted by surprise.
    await user.type(name, 'Half');
    await user.click(screen.getByRole('button', { name: /add type/i }));
    expect(screen.getByLabelText('New service type name')).toHaveValue('');
    // The reset also restores the default mode, not just the name.
    expect(screen.getByLabelText('Attendance mode')).toHaveValue('headcount');
  });

  it('creates through the form, and the form is the submitter, not the header button', async () => {
    const user = userEvent.setup();
    api.get.mockResolvedValue({ data: { serviceTypes: TYPES } });
    api.post.mockResolvedValue({ data: {} });
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add type/i }));
    await user.type(screen.getByLabelText('New service type name'), 'Outreach Service');
    await user.selectOptions(screen.getByLabelText('Type'), 'rehearsal');
    // Choosing a rehearsal flips the mode to headcount + names by default.
    expect(screen.getByLabelText('Attendance mode')).toHaveValue('both');
    // The header button and the form's own submit are different actions: the
    // form's must be the one that fires, or a click could just reset the form.
    await user.click(screen.getByRole('button', { name: /create type/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/service-types', {
        name: 'Outreach Service',
        kind: 'rehearsal',
        attendanceMode: 'both',
        subSessions: [],
      })
    );
    await waitFor(() => expect(screen.queryByLabelText('New service type name')).not.toBeInTheDocument());
    expect(await screen.findByText('Service type created.')).toBeInTheDocument();
  });

  it('puts the create form away on cancel without writing anything', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add type/i }));
    await user.type(screen.getByLabelText('New service type name'), 'Outreach Service');
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByLabelText('New service type name')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
