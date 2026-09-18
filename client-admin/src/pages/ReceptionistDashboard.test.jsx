import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import ReceptionistDashboard from './ReceptionistDashboard';
import api from '../api';
import i18n from '../i18n';

vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 9, name: 'Front Desk', role: 'receptionist', language_pref: 'en' } }),
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn() } };
});

// 'general' needs no giver name, which keeps these tests about the payment
// fields alone. 'zaka' would require a donor to be picked as well.
const CATEGORIES = [
  { id: 1, key: 'zaka', name: 'Tithe', requires_receipt: 1 },
  { id: 2, key: 'general', name: 'General collection', requires_receipt: 0 },
];

beforeEach(() => {
  api.get.mockImplementation((url) => {
    switch (url) {
      case '/time':
        return Promise.resolve({ data: { date: '2026-09-16' } });
      case '/service-types':
        return Promise.resolve({
          data: {
            serviceTypes: [
              { id: 1, name: '1st Sunday Service', kind: 'service', attendance_mode: 'headcount', is_active: 1, subSessions: [] },
            ],
          },
        });
      case '/groups':
        return Promise.resolve({ data: { groups: [] } });
      case '/revival-centers':
        return Promise.resolve({ data: { revivalCenters: [] } });
      case '/offerings/categories':
        return Promise.resolve({ data: { categories: CATEGORIES } });
      case '/projects':
        return Promise.resolve({ data: { projects: [] } });
      case '/attendance':
        return Promise.resolve({ data: { attendance: [] } });
      case '/offerings':
        return Promise.resolve({ data: { offerings: [] } });
      default:
        return Promise.reject(new Error(`unexpected GET ${url}`));
    }
  });
  api.post.mockResolvedValue({ data: { id: 1, receiptNumber: null } });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

async function renderDesk() {
  render(<ReceptionistDashboard />);
  // The offering form's chips arrive with the reference data.
  await screen.findByRole('button', { name: 'General collection' });
}

const amountField = () => screen.getByLabelText('Amount');
const offeringSubmit = () => screen.getByRole('button', { name: 'Record offering' });

async function startOffering(user) {
  await user.click(screen.getByRole('button', { name: 'General collection' }));
  await user.type(amountField(), '50000');
}

describe('Front desk: how a gift was paid', () => {
  it('will not record an offering until the desk says how it was paid', async () => {
    const user = userEvent.setup();
    await renderDesk();

    expect(offeringSubmit()).toBeDisabled();
    await startOffering(user);
    // Amount and offering type are in, but the method is not, and the receipt
    // would otherwise have nothing to say about how the money arrived.
    expect(offeringSubmit()).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Cash' }));
    expect(screen.getByRole('button', { name: 'Cash' })).toHaveAttribute('aria-pressed', 'true');
    expect(offeringSubmit()).toBeEnabled();
  });

  it('sends the method and the reference for a mobile-money gift', async () => {
    const user = userEvent.setup();
    await renderDesk();

    await startOffering(user);
    await user.click(screen.getByRole('button', { name: 'Mobile money' }));
    await user.type(screen.getByLabelText('Payment reference'), 'MP240916001');
    await user.click(offeringSubmit());

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/offerings',
        expect.objectContaining({
          category: 'general',
          amount: 50000,
          paymentMethod: 'mobile_money',
          paymentReference: 'MP240916001',
        })
      )
    );
  });

  it('asks for a reference only when the method has one, and clears it on switching', async () => {
    const user = userEvent.setup();
    await renderDesk();
    await startOffering(user);

    // Cash has nothing to write down: no field at all.
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    expect(screen.queryByLabelText('Payment reference')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Bank transfer' }));
    await user.type(screen.getByLabelText('Payment reference'), 'CRDB-88213');
    expect(screen.getByLabelText('Payment reference')).toHaveValue('CRDB-88213');

    // Switching away to cash drops it rather than keeping a slip number
    // attached to a gift that was handed over in notes.
    await user.click(screen.getByRole('button', { name: 'Cash' }));
    await user.click(screen.getByRole('button', { name: 'Bank transfer' }));
    expect(screen.getByLabelText('Payment reference')).toHaveValue('');
  });

  it('clears the reference after recording, and never sends it for cash', async () => {
    const user = userEvent.setup();
    await renderDesk();
    await startOffering(user);

    await user.click(screen.getByRole('button', { name: 'Cheque' }));
    await user.type(screen.getByLabelText('Payment reference'), 'CHQ-000123');
    await user.click(offeringSubmit());

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    // One confirmation code belongs to one gift: the next cheque is recorded
    // with its own number, never with the previous one still in the box.
    await waitFor(() => expect(screen.getByLabelText('Payment reference')).toHaveValue(''));

    await user.click(screen.getByRole('button', { name: 'Cash' }));
    await user.type(amountField(), '1000');
    await user.click(offeringSubmit());

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    const [, body] = api.post.mock.calls[1];
    expect(body.paymentMethod).toBe('cash');
    expect(body.paymentReference).toBeUndefined();
  });
});
