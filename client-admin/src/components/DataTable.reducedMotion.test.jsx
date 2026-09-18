import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import DataTable from './DataTable';
import { MotionRoot } from '../motionUi.jsx';

/*
 * A highlight is decoration: the record is findable without it, so a reader who
 * asked their system for less motion gets no tint at all (DataTable's Row skips
 * the motion component entirely).
 *
 * WHY THIS TEST LIVES ALONE: Motion reads the OS setting once per module
 * registry and then keeps it in a module-level value that listens for later
 * changes. That is right for an app, a preference does not change mid-session
 * but it means a stub installed *after* any other test in the same file has
 * already rendered an animated row is never read. In its own file the stub is
 * in place before Motion is loaded, which is the only way to test the path a
 * reduced-motion reader actually takes.
 */

const ROWS = [{ id: 1, name: 'Thanksgiving', amount: '12,000 TZS' }];

const COLUMNS = [
  { key: 'name', header: 'Category', render: (r) => <span>{r.name}</span> },
  { key: 'amount', header: 'Amount', width: 6, align: 'right', render: (r) => r.amount },
];

vi.stubGlobal('matchMedia', (query) => ({
  matches: query.includes('prefers-reduced-motion') || query.includes('min-width'),
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
}));

describe('DataTable: a row that has just been added, for a reduced-motion reader', () => {
  it('tints nothing at all', async () => {
    render(
      <MotionRoot>
        <DataTable columns={COLUMNS} rows={ROWS} keyOf={(r) => r.id} flashIds={[1]} />
      </MotionRoot>
    );

    // Given the moment the tint needs to appear for everyone else, the row here
    // carries no animation state: not the tint, and not a settled `transparent`
    // either: nothing is animating at all.
    await new Promise((r) => setTimeout(r, 60));
    const row = screen.getByText('Thanksgiving').closest('tr');
    expect(row.getAttribute('style')).toBeNull();
  });

  it('still renders every row and column', () => {
    render(
      <MotionRoot>
        <DataTable columns={COLUMNS} rows={ROWS} keyOf={(r) => r.id} flashIds={[1]} />
      </MotionRoot>
    );
    expect(screen.getByText('Thanksgiving')).toBeInTheDocument();
    expect(screen.getByText('12,000 TZS')).toBeInTheDocument();
  });
});
