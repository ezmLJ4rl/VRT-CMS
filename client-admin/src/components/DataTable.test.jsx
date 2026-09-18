import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

import DataTable from './DataTable';
import { MotionRoot } from '../motionUi.jsx';

const ROWS = [
  { id: 1, name: 'Zaka', giver: 'Neema K', service: '1st Sunday Service', amount: '5,000 TZS', status: 'Sent' },
  { id: 2, name: 'Thanksgiving', giver: 'Baraka J', service: '1st Sunday Service', amount: '12,000 TZS', status: 'Pending' },
];

const COLUMNS = [
  { key: 'name', header: 'Category', render: (r) => <span>{r.name}</span> },
  { key: 'giver', header: 'Giver', render: (r) => r.giver },
  { key: 'service', header: 'Service', width: 6, render: (r) => r.service },
  { key: 'amount', header: 'Amount', width: 5, align: 'right', cardValue: true, render: (r) => r.amount },
  { key: 'status', header: 'Status', width: 4, align: 'right', render: (r) => r.status },
];

// DataTable reads the viewport once per render. The suite-wide stub defaults
// to the desktop grid; these helpers flip it for the narrow-layout tests.
// `motion: true` wraps the table in the provider the app mounts (main.jsx):
// without it the animation is not loaded, which is a real (and correct) path:
// just not the one an animation is being tested through.
function renderTable(props = {}, { narrow = false, motion = false } = {}) {
  if (narrow) {
    vi.stubGlobal('matchMedia', (query) => ({
      matches: !query.includes('min-width'),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
    }));
  }
  const table = <DataTable columns={COLUMNS} rows={ROWS} keyOf={(r) => r.id} {...props} />;
  return render(motion ? <MotionRoot>{table}</MotionRoot> : table);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DataTable: the one table pattern (wide)', () => {
  it('renders a fixed grid whose headers and cells share the same tracks', () => {
    renderTable();

    const table = screen.getByRole('table');
    // Fixed layout is what stops a wide cell from dragging its column out
    // from under the header.
    expect(table).toHaveClass('table-fixed');
    const headerTexts = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    expect(headerTexts).toEqual(['Category', 'Giver', 'Service', 'Amount', 'Status']);
    // Every colgroup entry and every header cell line up one-to-one.
    expect(table.querySelectorAll('colgroup col')).toHaveLength(headerTexts.length);
  });

  it('gives every data row the same structure: no row may grow extra cells', () => {
    renderTable();

    const rows = screen.getByRole('table').querySelectorAll('tbody tr');
    expect(rows).toHaveLength(ROWS.length);
    for (const row of rows) {
      expect(row.querySelectorAll('td')).toHaveLength(COLUMNS.length);
      // One shared vertical rhythm: every row carries the same padding class.
      expect(row.querySelector('td')).toHaveClass('py-2.5');
    }
  });

  it('wraps long pills and badge clusters inside their own cell tracks', () => {
    const longColumns = [
      {
        key: 'category',
        header: 'Category',
        render: () => <span className="cat-chip category-offering">Thanksgiving Offering</span>,
      },
      { key: 'giver', header: 'Giver', render: () => 'A very long giver name that must remain in its own column' },
      { key: 'service', header: 'Service', width: 18, render: () => '1st Sunday Service' },
      { key: 'amount', header: 'Amount', width: 18, render: () => <span className="whitespace-nowrap">500,000 TZS</span> },
      {
        key: 'status',
        header: 'Status',
        width: 24,
        render: () => (
          <span className="flex flex-wrap items-center justify-end gap-2">
            <span className="inline-flex items-center gap-1.5">
              <span className="cat-chip category-ink">VR-2026-0255</span>
              <span className="inline-flex h-10 w-10" />
            </span>
          </span>
        ),
      },
    ];
    renderTable({ columns: longColumns, rows: [{ id: 1 }] });

    const cells = [...screen.getByRole('table').querySelectorAll('tbody td')];
    expect(cells).toHaveLength(longColumns.length);
    for (const cell of cells) {
      expect(cell).toHaveClass('min-w-0', 'max-w-0');
      expect(cell.firstElementChild).toHaveClass('data-table-cell-content', 'max-w-full');
    }
    const category = screen.getByText('Thanksgiving Offering');
    expect(category).toHaveClass('cat-chip');
    expect(category.closest('.data-table-cell-content')).toBeInTheDocument();
    const receipt = screen.getByText('VR-2026-0255');
    expect(receipt.closest('.data-table-cell-content')).toBeInTheDocument();
  });

  it('keeps the header visible while the list scrolls (sticky)', () => {
    renderTable({ scrollHeight: '20rem' });

    for (const th of screen.getByRole('table').querySelectorAll('thead th')) {
      expect(th).toHaveClass('sticky');
      expect(th).toHaveClass('top-0');
    }
  });

  it('renders the expanded panel as one extra full-width row', () => {
    renderTable({
      expandedRow: (r) => (r.id === 2 ? <span>Neema K, Baraka J</span> : null),
    });

    const panels = screen.getByRole('table').querySelectorAll('tbody tr');
    expect(panels).toHaveLength(ROWS.length + 1); // one expansion
    expect(screen.getByText('Neema K, Baraka J')).toBeInTheDocument();
  });

  it('drills from a whole-row click', () => {
    const onRowClick = vi.fn();
    renderTable({ onRowClick, rowClassName: () => 'cursor-pointer' });

    const cell = within(screen.getByText('Zaka').closest('tr'));
    cell.getByText('5,000 TZS').closest('tr');
    screen.getByText('Zaka').closest('tr').click();
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it('shows the empty state exactly once', () => {
    renderTable({ rows: [], empty: <p>No offerings yet</p> });
    expect(screen.getAllByText('No offerings yet')).toHaveLength(1);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('DataTable: the one table pattern (narrow, card reflow)', () => {
  it('reflows every row into the same card: lead, cardValue, labeled middle', () => {
    renderTable({}, { narrow: true });

    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(ROWS.length);

    for (const card of cards) {
      // The lead column opens the card and the cardValue column closes it.
      expect(card.textContent).toContain('TZS');
      // The middle columns fold into labeled lines: label text present for
      // each, so nothing is a mystery value.
      for (const label of ['Giver', 'Service', 'Status']) {
        expect(card.textContent).toContain(label);
      }
    }
    // No table is rendered at all in the narrow layout: nothing to scroll.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the expanded panel inside the card it belongs to', () => {
    renderTable({ expandedRow: (r) => (r.id === 1 ? <span>Zaka names here</span> : null) }, { narrow: true });

    const cards = screen.getAllByRole('listitem');
    expect(within(cards[0]).getByText('Zaka names here')).toBeInTheDocument();
    expect(within(cards[1]).queryByText('Zaka names here')).not.toBeInTheDocument();
  });
});

describe('DataTable: a row that has just been added', () => {
  const rowFor = (name) => screen.getByText(name).closest('tr');

  it('tints only the row it was told about, and leaves the others alone', async () => {
    // The page passes back the id the write returned: nothing here guesses which
    // row is new from order or timestamp.
    renderTable({ flashIds: [2] }, { motion: true });

    await waitFor(() => expect(rowFor('Thanksgiving').getAttribute('style') || '').toMatch(/background-color/));
    expect(rowFor('Zaka').getAttribute('style') || '').not.toMatch(/background-color/);
  });

  // The reduced-motion half of this lives in DataTable.reducedMotion.test.jsx:
  // Motion reads the OS setting once per module registry, so after the test
  // above has animated a row, a stub installed here would never be consulted.

  it('carries the tint into the card layout as well as the grid', async () => {
    // The narrow layout renders the same rows as cards; a highlight that only
    // worked on the desktop grid would be missing on a phone at the desk.
    renderTable({ flashIds: [1] }, { narrow: true, motion: true });
    const cards = screen.getAllByRole('listitem');
    await waitFor(() => expect(cards[0].getAttribute('style') || '').toMatch(/background-color/));
    expect(cards[1].getAttribute('style') || '').not.toMatch(/background-color/);
  });
});

describe('DataTable: printing', () => {
  it('prints the fixed grid even from a narrow window, then restores the cards', () => {
    renderTable({}, { narrow: true });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    // The print snapshot is taken the moment beforeprint returns, so the
    // flip to the grid must commit synchronously inside the event: this
    // assertion is what pins the flushSync in place.
    window.dispatchEvent(new Event('beforeprint'));
    expect(screen.getByRole('table')).toHaveClass('table-fixed');

    window.dispatchEvent(new Event('afterprint'));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('leaves a wide window on the grid across a print cycle', () => {
    renderTable();
    window.dispatchEvent(new Event('beforeprint'));
    expect(screen.getByRole('table')).toHaveClass('table-fixed');
    window.dispatchEvent(new Event('afterprint'));
    expect(screen.getByRole('table')).toHaveClass('table-fixed');
  });
});
