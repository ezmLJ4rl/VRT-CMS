import { Fragment, useState, useEffect } from 'react';
import { EMPTY_VALUE } from '../emptyValue';

/**
 * One table pattern for the whole app.
 *
 * Every screen used to hand-roll its own markup: a `min-w-[…]` that overflowed
 * into a scrollbar at the first narrow viewport, row padding that varied by
 * screen, and columns that only lined up with their headers by accident. This
 * component fixes the layout once:
 *
 * - COLUMNS are fixed-layout (`table-fixed` + a colgroup of percentage
 *   widths), so a column cannot drift out from under its header: the header
 *   and every cell sit in the same track, whatever their content. Columns
 *   without `width` share what is left equally: give exactly one column no
 *   width (the leading text column) and it takes the remainder. Because the
 *   layout is fixed and the row padding is defined here, every row is the
 *   same height and the same spacing on every screen.
 * - THE HEADER IS STICKY (`position: sticky` on the `th` cells, the
 *   reliable cross-browser placement), so column labels stay visible while a
 *   long list scrolls. Pass `scrollHeight` to scroll inside the card with the
 *   header pinned to the card; omit it and the header pins to the page
 *   scroll, which suits the short tables inside dashboard tiles.
 * - BELOW the `sm` breakpoint every table in the app reflows the same way:
 *   the row becomes a card: the first column leads it, the figure marked
 *   `cardValue` closes it, and the columns in between fold into one labeled
 *   line each beneath. Lower-priority data is demoted, never hidden, and no
 *   table asks for a horizontal scrollbar merely because the screen is
 *   narrow. One strategy, everywhere.
 *
 * Exactly ONE of the two layouts is rendered, chosen by a `min-width: 40rem`
 * media query, so the DOM never carries hidden duplicates, and a screen
 * reader reads the table once. jsdom (the tests) defaults to the desktop
 * grid; a test wanting the card view stubs matchMedia to `matches: false`.
 *
 * Columns: `{ key, header, width?, align?, render?, cardValue? }`.
 * `width` is a straight PERCENTAGE of the table (e.g. `width: 14` → 14%);
 * columns without it share what is left equally: give exactly one column no
 * width (the leading text column) and it takes the remainder. Keep the
 * percentages of the width-ed columns well under 100 so the text columns
 * keep room.
 *
 * `expandedRow(row, i)` returns the CONTENT of an optional panel shown
 * beneath a row (e.g. the named-attendance list). This component places it
 * correctly in both layouts, a full-width extra row in the table, an extra
 * section in the card, so the page never writes table plumbing itself.
 *
 * `onRowClick(row)` makes whole rows clickable (Reports' drill-down); pair it
 * with `rowClassName` for the cursor/hover affordance.
 */
function useWide() {
  const [wide, setWide] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 40rem)').matches : true
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 40rem)');
    const onChange = (e) => setWide(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return wide;
}

export default function DataTable({
  columns,
  rows,
  keyOf,
  empty,
  scrollHeight,
  expandedRow,
  onRowClick,
  rowClassName,
}) {
  const wide = useWide();
  if (!wide) {
    // The narrow layout: the same data in one consistent card shape. The
    // lead column is the card's first line; the cardValue column's content
    // closes it; everything between folds into labeled lines under a rule.
    // Nothing is cut off, nothing scrolls sideways.
    const lead = columns[0];
    const value = columns.find((c) => c.cardValue) || columns[columns.length - 1];
    const middle = columns.filter((c) => c !== lead && c !== value);
    if (rows.length === 0) return empty || null;
    return (
      <ul className="space-y-2">
        {rows.map((row, i) => (
          <li
            key={keyOf ? keyOf(row, i) : i}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={`rounded-lg border border-ink-100 bg-ink-50/50 p-3 ${onRowClick ? 'cursor-pointer' : ''} ${rowClassName ? rowClassName(row, i) : ''}`}
          >
            <div className="flex min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 font-medium text-ink-900">
                {lead.render ? lead.render(row, i) : row[lead.key] ?? EMPTY_VALUE}
              </span>
              <span className="shrink-0">{value.render ? value.render(row, i) : row[value.key] ?? EMPTY_VALUE}</span>
            </div>
            {middle.length > 0 && (
              <div className="mt-2 space-y-1.5 border-t border-ink-100 pt-2">
                {middle.map((c) => (
                  <span key={c.key} className="flex min-w-0 items-baseline justify-between gap-3">
                    <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-ink-400">{c.header}</span>
                    <span className="min-w-0 text-right text-sm">{c.render ? c.render(row, i) : row[c.key] ?? EMPTY_VALUE}</span>
                  </span>
                ))}
              </div>
            )}
            {expandedRow && expandedRow(row, i) && (
              <div className="mt-2 border-t border-ink-100 pt-2">{expandedRow(row, i)}</div>
            )}
          </li>
        ))}
      </ul>
    );
  }

  // The wide layout: the fixed grid. `sm` (40rem) is the one breakpoint at
  // which every table in the app switches, never a per-screen choice.
  // No rows, no table shell, just the empty state, once.
  if (rows.length === 0) return empty || null;
  return (
    <div>
      <div
        className={`scb rounded-lg ${scrollHeight ? 'overflow-y-auto' : ''}`}
        style={scrollHeight ? { maxHeight: scrollHeight } : undefined}
      >
        <table className="w-full table-fixed border-collapse text-left text-sm">
          <colgroup>
            {columns.map((c) => (
              <col key={c.key} style={c.width != null ? { width: `${c.width}%` } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={`sticky top-0 z-10 bg-paper py-2 pr-3 text-xs font-medium uppercase tracking-wide text-ink-400 shadow-[0_1px_0_var(--color-ink-200)] last:pr-0 ${c.align === 'right' ? 'text-right' : ''}`}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (                <Fragment key={keyOf ? keyOf(row, i) : i}>
                  <tr
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={`border-b border-ink-100 last:border-0 ${rowClassName ? rowClassName(row, i) : ''}`}
                  >
                    {columns.map((c, ci) => (
                      <td
                        key={c.key}
                        // A cell may wrap; it may never push the table wider.
                        // `break-words` keeps a long unbroken token (a receipt
                        // number, a URL) inside its track instead of forcing
                        // the min-content width past the column percentage.
                        className={`py-2.5 align-middle break-words ${ci === columns.length - 1 ? 'pr-0' : 'pr-3'} ${c.align === 'right' ? 'text-right' : ''}`}
                      >
                      {c.render ? c.render(row, i) : row[c.key] ?? EMPTY_VALUE}
                    </td>
                  ))}
                </tr>
                {expandedRow && expandedRow(row, i) && (
                  <tr className="bg-ink-50/60">
                    <td colSpan={columns.length} className="px-3 py-2">
                      {expandedRow(row, i)}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
