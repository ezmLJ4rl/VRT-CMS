import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import Reports from './Reports';
import api from '../api';
import i18n from '../i18n';

vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});

const SUMMARY = {
  attendance: { sessions: 3, people: 120, service_types: 2 },
  rehearsals: { sessions: 0, people: 0 },
  offerings: { gifts: 5, total: 202000 },
};

// The payment breakdown is the one breakdown the server keys by the STORED
// value rather than by a label: it has no interface language of its own, and the
// reader's is chosen on screen.
const PAYMENT = {
  breakdown: [
    { key: 'mobile_money', gifts: 3, amount: 150000 },
    { key: 'cash', gifts: 1, amount: 50000 },
    { key: null, gifts: 1, amount: 2000 },
  ],
};

const BREAKDOWNS = { payment: PAYMENT, service: { breakdown: [], rehearsals: [] } };

function mockApi() {
  api.get.mockImplementation((url, config) => {
    if (url === '/reports/summary') return Promise.resolve({ data: SUMMARY });
    if (url === '/reports/breakdown') {
      const found = BREAKDOWNS[config.params.groupBy];
      return Promise.resolve({ data: found || { breakdown: [] } });
    }
    if (url === '/reports/service-trends') return Promise.resolve({ data: { services: [] } });
    if (url === '/attendance') return Promise.resolve({ data: { attendance: [] } });
    if (url === '/offerings') {
      return Promise.resolve({
        data: {
          offerings: [
            { id: 1, payment_method: 'mobile_money', payment_reference: 'MP240916001', amount: 50000, currency: 'TZS' },
          ],
        },
      });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

async function renderLoaded(heading = 'By payment method') {
  render(<Reports />);
  await screen.findByRole('heading', { name: heading });
  // The rows arrive with the response, after the page has drawn its own titles,
  // and every test below reads a row. Waiting for them here is what keeps these
  // tests about behaviour rather than about how loaded the machine is.
  await screen.findAllByRole('row');
}

// A row of the breakdown table, found by the value in it rather than by row
// order, so adding a method cannot silently re-point the assertion.
function rowWith(text) {
  return screen.getAllByRole('row').find((r) => r.textContent.includes(text));
}

beforeEach(mockApi);

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Reports: giving by payment method', () => {
  it('asks the server for the payment breakdown like every other one', async () => {
    await renderLoaded();

    expect(api.get).toHaveBeenCalledWith('/reports/breakdown', {
      params: { from: expect.any(String), to: expect.any(String), groupBy: 'payment' },
    });
  });

  it('shows each method with its total, and unrecorded money as its own line', async () => {
    await renderLoaded();

    expect(screen.getAllByText('Mobile money').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Cash').length).toBeGreaterThan(0);
    // Not "cash": the server sends a null key for gifts whose method nobody
    // recorded, and the page names that state instead of hiding or folding it.
    expect(screen.getAllByText('Not recorded').length).toBeGreaterThan(0);

    expect(rowWith('Mobile money').textContent).toContain('150,000');
    expect(rowWith('Not recorded').textContent).toContain('2,000');
  });

  it('names the methods in the reader\'s language', async () => {
    await act(async () => {
      await i18n.changeLanguage('sw');
    });
    await renderLoaded('Kwa njia ya malipo');

    expect(screen.getByRole('heading', { name: 'Kwa njia ya malipo' })).toBeInTheDocument();
    // The rows arrive after the heading does, so these wait for them rather than
    // reading the table the instant the page has drawn its own titles.
    expect((await screen.findAllByText('Pesa za simu')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Fedha taslimu')).length).toBeGreaterThan(0);
  });

  it('drills into one method\'s records, filtered by that method', async () => {
    const user = userEvent.setup();
    await renderLoaded();

    await user.click(rowWith('Mobile money'));

    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/offerings', {
        params: { from: expect.any(String), to: expect.any(String), paymentMethod: 'mobile_money' },
      })
    );
    // The drill-down is the same records screen every other breakdown opens, and
    // it names how each gift was paid.
    expect(await screen.findByRole('heading', { name: 'Records' })).toBeInTheDocument();
    await waitFor(() => expect(rowWith('50,000').textContent).toContain('Mobile money'));
  });
});
