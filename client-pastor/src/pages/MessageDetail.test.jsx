import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import MessageDetail from './MessageDetail';
import api from '../api';
import i18n from '../i18n';

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { get: vi.fn(), patch: vi.fn() } };
});

function renderDetail(message) {
  api.get.mockResolvedValue({ data: { message } });
  api.patch.mockResolvedValue({ data: {} });
  return render(
    <MemoryRouter initialEntries={['/messages/9']}>
      <Routes><Route path="/messages/:id" element={<MessageDetail />} /></Routes>
    </MemoryRouter>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Pastor message detail', () => {
  it('shows the full grouped digest and marks it read when opened', async () => {
    renderDetail({
      id: 9,
      subject: 'Today summary',
      sent_at: '2026-09-18 18:00:00',
      read_at: null,
      payload: {
        date: '2026-09-18',
        totalOfferings: 7000,
        currency: 'TZS',
        attendance: [{ id: 1, typeName: '1st Sunday Service', subSession: 'Main Service', count: 44, mode: 'headcount', attendees: [] }],
        offerings: [{ id: 2, category: 'Zaka (Tithe)', amount: 7000, currency: 'TZS', giver: 'Asha' }],
      },
    });

    expect(await screen.findByText('18 Sept 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1st Sunday Service.*44 recorded/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Zaka \(Tithe\).*7,000 TZS/i })).toBeInTheDocument();
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/messages/9/read'));
    expect(screen.getByRole('button', { name: /Back to messages/i })).toBeInTheDocument();
  });
});
