import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import Settings from './Settings';
import api from '../api';
import i18n from '../i18n';

vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

// The Users & roles section is superadmin-only; every test here runs as one.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'superadmin' } }),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

const USERS = [
  { id: 1, name: 'Elisha', email: 'elisha@vrt.org', role: 'admin', is_active: 1 },
  { id: 2, name: 'Neema', email: 'neema@vrt.org', role: 'receptionist', is_active: 1 },
];

async function renderLoaded() {
  render(<Settings />);
  await screen.findByText('Elisha');
}

beforeEach(() => {
  api.get.mockImplementation((url) => {
    if (url === '/users') return Promise.resolve({ data: { users: USERS } });
    return Promise.resolve({ data: {} });
  });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Settings: user creation lives behind the Add user button', () => {
  // Interaction-heavy; starves past 5s only under the full parallel run
  // (passes in isolation): same treatment as the other heavy tests.
  it('hides the create form behind the Add user button until asked for', { timeout: 15000 }, async () => {
    const user = userEvent.setup();
    await renderLoaded();

    // The section leads with the table; adding an account is a deliberate act,
    // not a permanent five-field fixture between the heading and the list.
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add user/i }));
    expect(screen.getByLabelText('Full name')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create user/i })).toBeInTheDocument();

    // A second click of the header button restarts the form empty.
    await user.type(screen.getByLabelText('Full name'), 'Half');
    await user.click(screen.getByRole('button', { name: /add user/i }));
    expect(screen.getByLabelText('Full name')).toHaveValue('');
  });

  it('creates through the form, which closes on success', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({ data: {} });
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add user/i }));
    await user.type(screen.getByLabelText('Full name'), 'Baraka J');
    await user.type(screen.getByLabelText('Email address'), 'baraka@vrt.org');
    await user.type(screen.getByLabelText('Password'), 'temp-password-1');
    await user.click(screen.getByRole('button', { name: /create user/i }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/users', {
        name: 'Baraka J',
        email: 'baraka@vrt.org',
        role: 'receptionist',
        password: 'temp-password-1',
      })
    );
    await waitFor(() => expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument());
    expect(await screen.findByText('User created successfully.')).toBeInTheDocument();
  });

  it('puts the create form away on cancel without writing anything', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /add user/i }));
    await user.type(screen.getByLabelText('Full name'), 'Baraka J');
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByLabelText('Full name')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
