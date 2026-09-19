import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

import GroupDetail from './GroupDetail';
import api from '../api';
import i18n from '../i18n';

vi.mock('../components/AppShell', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  };
});

const GROUP_FAILED = { id: 1, name: 'Harvest Choir', kind: 'choir', description: 'Sings at weddings', is_active: 1 };

const ROSTER = [
  { id: 11, name: 'Asha M', member_no: 'VRT-0001', role: 'leader', center_name: 'Mbezi', zone_name: 'A', phone: '+255700111222', email: 'asha@example.com', is_active: 1 },
  { id: 12, name: 'Baraka J', member_no: 'VRT-0002', role: 'member', center_name: null, zone_name: null, phone: '', email: '', is_active: 1 },
];

function mockGroup({ group = GROUP_FAILED, members = ROSTER } = {}) {
  const leaders = members.filter((m) => m.role !== 'member').length;
  api.get.mockImplementation((url) => {
    if (url === '/groups/1') {
      return Promise.resolve({
        data: { group, members, counts: { total: members.length, leaders, members: members.length - leaders } },
      });
    }
    return Promise.resolve({ data: {} });
  });
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/groups/1']}>
      <Routes>
        <Route path="/groups/:id" element={<GroupDetail />} />
        <Route path="/groups" element={<p>groups list</p>} />
        <Route path="/members" element={<p>members screen</p>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  mockGroup();
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Group detail: the people behind the count', () => {
  it('lists every member with their center and contact details', async () => {
    renderDetail();

    const asha = (await screen.findByText('Asha M')).closest('tr');
    expect(within(asha).getByText('VRT-0001')).toBeInTheDocument();
    expect(within(asha).getByText('Mbezi · A')).toBeInTheDocument();
    expect(within(asha).getByText('+255700111222')).toBeInTheDocument();
    expect(within(asha).getByText('asha@example.com')).toBeInTheDocument();

    // A member with no center or contact says so rather than rendering blanks,
    // and stays on the list: the roster is everyone, not only the complete rows.
    const baraka = screen.getByText('Baraka J').closest('tr');
    expect(within(baraka).getAllByText('None').length).toBe(2);
  });

  it('chips a leader and leaves a plain member unchipped', async () => {
    renderDetail();

    const asha = (await screen.findByText('Asha M')).closest('tr');
    expect(within(asha).getByText('Leader')).toHaveClass('cat-chip');

    const baraka = screen.getByText('Baraka J').closest('tr');
    const roleCell = within(baraka).getByText('Member');
    expect(roleCell.className).not.toContain('cat-chip');
  });

  it('shows the headcounts derived from the roster', async () => {
    renderDetail();

    // One leader, one plain member, two in total: read from the API's counts.
    expect(await screen.findByText('Leaders')).toBeInTheDocument();
    const tiles = [...document.querySelectorAll('.tile')].map((t) => t.textContent);
    expect(tiles.some((x) => x.includes('Members') && x.includes('2'))).toBe(true);
    expect(tiles.some((x) => x.includes('Leaders') && x.includes('1'))).toBe(true);
  });

  it('offers no way to change membership from here', async () => {
    renderDetail();

    await screen.findByText('Asha M');
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /add member/i })).toBeNull();
    expect(screen.queryByPlaceholderText(/search members/i)).toBeNull();
  });

  it('says where membership is set when the roster is empty', async () => {
    mockGroup({ members: [] });
    renderDetail();

    expect(await screen.findByText('Nobody is in this group yet.')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Assign members' });
    expect(link).toHaveAttribute('href', '/members');
  });

  it('leads back to the list', async () => {
    renderDetail();

    expect(await screen.findByRole('link', { name: 'All groups' })).toHaveAttribute('href', '/groups');
  });
});
