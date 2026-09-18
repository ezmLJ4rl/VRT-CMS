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

    expect(await screen.findByText(/5,000 TZS/)).toBeInTheDocument();
    expect(screen.getByText(/44 recorded/)).toBeInTheDocument();
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
