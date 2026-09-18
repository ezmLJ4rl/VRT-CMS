import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import Receipts from './Receipts';
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

const ACTIVE = {
  id: 11,
  receipt_number: 'VR-2026-0011',
  service_date: '2026-09-16',
  offererName: 'Elisha Makala',
  category_name: 'Zaka (Tithe)',
  category_key: 'zaka',
  service_name: '1st Sunday Service',
  amount: 50000,
  currency: 'TZS',
  payment_method: 'mobile_money',
  payment_reference: 'MP240916001',
  verification_status: 'active',
  verification_token: 'tok-active',
  verification_url: 'https://cms.vrtchurch.org/verify/receipt/tok-active',
  voided_at: null,
};

const REVOKED = {
  ...ACTIVE,
  id: 12,
  receipt_number: 'VR-2026-0012',
  offererName: 'Grace Mushi',
  amount: 42000,
  payment_method: 'bank',
  payment_reference: 'CRDB-88213',
  verification_status: 'revoked',
  verification_token: 'tok-revoked',
  verification_url: 'https://cms.vrtchurch.org/verify/receipt/tok-revoked',
  verification_revocation_reason: 'Issued in error',
};

const VOIDED = {
  ...ACTIVE,
  id: 13,
  receipt_number: 'VR-2026-0013',
  offererName: 'Peter Joseph',
  amount: 30000,
  // Voided before payment methods were recorded: the two fields are absent
  // rather than inherited from the active fixture above.
  payment_method: null,
  payment_reference: null,
  verification_status: 'revoked',
  verification_token: 'tok-voided',
  verification_url: 'https://cms.vrtchurch.org/verify/receipt/tok-voided',
  voided_at: '2026-09-16 10:00:00',
  void_reason: 'Duplicate entry',
};

// A gift recorded without a receipt: this screen is about receipts, so it has
// nothing to manage here.
const NO_RECEIPT = { ...ACTIVE, id: 14, receipt_number: null, verification_status: undefined, verification_url: null, amount: 1200 };

// A receipt issued before verification codes existed (the boot backfill in
// db/migrate.js normally gives these a token): it can still be printed, and it is
// the one case where a code is generated on request.
const NO_CODE = {
  ...ACTIVE,
  id: 15,
  receipt_number: 'VR-2026-0015',
  offererName: 'Anna Kimaro',
  payment_method: 'cash',
  payment_reference: null,
  verification_token: null,
  verification_url: null,
};

// A receipt issued before payment methods existed: the details panel says so
// rather than showing an empty field that reads like "cash".
const NO_PAYMENT = { ...ACTIVE, id: 16, receipt_number: 'VR-2026-0016', offererName: 'Ruth Mwita', payment_method: null, payment_reference: null };

const OFFERINGS = [ACTIVE, REVOKED, VOIDED, NO_CODE, NO_PAYMENT, NO_RECEIPT];

const HISTORY = [
  {
    id: 101,
    action: 'offering_recorded',
    details: { amount: 50000, currency: 'TZS' },
    timestamp: '2026-09-16T07:05:00.000Z',
    recordedBy: 'Receipt Desk',
  },
  {
    id: 102,
    action: 'receipt_verification_revoked',
    details: { receipt: 'VR-2026-0011', reason: 'Issued in error' },
    timestamp: '2026-09-16T09:30:00.000Z',
    recordedBy: 'Super Admin',
  },
];

const DAY_OK = {
  date: '2026-09-16',
  valid: true,
  chainValid: true,
  linkedToNext: true,
  brokenAtId: null,
  entries: 128,
  offerings: { byCurrency: [{ currency: 'TZS', count: 42, total: 1250000 }], voided: 1 },
};

const rowFor = (receiptNumber) => screen.getByText(receiptNumber).closest('tr');

async function renderLoaded() {
  render(<Receipts />);
  await screen.findByText('VR-2026-0011');
}

// The toggle is found by its aria-expanded state rather than its label, so this
// helper works in either language.
async function openDetails(user, receiptNumber) {
  const row = rowFor(receiptNumber);
  const toggle = within(row).getAllByRole('button').find((b) => b.hasAttribute('aria-expanded'));
  await user.click(toggle);
}

beforeEach(() => {
  api.get.mockImplementation((url) => {
    if (url === '/offerings') return Promise.resolve({ data: { offerings: OFFERINGS } });
    if (/^\/offerings\/\d+\/audit$/.test(url)) return Promise.resolve({ data: { receiptNumber: 'VR-2026-0012', entries: HISTORY } });
    if (url === '/reports/audit/verify') return Promise.resolve({ data: DAY_OK });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  api.patch.mockResolvedValue({ data: { status: 'revoked', unchanged: false, reason: 'Issued in error', revokedAt: '2026-09-16 09:30:00' } });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Receipts: the list', () => {
  it('lists only receipted gifts, with the verification status of each one', async () => {
    await renderLoaded();

    expect(screen.getByText('VR-2026-0011')).toBeInTheDocument();
    expect(screen.getByText('VR-2026-0012')).toBeInTheDocument();
    // A voided gift's receipt is shown, marked voided rather than merely revoked.
    expect(screen.getByText('VR-2026-0013')).toBeInTheDocument();
    // …and an offering with no receipt is not this screen's business.
    expect(screen.queryByText('VR-2026-0014')).not.toBeInTheDocument();
    expect(screen.queryByText('Elisha Makala')).toBeInTheDocument();

    expect(within(rowFor('VR-2026-0011')).getByText('Verified')).toBeInTheDocument();
    expect(within(rowFor('VR-2026-0012')).getByText('Revoked')).toBeInTheDocument();
    expect(within(rowFor('VR-2026-0013')).getByText('Voided')).toBeInTheDocument();
  });

  it('hides voided receipts unless asked for, and asks the server for them when it is', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    // The default request does not opt into voided rows.
    expect(api.get).toHaveBeenCalledWith('/offerings', { params: { from: expect.any(String), to: expect.any(String), includeVoided: undefined } });

    await user.click(screen.getByLabelText('Include voided receipts'));

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/offerings', {
        params: { from: expect.any(String), to: expect.any(String), includeVoided: 1 },
      })
    );
  });

  it('filters what is on screen by receipt number, giver or offering', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const search = screen.getByPlaceholderText('Receipt no., giver or payment reference');
    await user.type(search, 'Grace');
    expect(screen.getByText('VR-2026-0012')).toBeInTheDocument();
    expect(screen.queryByText('VR-2026-0011')).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, '0013');
    expect(screen.getByText('VR-2026-0013')).toBeInTheDocument();
    expect(screen.queryByText('VR-2026-0012')).not.toBeInTheDocument();

    // Nothing matches: the empty state, not a blank table.
    await user.clear(search);
    await user.type(search, 'nobody by that name');
    expect(screen.getByText('No receipts in this period.')).toBeInTheDocument();
  });
});

describe('Receipts: the details panel', () => {
  it('offers printing, the PDF and the verification link for the row that was opened', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openDetails(user, 'VR-2026-0011');

    expect(screen.getByRole('link', { name: /print/i })).toHaveAttribute('href', expect.stringContaining('/offerings/11/receipt?token='));
    expect(screen.getByRole('link', { name: /pdf/i })).toHaveAttribute('href', expect.stringContaining('/offerings/11/receipt.pdf?token='));
    // The link a member would scan is shown as text, so an admin can read or
    // copy it without a phone.
    expect(screen.getByText('https://cms.vrtchurch.org/verify/receipt/tok-active')).toBeInTheDocument();
  });

  it('loads the receipt\'s own audit history, naming the actions', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openDetails(user, 'VR-2026-0011');

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/offerings/11/audit'));
    expect(await screen.findByText('Offering recorded')).toBeInTheDocument();
    expect(screen.getByText('Verification revoked')).toBeInTheDocument();
    expect(screen.getByText(/by Super Admin/)).toBeInTheDocument();
    expect(screen.getByText('Reason: Issued in error')).toBeInTheDocument();
    expect(screen.getByText('Amount: 50000 TZS')).toBeInTheDocument();
  });

  it('does not offer to revoke a receipt that is already revoked or voided', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await openDetails(user, 'VR-2026-0012');
    expect(screen.getByRole('button', { name: /restore verification/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke verification/i })).not.toBeInTheDocument();
    await openDetails(user, 'VR-2026-0012'); // collapse

    await openDetails(user, 'VR-2026-0013');
    expect(screen.queryByRole('button', { name: /restore verification/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /revoke verification/i })).not.toBeInTheDocument();
    // A voided receipt is explained, with the way back to a valid one.
    expect(screen.getByText(/was voided, so its receipt can no longer be verified/i)).toBeInTheDocument();
  });
});

describe('Receipts: how the gift was paid', () => {
  it('shows the payment method and the reference the receipt carries', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openDetails(user, 'VR-2026-0011');

    expect(screen.getByText(/Payment method:/)).toBeInTheDocument();
    expect(screen.getByText('Mobile money')).toBeInTheDocument();
    expect(screen.getByText(/Payment reference:/)).toBeInTheDocument();
    expect(screen.getByText('MP240916001')).toBeInTheDocument();
  });

  it('says "not recorded" for a receipt that predates payment methods', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openDetails(user, 'VR-2026-0016');

    // Both lines are present and honest: an empty field would read as a value
    // that was captured and came out blank.
    expect(screen.getByText(/Payment method:/)).toBeInTheDocument();
    expect(screen.getAllByText('Not recorded')).toHaveLength(2);
  });

  it('finds a receipt by the payment reference on it', async () => {
    // A member arrives holding a mobile-money confirmation code, not a receipt
    // number: the reference is what the admin has to search by.
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(screen.getByPlaceholderText('Receipt no., giver or payment reference'), 'MP240916');
    expect(screen.getByText('VR-2026-0011')).toBeInTheDocument();
    expect(screen.queryByText('VR-2026-0012')).not.toBeInTheDocument();
  });

  it('translates the method in the details panel', async () => {
    const user = userEvent.setup();
    await act(async () => {
      await i18n.changeLanguage('sw');
    });
    await renderLoaded();
    await openDetails(user, 'VR-2026-0011');

    expect(screen.getByText(/Njia ya malipo:/)).toBeInTheDocument();
    expect(screen.getByText('Pesa za simu')).toBeInTheDocument();
    expect(screen.getByText(/Kumbukumbu ya malipo:/)).toBeInTheDocument();
  });
});

describe('Receipts: revoking and restoring', () => {
  it('asks for a reason before revoking, and sends it', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openDetails(user, 'VR-2026-0011');

    await user.click(screen.getByRole('button', { name: /revoke verification/i }));

    // The confirmation replaces the action and explains what it does.
    expect(screen.getByText('Revoke verification for VR-2026-0011?')).toBeInTheDocument();
    expect(screen.getByText(/will be told it is no longer valid/i)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Reason (optional)'), 'Issued in error');
    await user.click(screen.getByRole('button', { name: /revoke receipt/i }));

    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/offerings/11/verification/revoke', { reason: 'Issued in error' })
    );
    expect(await screen.findByText('VR-2026-0011 can no longer be verified.')).toBeInTheDocument();
    // The row reflects the new state without a reload.
    await waitFor(() => expect(within(rowFor('VR-2026-0011')).getByText('Revoked')).toBeInTheDocument());
    expect(screen.queryByText('Revoke verification for VR-2026-0011?')).not.toBeInTheDocument();
  });

  it('cancels a revoke without writing anything', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openDetails(user, 'VR-2026-0011');

    await user.click(screen.getByRole('button', { name: /revoke verification/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Revoke verification for VR-2026-0011?')).not.toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('restores a revoked receipt', async () => {
    const user = userEvent.setup();
    api.patch.mockResolvedValue({ data: { status: 'active', unchanged: false } });
    await renderLoaded();
    await openDetails(user, 'VR-2026-0012');

    await user.click(screen.getByRole('button', { name: /restore verification/i }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/offerings/12/verification/restore'));
    expect(await screen.findByText('VR-2026-0012 verifies again.')).toBeInTheDocument();
    await waitFor(() => expect(within(rowFor('VR-2026-0012')).getByText('Verified')).toBeInTheDocument());
  });

  it('generates a code for a receipt that predates them, and only then', async () => {
    const user = userEvent.setup();
    api.post.mockResolvedValue({
      data: { issued: true, verificationToken: 'tok-new', verificationUrl: 'https://cms.vrtchurch.org/verify/receipt/tok-new', status: 'active' },
    });
    await renderLoaded();

    // A receipt that already verifies offers no way to mint a second credential.
    await openDetails(user, 'VR-2026-0011');
    expect(screen.queryByRole('button', { name: /generate verification code/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy link/i })).toBeInTheDocument();
    await openDetails(user, 'VR-2026-0011'); // collapse

    await openDetails(user, 'VR-2026-0015');
    expect(screen.getByText(/issued before verification codes existed/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /generate verification code/i }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/offerings/15/verification/regenerate'));
    expect(await screen.findByText('A verification code was issued for VR-2026-0015.')).toBeInTheDocument();
    expect(await screen.findByText('https://cms.vrtchurch.org/verify/receipt/tok-new')).toBeInTheDocument();
  });

  it('copies the verification link, and says so', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await renderLoaded();
    await openDetails(user, 'VR-2026-0011');
    await user.click(screen.getByRole('button', { name: /copy link/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://cms.vrtchurch.org/verify/receipt/tok-active'));
    expect(await screen.findByText('Verification link copied.')).toBeInTheDocument();
  });
});

describe('Receipts: the daily audit chain, kept separate from a receipt', () => {
  it('verifies a day on demand and reports the entries and the day\'s money', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /verify day/i }));

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/reports/audit/verify', { params: { date: expect.any(String) } })
    );
    expect(await screen.findByText("The day's chain is intact. 128 entries verified.")).toBeInTheDocument();
    expect(screen.getByText('Entries')).toBeInTheDocument();
    expect(screen.getByText(/1,250,000/)).toBeInTheDocument();
  });

  it('shows where a broken chain broke, and flags a day that does not link onward', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url === '/offerings') return Promise.resolve({ data: { offerings: OFFERINGS } });
      if (url === '/reports/audit/verify') {
        return Promise.resolve({ data: { ...DAY_OK, valid: false, chainValid: false, linkedToNext: false, brokenAtId: 4242 } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    await renderLoaded();
    await user.click(screen.getByRole('button', { name: /verify day/i }));

    expect(await screen.findByText('The chain is broken at entry #4242.')).toBeInTheDocument();
    expect(screen.getByText(/does not link back to it/i)).toBeInTheDocument();
  });

  it('says so honestly when a day has no entries at all', async () => {
    const user = userEvent.setup();
    api.get.mockImplementation((url) => {
      if (url === '/offerings') return Promise.resolve({ data: { offerings: OFFERINGS } });
      if (url === '/reports/audit/verify') {
        return Promise.resolve({ data: { ...DAY_OK, entries: 0, offerings: { byCurrency: [], voided: 0 } } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    await renderLoaded();
    await user.click(screen.getByRole('button', { name: /verify day/i }));

    expect(await screen.findByText('No audit entries were recorded that day.')).toBeInTheDocument();
  });
});

describe('Receipts: language', () => {
  it('follows the app language setting rather than hardcoding one', async () => {
    const user = userEvent.setup();
    await act(async () => {
      await i18n.changeLanguage('sw');
    });
    await renderLoaded();

    expect(screen.getByRole('heading', { name: 'Risiti na uthibitisho' })).toBeInTheDocument();
    expect(screen.getByText('Namba ya risiti')).toBeInTheDocument();
    expect(within(rowFor('VR-2026-0012')).getByText('Imebatilishwa')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thibitisha siku' })).toBeInTheDocument();

    await openDetails(user, 'VR-2026-0012');
    expect(screen.getByRole('button', { name: /rejesha uthibitisho/i })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('en');
    });
    expect(screen.getByRole('heading', { name: 'Receipts & verification' })).toBeInTheDocument();
  });
});
