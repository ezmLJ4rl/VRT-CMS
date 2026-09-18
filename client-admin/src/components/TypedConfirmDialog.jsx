import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';

/**
 * A destructive confirmation that costs a deliberate act: the admin retypes the
 * member's or group's name before the button will fire.
 *
 * Why not `window.confirm`: it reads like every other alert on the web, and it
 * is dismissed by the same Enter key that dismisses everything else: on a
 * screen where Delete sits two clicks from a row, that is not a guard, it is a
 * speed bump. Retyping the name makes the wrong target noticeable while the
 * decision is still reversible, and a reflexive keypress cannot carry it.
 *
 * The typed text is never sent anywhere and never becomes the request: the
 * button is the gate, and the DELETE that follows is the same call it always
 * was. This is a guard against the wrong row, not a second authorisation.
 *
 * The caller mounts this only while a target is pending (and keys it by that
 * target), so a fresh dialog always starts empty: a half-typed name left from
 * the previous delete would be a lock with the key still in it.
 */
export default function TypedConfirmDialog({
  title,
  body,
  name,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const target = String(name ?? '').trim();
  // Case- and whitespace-insensitive: the point is to prove you read which row
  // is under the cursor, not to test your typing.
  const matches = typed.trim().toLowerCase() === target.toLowerCase();

  // Escape is the one key that closes this, and unlike the row menus, which
  // close on any key, typing must not. The listener is on the document rather
  // than a React `onKeyDown` on the panel, because the panel is not focusable:
  // one click on the heading would otherwise leave focus on the body and strand
  // the dialog with no keyboard way out. Closing is refused while the request is
  // in flight: the deletes here cannot be called back.
  useEffect(() => {
    if (busy) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div
      role="presentation"
      onClick={busy ? undefined : onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="typed-confirm-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-ink-200 bg-paper p-5 shadow-xl"
      >
        <h2 id="typed-confirm-title" className="flex items-start gap-2 font-display text-lg font-semibold text-ink-900">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger-600" />
          {title}
        </h2>

        {body && <p className="mt-2 text-sm text-ink-600">{body}</p>}

        <label htmlFor="typed-confirm-input" className="mt-4 block text-sm text-ink-700">
          {t('common.typeNameToConfirm', { name: target })}
        </label>
        <input
          id="typed-confirm-input"
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the dialog exists
          // to be answered, and it is opened by a deliberate click.
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          disabled={busy}
          aria-invalid={typed.length > 0 && !matches}
          autoComplete="off"
          className="mt-1 w-full rounded-md border border-ink-200 px-3 py-2.5 text-base focus-visible:border-danger-600"
        />

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} disabled={busy} className="btn btn-secondary">
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!matches || busy}
            className="btn btn-danger"
          >
            {busy ? t('common.saving') : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
