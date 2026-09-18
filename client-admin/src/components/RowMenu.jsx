import { MoreVertical } from 'lucide-react';
import useDismissable from './useDismissable';

/**
 * The vertical-ellipsis row menu: one component for every list row whose
 * secondary actions (edit, delete) must not clutter the resting row.
 *
 * Groups and Members render it identically on purpose: an admin who learned one
 * screen already knows the other, and a fix to the menu's behavior (the
 * outside-click close, the Escape close, the single-open rule) lands everywhere
 * at once. The caller owns the items and the open/close state, because the
 * state must live at the list level for the one-open-at-a-time rule to span
 * rows; this component owns only the presentation and the closing behavior.
 *
 * `stopPropagation` on the toggle matters wherever the row itself is clickable
 * (a Members row expands on click): the menu button is not a row click.
 */
export default function RowMenu({ open, onToggle, onClose, label, children, testId }) {
  useDismissable(open, onClose, 'data-row-menu');

  return (
    <span className="relative" data-row-menu>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        data-testid={testId}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-500 hover:bg-ink-100 hover:text-ink-900"
      >
        <MoreVertical size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-ink-200 bg-paper py-1 shadow-lg">
          {children}
        </div>
      )}
    </span>
  );
}

/** One entry in a RowMenu. `danger` renders the destructive styling. */
export function RowMenuItem({ onClick, disabled, danger = false, children }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-ink-100 disabled:opacity-50 ${
        danger ? 'text-red-700 hover:bg-red-50' : 'text-ink-700'
      }`}
    >
      {children}
    </button>
  );
}
