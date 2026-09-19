import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Messages from './Messages';
import api from '../api';
import i18n from '../i18n';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { get: vi.fn(), post: vi.fn(), patch: vi.fn() } };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, name: 'Reverend Pastor', role: 'pastor' }, loading: false }),
}));

vi.mock('../context/UnreadContext', () => ({
  useUnread: () => ({ messages: 0, emergencies: 0, refresh: vi.fn() }),
}));

function renderMessages(broadcasts) {
  api.get.mockImplementation((url) => {
    if (url === '/messages') return Promise.resolve({ data: { conversations: { threads: [], broadcasts } } });
    return Promise.resolve({ data: { messages: [] } });
  });
  return render(
    <MemoryRouter initialEntries={['/messages']}>
      <Messages />
    </MemoryRouter>
  );
}

const groupRosterNotice = (extra = {}) => ({
  id: 7,
  subject: 'Group update: WWK',
  body: 'WWK · Bahati Yunus Mkwizu added',
  payload: {
    group: { id: 5, name: 'WWK' },
    changes: [{ action: 'added', name: 'Bahati Yunus Mkwizu' }],
    url: '/groups/5',
  },
  read_at: null,
  sent_at: new Date().toISOString(),
  ...extra,
});

beforeEach(() => {
  api.patch.mockResolvedValue({ data: {} });
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Pastor Messages notification taxonomy', () => {
  it('does not show routine group membership changes', async () => {
    renderMessages([groupRosterNotice()]);

    expect(await screen.findByRole('heading', { name: 'Messages' })).toBeInTheDocument();
    expect(screen.queryByText('WWK')).toBeNull();
    expect(screen.queryByText(/Bahati Yunus Mkwizu/)).toBeNull();
    expect(screen.queryByRole('button', { name: /view group/i })).toBeNull();
  });

  it('also hides legacy group-update rows identified by their record type', async () => {
    renderMessages([groupRosterNotice({ payload: null, record_type: 'group_update', body: 'WWK · 2 members' })]);

    await screen.findByRole('heading', { name: 'Messages' });
    expect(screen.queryByText(/WWK/)).toBeNull();
    expect(screen.queryByText(/members/)).toBeNull();
  });

  it('keeps attendance and offering digests in the canonical feed', async () => {
    renderMessages([{
      id: 9,
      subject: 'Today’s summary from the front desk',
      body: 'digest',
      payload: {
        date: '2026-09-14',
        totalOfferings: 5000,
        currency: 'TZS',
        attendance: [{ id: 1, label: 'Sunday Service', mode: 'headcount', count: 44, attendees: [] }],
        offerings: [],
      },
      read_at: null,
      sent_at: new Date().toISOString(),
    }]);

    expect(await screen.findByText(/44 attendance · 5,000 TZS/)).toBeInTheDocument();
    expect(screen.getByText('14 Sept 2026')).toBeInTheDocument();
    expect(screen.queryByText('Asha')).toBeNull();
  });

  it('merges legacy partial digests for the same date into one card', async () => {
    renderMessages([
      {
        id: 11,
        subject: 'Today’s summary from the front desk',
        body: 'attendance only',
        payload: { date: '2026-09-18', totalOfferings: 0, currency: 'TZS', attendance: [{ id: 11, label: '1st Sunday Service', typeName: '1st Sunday Service', count: 44, mode: 'headcount', attendees: [] }], offerings: [] },
        read_at: null,
        sent_at: new Date().toISOString(),
      },
      {
        id: 12,
        subject: 'Today’s summary from the front desk',
        body: 'offering only',
        payload: { date: '2026-09-18', totalOfferings: 4699900, currency: 'TZS', attendance: [], offerings: [{ id: 12, category: 'Zaka (Tithe)', amount: 4699900, currency: 'TZS', giver: 'Asha' }] },
        read_at: null,
        sent_at: new Date().toISOString(),
      },
    ]);

    expect((await screen.findAllByText('18 Sept 2026')).length).toBe(1);
    expect(screen.getByText(/44 attendance · 4,699,900 TZS/)).toBeInTheDocument();
    expect(screen.queryByText('Asha')).toBeNull();
  });

  it('counts distinct dated digest sections rather than repeated date fragments', async () => {
    const makeDigest = (id, date) => ({
      id,
      subject: 'Today’s summary from the front desk',
      body: 'digest',
      payload: { date, totalOfferings: 1000, currency: 'TZS', attendance: [], offerings: [{ id, category: 'General', amount: 1000, currency: 'TZS' }] },
      read_at: null,
      sent_at: new Date().toISOString(),
    });
    renderMessages([makeDigest(21, '2026-09-19'), makeDigest(22, '2026-09-18'), makeDigest(23, '2026-09-17')]);

    expect(await screen.findByText('3 updates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /19 Sept 2026.*1,000 TZS/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /18 Sept 2026.*1,000 TZS/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /17 Sept 2026.*1,000 TZS/ })).toBeInTheDocument();
  });

  it('keeps full offering details out of the compact feed row', async () => {
    renderMessages([{
      id: 10,
      subject: 'Daily summary',
      body: 'digest',
      payload: {
        date: '2026-09-14',
        totalOfferings: 7000,
        currency: 'TZS',
        attendance: [],
        offerings: [
          { id: 1, category: 'Zaka (Tithe)', amount: 5000, currency: 'TZS', giver: 'Asha', service: 'Sunday Service' },
          { id: 2, category: 'Zaka (Tithe)', amount: 2000, currency: 'TZS', giver: 'Baraka', service: 'Sunday Service' },
        ],
      },
      read_at: null,
      sent_at: new Date().toISOString(),
    }]);

    expect(await screen.findByText(/0 attendance · 7,000 TZS/)).toBeInTheDocument();
    expect(screen.queryByText('Asha')).toBeNull();
    expect(screen.queryByText('Baraka')).toBeNull();
  });

  it('keeps direct pastoral messages visible', async () => {
    renderMessages([{
      id: 8,
      subject: 'Need prayer follow-up',
      body: 'Please call the family after service.',
      payload: null,
      read_at: null,
      sent_at: new Date().toISOString(),
    }]);

    expect(await screen.findByText('Please call the family after service.')).toBeInTheDocument();
  });
});
