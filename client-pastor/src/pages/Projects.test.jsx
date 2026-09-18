import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Projects from './Projects';
import ProjectDetail from './ProjectDetail';
import api from '../api';
import i18n from '../i18n';

// Only the HTTP client is faked, so the pages render through their real code.
vi.mock('../api', () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  apiErrorMessage: (err, fallback) => err?.response?.data?.error || fallback,
  API_BASE: '',
}));

const LIST = [
  {
    id: 7,
    name: 'Ujenzi wa Ukuta',
    status: 'active',
    currency: 'TZS',
    goalAmount: 1000000,
    raised: 600000,
    fundedPct: 60,
    pledged: 300000,
    owed: 200000,
    netPosition: 250000,
  },
  {
    id: 8,
    name: 'Roof repairs',
    status: 'on_hold',
    currency: 'TZS',
    goalAmount: 0,
    raised: 0,
    fundedPct: null,
    pledged: 0,
    owed: 0,
    netPosition: 0,
  },
];

const DETAIL = {
  project: { id: 7, name: 'Ujenzi wa Ukuta', description: 'Perimeter wall', status: 'active', currency: 'TZS', goalAmount: 1000000, startedOn: '2026-01-05', targetOn: '2026-12-20' },
  canEdit: false,
  giftCount: 1,
  summary: {
    currency: 'TZS', goalAmount: 1000000, raised: 600000, remainingToGoal: 400000, fundedPct: 60,
    pledged: 300000, pledgeFulfilled: 120000, pledgeOutstanding: 180000, pledgePct: 40,
    spent: 150000, owed: 200000, netPosition: 250000, netRemainingNeed: 600000,
  },
  timeline: { today: '2026-09-14', startedOn: '2026-01-05', targetOn: '2026-12-20', totalDays: 349, elapsedDays: 252, remainingDays: 97, elapsedPct: 72.2, overdue: false },
  contributors: [{ key: 'm:1', name: 'Elisha Makala', member: true, times: 3, total: 600000, lastDate: '2026-09-01' }],
  contributions: [{ id: 1, amount: 600000, currency: 'TZS', date: '2026-09-01', service: '1st Sunday Service', giverName: 'Elisha Makala', giverNameUnavailable: false }],
  monthly: [{ label: '2026-09', value: 600000 }],
  otherCurrencies: [],
  pledges: [{ id: 3, pledgeName: 'Neema Joseph', memberName: null, amount: 300000, fulfilledAmount: 120000, outstanding: 180000, fulfilmentPct: 40, currency: 'TZS', pledgedOn: '2026-08-10', status: 'open' }],
  debts: [{ id: 9, description: 'Cement supplier', amount: 200000, currency: 'TZS', status: 'outstanding' }],
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('pastor projects: reading progress', () => {
  it('lists each project with its funding progress', async () => {
    api.get.mockResolvedValue({ data: { projects: LIST } });
    render(
      <MemoryRouter>
        <Projects />
      </MemoryRouter>
    );

    expect(await screen.findByText('Ujenzi wa Ukuta')).toBeInTheDocument();
    expect(screen.getByText('600,000 TZS / 1,000,000 TZS')).toBeInTheDocument();
    expect(screen.getByText('60% of the goal')).toBeInTheDocument();

    // A project with no goal is stated, not divided by zero.
    expect(screen.getByText('No funding goal set')).toBeInTheDocument();
  });

  it('offers no way to change anything from the list', async () => {
    api.get.mockResolvedValue({ data: { projects: LIST } });
    render(
      <MemoryRouter>
        <Projects />
      </MemoryRouter>
    );
    await screen.findByText('Ujenzi wa Ukuta');

    // Read-only is a promise, not a comment: no buttons at all on this screen.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the project’s progress, pledges and ledger without editing controls', async () => {
    api.get.mockResolvedValue({ data: DETAIL });
    render(
      <MemoryRouter initialEntries={['/projects/7']}>
        <ProjectDetail />
      </MemoryRouter>
    );

    expect(await screen.findByText('Ujenzi wa Ukuta')).toBeInTheDocument();

    // Received, promised and owed are three separate figures, each on its own
    // tile rather than merged into one optimistic total.
    expect(screen.getByText('Received so far')).toBeInTheDocument();
    expect(screen.getByText('Pledged, not yet paid')).toBeInTheDocument();
    expect(screen.getByText('Owed')).toBeInTheDocument();
    const raisedTile = screen.getByText('Received so far').closest('div');
    expect(raisedTile.textContent).toContain('600,000 TZS');

    // Two distinct indicators, never the same number.
    const bars = screen.getAllByRole('progressbar');
    expect(bars[0]).toHaveAttribute('aria-valuenow', '60');
    expect(bars[1]).toHaveAttribute('aria-valuenow', '40');

    // Contributors and their names are visible to the pastor (in the roll-up and
    // again on the ledger row).
    expect(screen.getAllByText('Elisha Makala').length).toBeGreaterThan(0);
    expect(screen.getByText('3 gift(s)')).toBeInTheDocument();

    // …but nothing here is actionable.
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Add pledge/)).toBeNull();
    expect(screen.queryByText(/Record payment/)).toBeNull();
    expect(screen.queryByText(/Add debt/)).toBeNull();
  });

  it('says so plainly when a project cannot be loaded', async () => {
    api.get.mockRejectedValue(new Error('offline'));
    render(
      <MemoryRouter initialEntries={['/projects/7']}>
        <ProjectDetail />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Could not load the projects/)).toBeInTheDocument();
  });
});
