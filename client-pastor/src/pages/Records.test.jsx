import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';

import Records from './Records';
import api from '../api';
import i18n from '../i18n';

// The HTTP client is the only thing faked; apiErrorMessage stays real so the
// page's own error handling is exercised.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { get: vi.fn(), patch: vi.fn(), post: vi.fn() } };
});

const TYPES = [{ id: 3, name: '1st Sunday Service', is_active: 1 }];

const ATTENDANCE = [
  { id: 1, service_id: 10, service_type_id: 3, service_type_name: '1st Sunday Service', sub_session_name: 'Main Service', total: 40, service_date: '2026-09-13' },
  { id: 2, service_id: 11, service_type_id: 3, service_type_name: '1st Sunday Service', sub_session_name: 'Main Service', total: 35, service_date: '2026-09-20' },
];

// Real rows, with the detail the API sends alongside the method: the giver
// (decrypted for a pastor) and the reference the desk wrote down.
const OFFERINGS = [
  { id: 1, service_id: 10, service_type_id: 3, service_name: '1st Sunday Service', service_date: '2026-09-13', category_key: 'zaka', category_name: 'Zaka (Tithe)', amount: 50000, currency: 'TZS', receipt: 'VR-2026-0001', payment_method: 'cash', payment_reference: null, offererName: 'Ruth Mwita' },
  { id: 2, service_id: 10, service_type_id: 3, service_name: '1st Sunday Service', service_date: '2026-09-13', category_key: 'zaka', category_name: 'Zaka (Tithe)', amount: 30000, currency: 'TZS', receipt: 'VR-2026-0002', payment_method: 'mobile_money', payment_reference: 'MP240916001', offererName: 'Peter Sanga' },
  { id: 3, service_id: 10, service_type_id: 3, service_name: '1st Sunday Service', service_date: '2026-09-13', category_key: 'general', category_name: 'Service offering', amount: 20000, currency: 'TZS', receipt: 'VR-2026-0003', payment_method: 'cash', payment_reference: null, offererName: null },
  { id: 4, service_id: 11, service_type_id: 3, service_name: '1st Sunday Service', service_date: '2026-09-20', category_key: 'zaka', category_name: 'Zaka (Tithe)', amount: 100000, currency: 'TZS', receipt: 'VR-2026-0004', payment_method: 'bank', payment_reference: 'CRDB-8891', offererName: 'Grace Mushi' },
];

// The mock applies the query the way the API does: period and service type,
// because a mock that returns everything regardless would make a day and a month
// look identical and hide exactly the bug this screen could have.
function mockApi({ attendance = ATTENDANCE, offerings = OFFERINGS } = {}) {
  api.get.mockImplementation((url, options = {}) => {
    if (url === '/service-types') return Promise.resolve({ data: { serviceTypes: TYPES } });
    const { params = {} } = options;
    const inRange = (date) => (!params.from || date >= params.from) && (!params.to || date <= params.to);
    const forType = (row) => !params.serviceTypeId || String(row.service_type_id) === String(params.serviceTypeId);
    if (url === '/attendance') {
      return Promise.resolve({ data: { attendance: attendance.filter((a) => inRange(a.service_date) && forType(a)) } });
    }
    if (url === '/offerings') {
      return Promise.resolve({ data: { offerings: offerings.filter((o) => inRange(o.service_date) && forType(o)) } });
    }
    return Promise.resolve({ data: {} });
  });
}

const card = () => screen.getByRole('heading', { name: /How giving came in/ }).closest('section');
const rowFor = (label) => within(card()).getByText(label).closest('li');
// Method label of a row: the li leads with the method, then its gift count.
const labelOf = (li) => li.firstElementChild.firstElementChild.textContent;

// The page opens on today, which the fixtures are not dated, so every test
// sets the dates it means and waits for the fetch that follows. Inputs are found
// by id, not by label: the labels translate, and a Kiswahili test must still be
// able to drive the same screen.
async function showRange(from, to) {
  fireEvent.change(document.getElementById('rec-from'), { target: { value: from } });
  fireEvent.change(document.getElementById('rec-to'), { target: { value: to } });
  await waitFor(() => {
    const last = api.get.mock.calls.filter(([url]) => url === '/offerings').at(-1);
    expect(last[1].params).toMatchObject({ from, to });
  });
}

beforeEach(() => {
  mockApi();
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Records: how giving came in', () => {
  it("shows the day's split beside the day's records", async () => {
    render(<Records />);
    await showRange('2026-09-13', '2026-09-13');

    expect(within(card()).getByRole('heading', { name: /How giving came in/ })).toBeInTheDocument();
    expect(within(rowFor('Cash')).getByText('70,000 TZS')).toBeInTheDocument();
    expect(within(rowFor('Mobile money')).getByText('30,000 TZS')).toBeInTheDocument();
    // A method no gift used is left out rather than shown as zero: the church
    // banked nothing that day, and a 0 would read as "banked, and nothing came".
    expect(within(card()).queryByText('Bank transfer')).not.toBeInTheDocument();
  });

  it('totals the whole range when a month is selected, not just one day', async () => {
    render(<Records />);
    await showRange('2026-09-01', '2026-09-30');

    // Both Sundays: 50,000 + 20,000 cash, 30,000 mobile money, 100,000 bank.
    expect(within(rowFor('Cash')).getByText('70,000 TZS')).toBeInTheDocument();
    expect(within(rowFor('Mobile money')).getByText('30,000 TZS')).toBeInTheDocument();
    expect(within(rowFor('Bank transfer')).getByText('100,000 TZS')).toBeInTheDocument();
  });

  it('agrees with the header total for the same period', async () => {
    render(<Records />);
    await showRange('2026-09-13', '2026-09-13');

    const cardTotal = within(card())
      .getAllByRole('listitem')
      .reduce((sum, li) => sum + Number(li.textContent.match(/([\d,]+) TZS/)[1].replace(/,/g, '')), 0);
    expect(cardTotal).toBe(100000);
    // 50,000 + 30,000 + 20,000 recorded that day, as the screen's own chip says.
    expect(screen.getByText('100,000 TZS')).toBeInTheDocument();
  });

  it('follows the service filter, so the split covers the gifts on screen', async () => {
    render(<Records />);
    await showRange('2026-09-01', '2026-09-30');

    fireEvent.change(document.getElementById('rec-svc'), { target: { value: '3' } });

    await waitFor(() => {
      const last = api.get.mock.calls.filter(([url]) => url === '/offerings').at(-1);
      expect(last[1].params).toMatchObject({ from: '2026-09-01', to: '2026-09-30', serviceTypeId: '3' });
    });
  });

  it('shows the split for a whole month with the same methods, in the same order', async () => {
    render(<Records />);
    await showRange('2026-09-01', '2026-09-30');

    const labels = within(card()).getAllByRole('listitem').map(labelOf);
    expect(labels).toEqual(['Cash', 'Mobile money', 'Bank transfer']);
  });

  it('names a gift whose method nobody recorded, and keeps it out of cash', async () => {
    mockApi({ offerings: [...OFFERINGS.slice(0, 3), { ...OFFERINGS[2], id: 9, amount: 7000, payment_method: null }] });
    render(<Records />);
    await showRange('2026-09-13', '2026-09-13');

    expect(within(rowFor('Not recorded')).getByText('7,000 TZS')).toBeInTheDocument();
    expect(within(rowFor('Cash')).getByText('70,000 TZS')).toBeInTheDocument();
  });

  it('exposes no payment reference with the totals', async () => {
    render(<Records />);
    await showRange('2026-09-13', '2026-09-13');

    // The reference (a mobile-money code) and the giver names travel with these
    // rows; how the money arrived does not need either of them.
    expect(screen.queryByText('MP240916001')).not.toBeInTheDocument();
    expect(within(card()).queryByText('Ruth Mwita')).not.toBeInTheDocument();
    expect(within(card()).queryByText('Peter Sanga')).not.toBeInTheDocument();
  });

  it('says the period recorded no giving rather than leaving the card out', async () => {
    mockApi({ offerings: [] });
    render(<Records />);
    await showRange('2026-09-01', '2026-09-30');

    expect(within(card()).getByText('No offerings recorded in this period.')).toBeInTheDocument();
  });

  it('renders the methods in Kiswahili for a Kiswahili reader', async () => {
    await i18n.changeLanguage('sw');
    render(<Records />);
    await showRange('2026-09-13', '2026-09-13');

    const sw = screen.getByRole('heading', { name: 'Sadaka zilivyolipwa' }).closest('section');
    expect(within(within(sw).getByText('Fedha taslimu').closest('li')).getByText('70,000 TZS')).toBeInTheDocument();
    expect(within(sw).getByText('Jumla kwa jinsi kila sadaka ilivyolipwa. Sadaka ambazo njia ya malipo haikurekodiwa zimeorodheshwa peke yake. Hazidhaniwi kuwa fedha taslimu.')).toBeInTheDocument();
  });
});
