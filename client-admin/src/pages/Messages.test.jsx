import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Messages from './Messages';
import api from '../api';
import i18n from '../i18n';

// The shell brings in the nav and the language switcher; the rules under test are
// about the sent list, so only the HTTP client is faked.
vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

// Mutable so the admin and the front desk can both be read without a second file:
// only an admin's list can hold a colleague's send, so the sender's name and the
// recall button are role-dependent.
const auth = vi.hoisted(() => ({ id: 1, name: 'Desk One', role: 'receptionist' }));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: auth.id, name: auth.name, role: auth.role } }),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

// One message the desk sent to the pastor but did not mean to. `read` mirrors the
// server's own `read_at`, which the recall confirm has to look at: a recall can
// stop the pastor seeing the message again, but not unopen what they opened.
const sentRow = (overrides = {}) => ({
  id: 10,
  sender_id: 1,
  sender_name: 'Desk One',
  recipient_id: null,
  recipient_role: 'pastor',
  category: 'general',
  subject: 'Wrong choir',
  body: 'Disregard this.',
  sent_at: '2026-09-15 08:00:00',
  read_at: null,
  recalled_at: null,
  recalled: false,
  read: false,
  canRecall: true,
  ...overrides,
});

let sentRows;

// Every fetch the page makes on mount is answered here, so a test that asserts on
// the sent list cannot pass by accident on data from another endpoint.
function wireApi() {
  api.get.mockImplementation((url) => {
    if (url === '/messages') return Promise.resolve({ data: { conversations: { threads: [], broadcasts: [] } } });
    if (url === '/messages/sent') return Promise.resolve({ data: { sent: sentRows } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

const renderPage = () => render(<Messages />, { wrapper: MemoryRouter });

const recallButton = () => screen.queryByRole('button', { name: /recall$/i });

async function startRecall(user) {
  await user.click(screen.getByRole('button', { name: /^recall$/i }));
}

describe('Messages: recalling a message sent to the pastor', () => {
  let user;

  beforeEach(async () => {
    user = userEvent.setup();
    auth.role = 'receptionist';
    auth.id = 1;
    sentRows = [sentRow()];
    wireApi();
    api.post.mockResolvedValue({ data: { id: 10 } });
    await i18n.changeLanguage('en');
  });

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('lists what went out to the pastor, and asks the server for exactly that', async () => {
    renderPage();

    // The filter is the point: this panel is about the pastor's feed, so it must
    // not silently list replies in direct threads as if they were the same thing.
    expect(api.get).toHaveBeenCalledWith('/messages/sent', { params: { to: 'pastor' } });
    expect(await screen.findByText('Wrong choir')).toBeInTheDocument();
    expect(screen.getByText(/not read yet/i)).toBeInTheDocument();
  });

  it('does not withdraw anything on the first click: it asks', async () => {
    renderPage();
    await screen.findByText('Wrong choir');

    await startRecall(user);

    expect(screen.getByText(/take this message back from the pastor's feed\?/i)).toBeInTheDocument();
    // The honest half of a recall, stated before it happens rather than after.
    expect(screen.getByText(/notification that already reached their phone cannot be taken back/i)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('withdraws the message once confirmed, and leaves the row marked as recalled', async () => {
    renderPage();
    await screen.findByText('Wrong choir');
    await startRecall(user);

    // The refetch is what a real recall returns: the same row, now withdrawn.
    sentRows = [sentRow({ recalled: true, recalled_at: '2026-09-15 09:30:00' })];
    await user.click(screen.getByRole('button', { name: /^recall it$/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/messages/10/recall'));
    expect(await screen.findByText('Recalled')).toBeInTheDocument();
    expect(screen.getByText(/no longer in the pastor's feed/i)).toBeInTheDocument();
    // The record survives, which is why the row is still on the list at all.
    expect(screen.getByText('Wrong choir')).toBeInTheDocument();
    expect(recallButton()).not.toBeInTheDocument();
  });

  it('keeps the message when the confirm is dismissed', async () => {
    renderPage();
    await screen.findByText('Wrong choir');
    await startRecall(user);

    await user.click(screen.getByRole('button', { name: /keep it/i }));

    expect(screen.queryByText(/take this message back/i)).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    expect(recallButton()).toBeInTheDocument();
  });

  it('offers no action on a message already recalled', async () => {
    sentRows = [sentRow({ recalled: true, recalled_at: '2026-09-15 09:30:00' })];
    renderPage();

    expect(await screen.findByText('Recalled')).toBeInTheDocument();
    expect(recallButton()).not.toBeInTheDocument();
  });

  it('names the sender and withholds the action on a colleague\'s message', async () => {
    auth.role = 'admin';
    auth.id = 99;
    sentRows = [sentRow({ sender_id: 1, sender_name: 'Front Desk', canRecall: false })];
    renderPage();

    await screen.findByText('Wrong choir');
    // An admin's list spans senders, so the row has to say whose send it is.
    expect(screen.getByText(/front desk/i)).toBeInTheDocument();
    expect(recallButton()).not.toBeInTheDocument();
  });

  it('reports a failed recall instead of pretending it worked', async () => {
    api.post.mockRejectedValue({ response: { data: { error: 'Failed to recall the message.' } } });
    renderPage();
    await screen.findByText('Wrong choir');
    await startRecall(user);

    await user.click(screen.getByRole('button', { name: /^recall it$/i }));

    expect(await screen.findByText('Failed to recall the message.')).toBeInTheDocument();
    expect(screen.queryByText('Recalled')).not.toBeInTheDocument();
    // Still offered, because nothing was withdrawn.
    expect(screen.getByText(/take this message back/i)).toBeInTheDocument();
  });

  it('reads in Kiswahili too', async () => {
    await i18n.changeLanguage('sw');
    renderPage();

    const panel = (await screen.findByRole('heading', { name: /Zilizotumwa kwa mchungaji/ })).closest('section');
    expect(within(panel).getByText(/Haujasomwa bado/)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: /Ondoa ujumbe/ }));
    expect(within(panel).getByText(/Uondoe ujumbe huu kwenye orodha ya mchungaji\?/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /^Ondoa$/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Acha uwe/ })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });
});
