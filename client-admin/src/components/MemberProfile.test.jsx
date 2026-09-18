import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import MemberProfile from './MemberProfile';
import api from '../api';
import i18n from '../i18n';

// Only the HTTP client is faked; the panel's own rendering is what is under test.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { get: vi.fn() } };
});

const MEMBER = {
  id: 5,
  member_no: 'VRT-0005',
  name: 'Neema K',
  phone: '+255700000005',
  email: '',
  is_active: 1,
  center_name: 'Mbezi',
  zone_name: 'Zone A',
  date_joined: '2026-01-04',
};

const SEED_NOTE = 'Sample giving data (scripts/sample-giving.js)';

function payload(member) {
  return {
    member,
    groups: [
      { id: 2, name: 'WWK', has_logo: false, role: 'leader' },
      { id: 3, name: 'Ushirika', has_logo: false, role: 'member' },
    ],
    stats: { attendance: { sessions: 3, total: 42 }, offerings: { gifts: 4, total: 250000 } },
    history: {
      attendance: [
        { id: 31, date: '2026-09-06', service_name: '1st Sunday Service', service_type_name: '1st Sunday Service', group_name: 'WWK', count: 42 },
        { id: 32, date: '2026-08-30', service_name: 'Wednesday Service', service_type_name: 'Midweek', group_name: null, count: 18 },
      ],
      offerings: [
        { id: 71, timestamp: '2026-09-06 11:20:00', type: 'zaka', amount: 1300000, currency: 'TZS', receipt_number: 'VR-2026-0012', category_name: 'Zaka (Tithe)', service_date: '2026-09-06' },
        { id: 72, timestamp: '2026-08-02 11:40:00', type: 'special', amount: 900000, currency: 'TZS', receipt_number: null, category_name: 'Special Offering', service_date: '2026-08-02' },
      ],
    },
  };
}

beforeEach(async () => {
  // The default payload for every test that does not override it. Re-asserting
  // the language first matters: a previous test may have left Kiswahili active
  // and react-i18next's `t` would then resolve the plural keys against sw.
  await i18n.changeLanguage('en');
  api.get.mockResolvedValue({ data: payload(MEMBER) });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('MemberProfile: the header renders once', () => {
  it('shows the name, ID, status badge, center, phone and joined date in one block', async () => {
    render(<MemberProfile memberId={5} />);

    // Exactly one of each: the header is not repeated below itself.
    expect(await screen.findAllByText('Neema K')).toHaveLength(1);
    expect(screen.getAllByText('VRT-0005')).toHaveLength(1);
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Mbezi · Zone A')).toBeInTheDocument();
    expect(screen.getByText('+255700000005')).toBeInTheDocument();
    expect(screen.getByText(/Joined/)).toBeInTheDocument();
    expect(screen.getByText(/4 Jan 2026/)).toBeInTheDocument();
  });

  it('never shows the giving-code explanation as permanent text', async () => {
    render(<MemberProfile memberId={5} />);

    await screen.findByText('Neema K');
    // The explanation now lives in the tooltip (hidden until hover/focus), not
    // as a paragraph in the page flow: nothing VISIBLE may carry it at rest.
    const tooltip = screen.getByText(/Members quote it when they pay/);
    expect(tooltip).toHaveClass('hidden');
    // ...and the info button that carries it is labelled for screen readers.
    expect(screen.getByRole('button', { name: 'What is a giving code?' })).toBeInTheDocument();
  });

  it('reveals the giving-code explanation on focus and hides it again', async () => {
    const user = userEvent.setup();
    render(<MemberProfile memberId={5} />);

    await screen.findByText('Neema K');
    const info = screen.getByRole('button', { name: 'What is a giving code?' });
    const tooltip = screen.getByText(/Giving code VRT-0005\. Members quote it when they pay/);
    expect(tooltip).toHaveClass('hidden');

    // Focus (keyboard or tap) shows it, blur hides it — the CSS is
    // group-hover/group-focus, and jsdom cannot fire a real hover, so the
    // keyboard path is the one under test here.
    await act(async () => {
      info.focus();
    });
    expect(tooltip).toHaveClass('group-focus:block');

    await user.tab();
    expect(info).not.toHaveFocus();
  });

  it('says the same in Kiswahili', async () => {
    const user = userEvent.setup();
    render(<MemberProfile memberId={5} />);
    await screen.findByText('Neema K');

    await act(async () => {
      await i18n.changeLanguage('sw');
    });
    const info = screen.getByRole('button', { name: 'Msimbo wa kutoa ni nini?' });
    await user.hover(info);
    expect(screen.getByText(/Msimbo wa kutoa VRT-0005/)).toBeInTheDocument();
  });

  it('claims nothing for a member who has no number', async () => {
    // Should be impossible, the form allocates one and the boot migration fills
    // in the rest, but an empty code must not become an empty promise.
    api.get.mockResolvedValue({ data: payload({ ...MEMBER, member_no: null }) });
    render(<MemberProfile memberId={5} />);

    expect(await screen.findByText('Neema K')).toBeInTheDocument();
    expect(screen.queryByText(/Giving code/)).not.toBeInTheDocument();
  });
});

describe('MemberProfile: the attendance card describes one person', () => {
  it('counts sessions attended, not a headcount of people', async () => {
    render(<MemberProfile memberId={5} />);

    await screen.findByText('Neema K');
    expect(screen.getByText('3 sessions in the last 90 days')).toBeInTheDocument();
    expect(screen.queryByText(/people/)).not.toBeInTheDocument();
  });

  it('reads correctly in Kiswahili too', async () => {
    render(<MemberProfile memberId={5} />);
    await screen.findByText('Neema K');

    await act(async () => {
      await i18n.changeLanguage('sw');
    });
    expect(screen.getByText('Vikao 3 katika siku 90 zilizopita')).toBeInTheDocument();
  });
});

describe('MemberProfile: seeded sample data never leaks into the page', () => {
  it('hides the seed script marker that the seeder writes into notes', async () => {
    api.get.mockResolvedValue({ data: payload({ ...MEMBER, notes: SEED_NOTE }) });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    render(<MemberProfile memberId={5} />);

    await screen.findByText('Neema K');
    expect(screen.queryByText(/Sample giving data/)).not.toBeInTheDocument();
    expect(screen.queryByText(/scripts\/sample-giving\.js/)).not.toBeInTheDocument();

    // Development only: the marker is reported to whoever is developing, not
    // to whoever is reading.
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it('hides the trends seeder marker too', async () => {
    api.get.mockResolvedValue({
      data: payload({ ...MEMBER, notes: 'Sample member: Mbezi — Written by scripts/sample-trends.js for chart verification.' }),
    });
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    render(<MemberProfile memberId={5} />);

    await screen.findByText('Neema K');
    expect(screen.queryByText(/sample-trends/)).not.toBeInTheDocument();
    info.mockRestore();
  });

  it('keeps a note a human actually wrote', async () => {
    api.get.mockResolvedValue({ data: payload({ ...MEMBER, notes: 'Prefers the 8am service; tithes by standing order.' }) });
    render(<MemberProfile memberId={5} />);

    await screen.findByText('Neema K');
    expect(screen.getByText('Prefers the 8am service; tithes by standing order.')).toBeInTheDocument();
  });
});

describe('MemberProfile: the giving history table', () => {
  it('keeps date, type, receipt and amount in separate columns', async () => {
    render(<MemberProfile memberId={5} />);

    await screen.findByText('Neema K');
    // Two tables are on the panel (attendance and giving); pick the one whose
    // headers say this is the giving history.
    const table = screen
      .getAllByRole('table')
      .find((t) => [...t.querySelectorAll('th')].some((th) => th.textContent === 'Amount'));
    const headers = [...table.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toEqual(['Date', 'Type', 'Receipt', 'Amount']);

    // Each column holds only its own value: the date is a date, the type a type.
    const firstRow = table.querySelectorAll('tbody tr')[0];
    const cells = [...firstRow.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells[0]).toBe('6 Sept 2026');
    expect(cells[1]).toBe('Zaka (Tithe)');
    expect(cells[2]).toBe('VR-2026-0012');
    expect(cells[3]).toBe('1,300,000 TZS');
  });

  it('never truncates an amount, however large', async () => {
    render(<MemberProfile memberId={5} />);

    await screen.findByText('Neema K');
    expect(screen.getByText('1,300,000 TZS')).toBeInTheDocument();
    expect(screen.getByText('900,000 TZS')).toBeInTheDocument();
  });

  it('falls back to the en dash, never a blank cell', async () => {
    render(<MemberProfile memberId={5} />);

    await screen.findByText('Neema K');
    // EMPTY_VALUE (see src/emptyValue.js): the shared "no value" glyph, shown
    // for the gift without a receipt number rather than an empty cell.
    expect(screen.getAllByText('–').length).toBeGreaterThan(0);
  });
});
