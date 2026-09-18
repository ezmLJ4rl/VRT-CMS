import { useEffect } from 'react';

/**
 * Closes an open popover when the pointer lands outside its container or the
 * user presses a key (Escape, but any key: a menu that survives a keystroke is
 * a menu the user has to fight). The container marks itself with the attribute
 * the hook is told to look for, so one hook serves the row ⋮ menus and the
 * header's sort/filter panels without them knowing about each other.
 *
 * Extracted after the second popover existed: the alternative was a third and
 * fourth copy of the same listener bookkeeping, each free to drift.
 *
 * `anyKey: false` narrows that to Escape, for the one popover whose contents are
 * LINKS rather than actions: the top nav's Manage/Finance menus have to be
 * Tab-able, and dismissing on Tab would make them unusable by keyboard. The
 * outside-pointerdown rule is the same either way.
 */
export default function useDismissable(open, onClose, attribute = 'data-popover', { anyKey = true } = {}) {
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (e.type === 'pointerdown') {
        if (!e.target.closest(`[${attribute}]`)) onClose();
        return;
      }
      if (anyKey || e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open, onClose, attribute, anyKey]);
}
