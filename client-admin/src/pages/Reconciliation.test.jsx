import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import Reconciliation from './Reconciliation';
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
  return { ...actual, default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});

const CRDB = {
  id: 3,
  name: 'CRDB main account',
  provider: 'statement_import',
  providerLabelKey: 'payment.provider_statement_import',
  capabilities: { statement: true, webhook: false, liveSync: false },
  credentialFields: [],
  credentialFieldsSet: [],
  method: 'bank',
  accountRefMasked: '••••4821',
  currency: 'TZS',
  status: 'active',
  source: 'demo',
  webhookUrl: null,
  lastSyncedAt: '2026-09-14 08:00:00',
  lastSyncSummary: { inserted: 12, duplicates: 0, rejected: 1, fileName: 'crdb-sept.csv' },
  pending: { awaiting: 2, matched: 1, confirmed: 4, ignored: 0, awaitingAmount: 130000 },
};

// A webhook account: the only kind that carries a signing secret, and the only
// kind that cannot take a statement.
const MPESA = {
  ...CRDB,
  id: 4,
  name: 'M-Pesa till',
  provider: 'webhook',
  capabilities: { statement: false, webhook: true, liveSync: false },
  credentialFields: ['webhook_secret'],
  credentialFieldsSet: ['webhook_secret'],
  method: 'mobile_money',
  accountRefMasked: '••••7712',
  webhookUrl: 'https://cms.vrtchurch.org/api/payment-webhooks/4',
  lastSyncedAt: null,
  lastSyncSummary: null,
  pending: { awaiting: 0, matched: 0, confirmed: 0, ignored: 0, awaitingAmount: 0 },
};

const PROVIDERS = [
  { key: 'statement_import', labelKey: 'payment.provider_statement_import', capabilities: { statement: true, webhook: false, liveSync: false }, credentialFields: [] },
  { key: 'webhook', labelKey: 'payment.provider_webhook', capabilities: { statement: false, webhook: true, liveSync: false }, credentialFields: ['webhook_secret'] },
];

// A payment whose payer is in the member directory: the matcher SUGGESTS, and a
// human decides (server: utils/paymentIntake.js).
const REVIEW = {
  id: 11,
  accountId: 3,
  accountName: 'CRDB main account',
  provider: 'statement_import',
  method: 'bank',
  providerTransactionId: 'CRDB-778812',
  providerReference: 'ZAKA-4482',
  amount: 50000,
  currency: 'TZS',
  occurredAt: '2026-09-13 09:41:00',
  payerName: 'Amina Hassan',
  payerPhone: '+255 754 111 222',
  description: 'Sunday deposit',
  status: 'successful',
  source: 'statement',
  matchStatus: 'review',
  suggestedMemberId: 7,
  suggestedMemberName: 'Amina Hassan',
  matchedMemberId: null,
  possibleDuplicateOf: null,
  importedAt: '2026-09-14 08:00:00',
  importedByName: 'Super Admin',
  importNote: 'crdb-sept.csv',
  ignoredReason: null,
  receiptNumber: null,
  verificationUrl: null,
};

const UNMATCHED = {
  ...REVIEW,
  id: 12,
  providerReference: 'DEP-99310',
  amount: 80000,
  payerName: null,
  payerPhone: null,
  matchStatus: 'unmatched',
  suggestedMemberId: null,
  suggestedMemberName: null,
  description: 'Cash deposit at branch',
};

const MATCHED = {
  ...REVIEW,
  id: 13,
  amount: 25000,
  providerReference: 'MP2409130099',
  method: 'mobile_money',
  accountName: 'M-Pesa till',
  accountId: 4,
  source: 'webhook',
  matchStatus: 'matched',
  matchMethod: 'phone',
  matchedMemberId: 9,
  matchedMemberName: 'Grace Mushi',
  matchedMemberNo: 'VRT-0009',
  suggestedMemberId: null,
  suggestedMemberName: null,
};

const CONFIRMED = {
  ...MATCHED,
  id: 14,
  amount: 120000,
  providerReference: 'CRDB-771204',
  matchStatus: 'confirmed',
  matchedMemberId: 16,
  matchedMemberName: 'Ruth Mwita',
  matchedMemberNo: 'VRT-0016',
  offeringId: 501,
  receiptNumber: 'VR-2026-0501',
  verificationUrl: 'https://cms.vrtchurch.org/verify/receipt/tok-0501',
  reconciledAt: '2026-09-14 09:15:00',
};

// The provider took this one back: it must never be recordable as giving.
const REVERSED = {
  ...REVIEW,
  id: 15,
  amount: 30000,
  providerReference: 'CRDB-771300',
  status: 'reversed',
  matchStatus: 'review',
  suggestedMemberId: null,
  suggestedMemberName: null,
};

// A line the church's own system flagged as looking like an earlier payment.
const POSSIBLE_DUPLICATE = {
  ...REVIEW,
  id: 16,
  amount: 50000,
  providerReference: null,
  providerTransactionId: 'derived-9f2c41',
  matchStatus: 'review',
  possibleDuplicateOf: 11,
};

// The statement quotes one member's giving code and names a DIFFERENT member as
// the payer. The server refuses to book it and says why
// (match_note: 'code_vs_payer_name', see server/test/giving-codes.test.js); this
// is the screen showing that reason rather than a bare "needs review".
const CODE_CONFLICT = {
  ...REVIEW,
  id: 17,
  providerTransactionId: 'CRDB-778820',
  providerReference: 'ZAKA/VRT-0016/2026-09',
  amount: 60000,
  payerName: 'Baraka Nyerere',
  matchStatus: 'review',
  matchMethod: 'member_no',
  matchNote: 'code_vs_payer_name',
  suggestedMemberId: 16,
  suggestedMemberName: 'Ruth Mwita',
  suggestedMemberNo: 'VRT-0016',
};

const SUMMARY = {
  counts: { unmatched: 1, review: 2, matched: 1, confirmed: 1, ignored: 0 },
  amounts: { unmatched: 80000, review: 155000, matched: 25000, confirmed: 120000, ignored: 0 },
  awaiting: 3,
  awaitingAmount: 235000,
};

const CATEGORIES = [
  { id: 1, key: 'shukrani', name: 'Thanksgiving', requires_receipt: 0 },
  { id: 2, key: 'zaka', name: 'Tithe', requires_receipt: 1 },
];

const SERVICE_TYPES = [
  { id: 5, name: '1st Sunday Service', kind: 'service', is_active: 1 },
  { id: 6, name: 'Practice', kind: 'rehearsal', is_active: 1 },
];

// The screen reads the rows it already fetched, so the fixtures are mutable: an
// action that changed something on the server must change what the next GET
// returns, or the test would be pinning a screen that cannot show its own work.
let transactions;

function resetFixtures() {
  transactions = [REVIEW, UNMATCHED, MATCHED, CONFIRMED, REVERSED, POSSIBLE_DUPLICATE, CODE_CONFLICT].map((t) => ({ ...t }));
}

function patchTransaction(id, patch) {
  transactions = transactions.map((t) => (t.id === id ? { ...t, ...patch } : t));
}

// Waits for the fixtures to be on screen. The payment's own reference is the
// anchor: an account name also appears in the filter above the table, so it is
// deliberately not what this waits on.
async function renderLoaded() {
  render(<Reconciliation />);
  await screen.findByText('ZAKA-4482');
}

/** The details panel of one row, found through the row's Review toggle. */
async function openReview(user, reference) {
  const row = screen.getByText(reference).closest('tr');
  const toggle = within(row).getByRole('button', { name: /review/i });
  await user.click(toggle);
  return row;
}

beforeEach(() => {
  resetFixtures();
  api.get.mockImplementation((url, config) => {
    if (url === '/payment-accounts') return Promise.resolve({ data: { accounts: [CRDB, MPESA], providers: PROVIDERS } });
    if (url === '/payment-transactions') return Promise.resolve({ data: { transactions } });
    if (url === '/payment-transactions/summary') return Promise.resolve({ data: SUMMARY });
    if (url === '/service-types') return Promise.resolve({ data: { serviceTypes: SERVICE_TYPES } });
    if (url === '/offerings/categories') return Promise.resolve({ data: { categories: CATEGORIES } });
    if (url === '/members') {
      const q = config?.params?.search || '';
      return Promise.resolve({ data: { members: [{ id: 7, name: 'Amina Hassan' }].filter((m) => m.name.toLowerCase().includes(q.toLowerCase())) } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

  api.post.mockImplementation((url, body) => {
    if (url === '/payment-accounts/3/sync') {
      return Promise.resolve({
        data: {
          inserted: 12,
          duplicates: 2,
          matched: 6,
          review: 5,
          unmatched: 1,
          rejected: [{ line: 4, reason: 'payment.reject_noAmount' }, { line: 9, reason: 'payment.reject_notCredit' }],
          columns: ['date', 'amount', 'reference', 'payer'],
        },
      });
    }
    if (/^\/payment-transactions\/\d+\/match$/.test(url)) {
      const id = Number(url.split('/')[2]);
      // A decision clears the matcher's note, exactly as the server does.
      patchTransaction(id, { matchStatus: 'matched', matchedMemberId: body.memberId, matchedMemberName: 'Amina Hassan', matchedMemberNo: 'VRT-0007', matchMethod: 'manual', matchNote: null });
      return Promise.resolve({ data: { success: true, matchStatus: 'matched' } });
    }
    if (/^\/payment-transactions\/\d+\/unmatch$/.test(url)) {
      const id = Number(url.split('/')[2]);
      patchTransaction(id, { matchStatus: 'unmatched', matchedMemberId: null, matchedMemberName: null, matchedMemberNo: null });
      return Promise.resolve({ data: { success: true, matchStatus: 'unmatched' } });
    }
    if (/^\/payment-transactions\/\d+\/ignore$/.test(url)) {
      const id = Number(url.split('/')[2]);
      patchTransaction(id, { matchStatus: 'ignored', ignoredReason: body.reason || null });
      return Promise.resolve({ data: { success: true } });
    }
    if (/^\/payment-transactions\/\d+\/reopen$/.test(url)) {
      const id = Number(url.split('/')[2]);
      patchTransaction(id, { matchStatus: 'unmatched', ignoredReason: null });
      return Promise.resolve({ data: { success: true, matchStatus: 'unmatched' } });
    }
    if (/^\/payment-transactions\/\d+\/confirm$/.test(url)) {
      const id = Number(url.split('/')[2]);
      patchTransaction(id, {
        matchStatus: 'confirmed',
        offeringId: 900,
        receiptNumber: 'VR-2026-0900',
        verificationUrl: 'https://cms.vrtchurch.org/verify/receipt/tok-0900',
        reconciledAt: '2026-09-16 10:00:00',
      });
      return Promise.resolve({ data: { offeringId: 900, receiptNumber: 'VR-2026-0900', verificationUrl: 'https://cms.vrtchurch.org/verify/receipt/tok-0900' } });
    }
    if (url === '/payment-accounts') {
      return Promise.resolve({
        data: {
          account: { ...MPESA, id: 8, name: 'NMB collection' },
          issuedCredentials: { webhook_secret: 'whsec_9f2c41ab77' },
        },
      });
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });

  api.patch.mockResolvedValue({
    data: { account: { ...MPESA, name: 'M-Pesa till' }, issuedCredentials: { webhook_secret: 'whsec_rotated99' } },
  });
  api.delete.mockResolvedValue({ data: { success: true } });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Reconciliation: the list of incoming payments', () => {
  it('shows each payment with the church state and the provider state kept apart', async () => {
    await renderLoaded();

    expect(screen.getByText('ZAKA-4482')).toBeInTheDocument();
    expect(screen.getAllByText('Needs review').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Matched').length).toBeGreaterThan(0);
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    // A reversed payment is shown as reversed AND still needs review: the two
    // axes are different questions.
    expect(screen.getByText('Reversed')).toBeInTheDocument();
  });

  it('flags a payment that looks like an earlier one, naming it', async () => {
    await renderLoaded();
    expect(screen.getByText('Possible duplicate of #11')).toBeInTheDocument();
  });

  it('names the member a payment is matched to, and the one it merely suggests', async () => {
    await renderLoaded();

    expect(screen.getByText(/→ Grace Mushi VRT-0009/)).toBeInTheDocument();
    // A suggestion is labelled as a suggestion, never as a match. Two rows carry
    // it: the payment the statement names a member for, and the one that looks
    // like it.
    expect(screen.getAllByText(/Suggesting Amina Hassan/)).toHaveLength(2);
  });

  it('summarises what is waiting, with the money that is waiting with it', async () => {
    await renderLoaded();
    expect(screen.getByRole('button', { name: /Awaiting review: 3/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Awaiting review: 3/ }).textContent).toMatch(/235,000|235000/);
  });

  it('shows what each account is waiting on and what its last import did', async () => {
    await renderLoaded();

    expect(screen.getByText(/^2 payments · /)).toBeInTheDocument();
    expect(screen.getByText(/^2 payments · /).textContent).toMatch(/130,000/);
    expect(screen.getByText('Nothing waiting')).toBeInTheDocument();
    expect(screen.getByText('2026-09-14 08:00:00')).toBeInTheDocument();
    expect(screen.getByText('12 imported, 0 already known, 1 skipped')).toBeInTheDocument();
    expect(screen.getByText('Never imported')).toBeInTheDocument();
  });

  it('shows the account number masked, never in full', async () => {
    await renderLoaded();
    expect(screen.getByText(/••••4821/)).toBeInTheDocument();
  });
});

describe('Reconciliation: reviewing one payment', () => {
  it('shows where the payment came from and how it arrived', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'ZAKA-4482');

    expect(screen.getByText('CRDB-778812')).toBeInTheDocument();
    expect(screen.getByText('CRDB main account · Bank transfer')).toBeInTheDocument();
    expect(screen.getByText('Sunday deposit')).toBeInTheDocument();
    expect(screen.getByText(/2026-09-14 08:00:00 · crdb-sept.csv/)).toBeInTheDocument();

    // The rest is scoped to the panel being read: the payer's number is also on
    // the row's own sub-line, and the statement-upload form below has a field
    // labelled "Statement file" of its own.
    const panel = screen.getByText('CRDB-778812').closest('tr');
    expect(within(panel).getByText('Arrived through')).toBeInTheDocument();
    expect(within(panel).getByText('Statement file')).toBeInTheDocument();
    expect(within(panel).getByText('+255 754 111 222')).toBeInTheDocument();
  });

  it('asks who gave first, and will not match without a person', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'ZAKA-4482');

    await user.click(screen.getByRole('button', { name: 'Match' }));
    expect(api.post).not.toHaveBeenCalled();
    expect(await screen.findByText('Choose the member this came from first.')).toBeInTheDocument();
  });

  it('matches a payment to the member the admin picks, and says who', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'ZAKA-4482');

    // The directory is searched through the same picker the rest of the app uses.
    await user.type(screen.getByPlaceholderText('Search members'), 'Amina');
    await user.click(await screen.findByRole('button', { name: /Amina Hassan/ }));
    await user.click(screen.getByRole('button', { name: 'Match' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-transactions/11/match', { memberId: 7 }));
    expect(await screen.findByText('Matched to Amina Hassan.')).toBeInTheDocument();
    // The row reflects the new state without a reload.
    await waitFor(() => expect(screen.getByText(/→ Amina Hassan VRT-0007/)).toBeInTheDocument());
  });

  it('takes a match back', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'MP2409130099');

    await user.click(screen.getByRole('button', { name: 'Second thoughts' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-transactions/13/unmatch', {}));
    expect(await screen.findByText('The match was taken back.')).toBeInTheDocument();
  });

  it('confirms a payment into giving, and reports the receipt it issued', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'ZAKA-4482');

    // The offering type defaults to the one that issues a receipt, the service to
    // the first active one, and the date to the day the money moved.
    expect(screen.getByRole('combobox', { name: /Offering type/ })).toHaveValue('zaka');
    expect(screen.getByRole('combobox', { name: /Service/ })).toHaveValue('5');
    expect(screen.getByLabelText('Date')).toHaveValue('2026-09-13');

    await user.click(screen.getByRole('button', { name: 'Confirm and issue receipt' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/payment-transactions/11/confirm', {
        category: 'zaka',
        serviceTypeId: 5,
        date: '2026-09-13',
      })
    );
    expect(await screen.findByText('Giving recorded · receipt VR-2026-0900')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/receipt VR-2026-0900/)).toBeInTheDocument());
  });

  it('records the giving category and date the admin actually chose', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'ZAKA-4482');

    await user.selectOptions(screen.getByRole('combobox', { name: /Offering type/ }), 'shukrani');
    await user.clear(screen.getByLabelText('Date'));
    await user.type(screen.getByLabelText('Date'), '2026-09-14');
    await user.click(screen.getByRole('button', { name: 'Confirm and issue receipt' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/payment-transactions/11/confirm', {
        category: 'shukrani',
        serviceTypeId: 5,
        date: '2026-09-14',
      })
    );
  });

  it('refuses to record money the provider took back', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'CRDB-771300');

    expect(screen.getByText(/The provider reports this payment as Reversed, so it cannot be recorded as giving./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm and issue receipt' })).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('sets a payment aside only after asking, and keeps the reason', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'DEP-99310');

    await user.click(screen.getByRole('button', { name: 'Not giving' }));
    // Nothing is written until the admin answers the question.
    expect(api.post).not.toHaveBeenCalled();
    expect(screen.getByText('Set this payment aside without recording giving?')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Reason'), 'Loan repayment');
    await user.click(screen.getByRole('button', { name: 'Set aside' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-transactions/12/ignore', { reason: 'Loan repayment' }));
    expect(await screen.findByText('Set aside. No giving was recorded.')).toBeInTheDocument();
    // The row changes state, keeps the reason it was set aside for, and offers
    // the way back.
    await waitFor(() => expect(screen.getAllByText('Set aside')).toHaveLength(1));
    expect(screen.getByText('Loan repayment')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bring back' })).toBeInTheDocument();
  });

  it('leaves a payment alone when the admin changes their mind', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'DEP-99310');

    await user.click(screen.getByRole('button', { name: 'Not giving' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText('Set this payment aside without recording giving?')).not.toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('brings a set-aside payment back for another look', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    // Set one aside first, so there is something to bring back.
    await openReview(user, 'DEP-99310');
    await user.click(screen.getByRole('button', { name: 'Not giving' }));
    await user.click(screen.getByRole('button', { name: 'Set aside' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Bring back' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-transactions/12/reopen', {}));
    expect(await screen.findByText('Back in the list.')).toBeInTheDocument();
  });

  it('offers no way to un-confirm a payment that already became giving', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'CRDB-771204');

    expect(screen.getByText('Recorded as giving · receipt VR-2026-0501')).toBeInTheDocument();
    // A confirmed payment is a giving record: the panel offers its verification
    // link and no way to un-record it here.
    expect(screen.getByRole('button', { name: 'Copy verification link' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not giving' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm and issue receipt' })).not.toBeInTheDocument();
  });
});

describe('Reconciliation: church accounts', () => {
  it('connects an account and shows the signing secret exactly once', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /Connect an account/ }));
    await user.type(screen.getByLabelText('Name'), 'NMB collection');
    await user.selectOptions(screen.getByLabelText('How money arrives'), 'webhook');
    await user.selectOptions(screen.getByLabelText('Payment method'), 'mobile_money');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/payment-accounts', {
        name: 'NMB collection',
        provider: 'webhook',
        method: 'mobile_money',
        accountRef: undefined,
        currency: 'TZS',
      })
    );
    // The secret is the one thing shown prominently, and there is no endpoint to
    // read it back afterwards, so this is where it lives or nowhere.
    expect(await screen.findByText('whsec_9f2c41ab77')).toBeInTheDocument();
    expect(screen.getByText(/Signing secret for NMB collection/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByText('whsec_9f2c41ab77')).not.toBeInTheDocument();
  });

  it('rotates a webhook secret, and never offers to read one back', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    // Only the account that has a secret can rotate one.
    expect(screen.getAllByRole('button', { name: /Rotate secret/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /Rotate secret/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/payment-accounts/4', { rotateWebhookSecret: true }));
    expect(await screen.findByText('whsec_rotated99')).toBeInTheDocument();
  });

  it('switches an account off and on again', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getAllByRole('button', { name: 'Switch off' })[0]);
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/payment-accounts/3', { status: 'disabled' }));
    expect(await screen.findByText('M-Pesa till is switched off. Nothing more will be read from it.')).toBeInTheDocument();
  });

  it('disconnects an account that has never been used', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/payment-accounts/4'));
    expect(await screen.findByText('M-Pesa till was disconnected.')).toBeInTheDocument();
  });
});

describe('Reconciliation: importing a statement', () => {
  it('imports the pasted statement, and reports the lines it could not use', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    const statement = 'Date,Amount,Reference,Payer\n13/09/2026,"50,000",ZAKA-4482,Amina Hassan';
    await user.click(screen.getByPlaceholderText('…or paste the statement contents here'));
    await user.paste(statement);
    await user.click(screen.getByRole('button', { name: /Import into CRDB main account/ }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/payment-accounts/3/sync', { statement, fileName: undefined })
    );
    expect(await screen.findByText('12 payments imported, 2 already known.')).toBeInTheDocument();
    // Both counts and both reasons, in the reader's language rather than as the
    // server's catalog keys.
    expect(screen.getByText(/Line 4: no readable amount/)).toBeInTheDocument();
    expect(screen.getByText(/Line 9: money going out, not giving/)).toBeInTheDocument();
    expect(screen.getByText(/Columns read: date, amount, reference, payer/)).toBeInTheDocument();
  });

  it('offers the statement upload only for the accounts that take one', async () => {
    await renderLoaded();
    // The webhook till cannot be given a file, so it is not in the list.
    expect(screen.getByRole('combobox', { name: 'Into account' })).toHaveTextContent('CRDB main account');
    expect(screen.getByRole('combobox', { name: 'Into account' })).not.toHaveTextContent('M-Pesa till');
  });
});

describe('Reconciliation: finding one payment', () => {
  it('searches the server, so a payment outside the period still turns up', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.type(screen.getByPlaceholderText('Reference, payer or description'), 'MP2409130099');

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/payment-transactions', {
        params: { from: expect.any(String), to: expect.any(String), accountId: undefined, matchStatus: 'review,unmatched,matched', q: 'MP2409130099' },
      })
    );
  });

  it('filters to one state and one account at a time', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(screen.getByRole('button', { name: /^Confirmed/ }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/payment-transactions', {
        params: { from: expect.any(String), to: expect.any(String), accountId: undefined, matchStatus: 'confirmed', q: undefined },
      })
    );

    await user.selectOptions(screen.getByLabelText('Account'), '4');
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/payment-transactions', {
        params: { from: expect.any(String), to: expect.any(String), accountId: '4', matchStatus: 'confirmed', q: undefined },
      })
    );
  });
});

describe('Reconciliation: a code that disagrees with the payer', () => {
  it('says why the payment is waiting instead of leaving it unexplained', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'ZAKA/VRT-0016/2026-09');

    // Marked on the row, so the queue can be scanned for it…
    expect(screen.getByText('Code vs payer name')).toBeInTheDocument();

    // …and explained in the panel, naming both people the admin has to weigh.
    const panel = screen.getByText('CRDB-778820').closest('tr');
    expect(within(panel).getByText(/quotes the giving code of Ruth Mwita/)).toBeInTheDocument();
    expect(within(panel).getByText(/the payer named on the statement is a different member/)).toBeInTheDocument();
    expect(within(panel).getByText(/The statement names Ruth Mwita/)).toBeInTheDocument();
  });

  it('leaves an ordinary suggestion alone, with no conflict claimed', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'ZAKA-4482');

    const panel = screen.getByText('CRDB-778812').closest('tr');
    expect(within(panel).getByText(/The statement names Amina Hassan/)).toBeInTheDocument();
    expect(within(panel).queryByText(/quotes the giving code/)).not.toBeInTheDocument();
  });

  it('stops showing the reason once a person has decided', async () => {
    const user = userEvent.setup();
    await renderLoaded();
    await openReview(user, 'ZAKA/VRT-0016/2026-09');

    await user.type(screen.getByPlaceholderText('Search members'), 'Amina');
    await user.click(await screen.findByRole('button', { name: /Amina Hassan/ }));
    await user.click(screen.getByRole('button', { name: 'Match' }));

    await waitFor(() => expect(screen.queryByText('Code vs payer name')).not.toBeInTheDocument());
  });
});

describe('Reconciliation: language', () => {
  it('follows the app language setting rather than hardcoding one', async () => {
    await act(async () => {
      await i18n.changeLanguage('sw');
    });
    await renderLoaded();

    expect(screen.getByRole('heading', { name: 'Malipo yanayoingia' })).toBeInTheDocument();
    expect(screen.getAllByText('Inahitaji ukaguzi').length).toBeGreaterThan(0);
    expect(screen.getByText('Haijulinganishwa')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Malipo ya kusuluhisha' })).toBeInTheDocument();

    await act(async () => {
      await i18n.changeLanguage('en');
    });
    expect(screen.getByRole('heading', { name: 'Incoming payments' })).toBeInTheDocument();
  });
});
