import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import ProjectDetail from './ProjectDetail';
import api from '../api';
import i18n from '../i18n';

// The shell brings the router, auth context and nav: none of which these rules
// touch, and all of which would need their own stubs.
vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } };
});

const PROJECT = {
  project: {
    id: 7,
    name: 'Ujenzi wa Ukuta',
    description: 'Perimeter wall for the Mbezi Juu plot',
    status: 'active',
    startedOn: '2026-01-05',
    targetOn: '2026-12-20',
    currency: 'TZS',
    goalAmount: 1000000,
  },
  canEdit: true,
  giftCount: 2,
  // Raised 600,000 of a 1,000,000 goal; 300,000 pledged with 120,000 received;
  // 150,000 spent and 200,000 still owed.
  summary: {
    currency: 'TZS',
    goalAmount: 1000000,
    raised: 600000,
    remainingToGoal: 400000,
    fundedPct: 60,
    pledged: 300000,
    pledgeFulfilled: 120000,
    pledgeOutstanding: 180000,
    pledgePct: 40,
    spent: 150000,
    owed: 200000,
    netPosition: 250000,
    netRemainingNeed: 600000,
  },
  timeline: { today: '2026-09-14', startedOn: '2026-01-05', targetOn: '2026-12-20', totalDays: 349, elapsedDays: 252, remainingDays: 97, elapsedPct: 72.2, overdue: false },
  contributors: [
    { key: 'm:1', name: 'Elisha Makala', member: true, times: 3, total: 400000, lastDate: '2026-09-01' },
    { key: 'n:anonymous', name: null, member: false, times: 1, total: 200000, lastDate: '2026-08-01' },
  ],
  contributions: [
    { id: 1, amount: 400000, currency: 'TZS', date: '2026-09-01', service: '1st Sunday Service', memberName: 'Elisha Makala', giverName: 'Elisha Makala', giverNameUnavailable: false },
    { id: 2, amount: 200000, currency: 'TZS', date: '2026-08-01', service: '1st Sunday Service', memberName: null, giverName: null, giverNameUnavailable: false },
    { id: 3, amount: 50000, currency: 'TZS', date: '2026-08-01', service: '1st Sunday Service', memberName: null, giverName: null, giverNameUnavailable: true },
  ],
  monthly: [{ label: '2026-08', value: 250000 }, { label: '2026-09', value: 400000 }],
  otherCurrencies: [],
  pledges: [
    { id: 3, memberId: null, memberName: null, pledgeName: 'Neema Joseph', amount: 300000, fulfilledAmount: 120000, outstanding: 180000, fulfilmentPct: 40, currency: 'TZS', pledgedOn: '2026-08-10', status: 'open' },
  ],
  debts: [
    { id: 9, description: 'Cement supplier, final batch', amount: 200000, currency: 'TZS', status: 'outstanding', incurredOn: '2026-08-20', paidOn: null },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/7']}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(async () => {
  api.get.mockResolvedValue({ data: PROJECT });
  api.patch.mockResolvedValue({ data: { success: true } });
  api.post.mockResolvedValue({ data: { id: 1 } });
  api.delete.mockResolvedValue({ data: { success: true } });
  await i18n.changeLanguage('en');
});

describe('project detail: what the numbers mean', () => {
  it('shows funding and pledge fulfilment as two separate indicators', async () => {
    renderPage();
    expect(await screen.findByText('Ujenzi wa Ukuta')).toBeInTheDocument();

    // One bar measures money received against the goal…
    const funding = screen.getByRole('progressbar', { name: /Received/ });
    expect(funding).toHaveAttribute('aria-valuenow', '60');

    // …the other measures promises actually honoured. They must never be the
    // same number: 600,000 received is not 300,000 pledged.
    const fulfilment = screen.getByRole('progressbar', { name: /Promises honoured/ });
    expect(fulfilment).toHaveAttribute('aria-valuenow', '40');
    expect(funding.getAttribute('aria-valuenow')).not.toBe(fulfilment.getAttribute('aria-valuenow'));
  });

  it('states the health of the project: net position and what is still needed', async () => {
    renderPage();
    expect(await screen.findByText('Ujenzi wa Ukuta')).toBeInTheDocument();

    // raised − spent − owed, and the shortfall plus the debts to clear.
    expect(screen.getByText(/Net position 250,000 TZS/)).toBeInTheDocument();
    const stillNeeded = screen.getByText('Still needed').closest('div');
    expect(within(stillNeeded).getByText('600,000 TZS')).toBeInTheDocument(); // 400,000 short of goal + 200,000 owed
    expect(screen.getByText(/300,000 TZS pledged in total/)).toBeInTheDocument();
    expect(screen.getByText(/180,000 TZS is still to come/)).toBeInTheDocument();
  });

  it('flags a giver whose name could not be read, rather than calling them anonymous', async () => {
    renderPage();
    expect(await screen.findByText('Ujenzi wa Ukuta')).toBeInTheDocument();

    expect(screen.getByText('Name unavailable')).toBeInTheDocument();
    // The genuinely unnamed gifts still read as anonymous: the two states are
    // rendered differently, which is the whole point.
    expect(screen.getAllByText('Anonymous').length).toBeGreaterThan(0);
  });

  it('rolls repeat contributors up by person', async () => {
    renderPage();
    expect(await screen.findByText('Ujenzi wa Ukuta')).toBeInTheDocument();
    expect(screen.getByText('3 gift(s) to this project')).toBeInTheDocument();
  });
});

describe('project detail: editing', () => {
  it('records a payment against a pledge without touching the raised total', async () => {
    const u = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Ujenzi wa Ukuta')).toBeInTheDocument();

    // The payment field sits on the pledge row, above the add-pledge form.
    await u.type(screen.getAllByPlaceholderText('Amount')[0], '50000');
    await u.click(screen.getByRole('button', { name: /Record payment/ }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/projects/7/pledges/3', { addFulfilled: 50000 }));
    expect(api.patch).not.toHaveBeenCalledWith('/projects/7', expect.anything());
  });

  it('settles a debt by flipping its status', async () => {
    const u = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Ujenzi wa Ukuta')).toBeInTheDocument();

    await u.click(screen.getByRole('button', { name: /Mark paid/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/projects/7/debts/9', { status: 'paid' }));
  });

  // Interaction-heavy; starves past 5s only under the full parallel run
  // (passes in isolation): same treatment as the other heavy tests.
  it('adds a pledge against the project', { timeout: 15000 }, async () => {
    const u = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Ujenzi wa Ukuta')).toBeInTheDocument();

    await u.type(screen.getByPlaceholderText('Pledger name'), 'Elizabeth Makala');
    // [0] is the pledge payment field, [1] the add-pledge amount, [2] the debt amount.
    await u.type(screen.getAllByPlaceholderText('Amount')[1], '150000');
    await u.click(screen.getByRole('button', { name: /Add pledge/ }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/projects/7/pledges', expect.objectContaining({ name: 'Elizabeth Makala', amount: 150000 }))
    );
  });
});
