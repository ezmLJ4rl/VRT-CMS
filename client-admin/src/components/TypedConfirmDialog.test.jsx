import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import TypedConfirmDialog from './TypedConfirmDialog';
import i18n from '../i18n';

const user = () => userEvent.setup();

// Mirrors how the pages use it: mounted only while a target is pending, keyed by
// that target, so a second deletion gets an empty field.
function Harness({ name, busy = false, onConfirm = vi.fn(), onCancel = vi.fn() }) {
  const [open, setOpen] = useState(true);
  if (!open) return <p>closed</p>;
  return (
    <TypedConfirmDialog
      key={name}
      title={`Delete ${name}?`}
      body="Past records keep naming them."
      name={name}
      confirmLabel={i18n.t('members.delete')}
      busy={busy}
      onConfirm={() => {
        onConfirm();
        setOpen(false);
      }}
      onCancel={() => {
        onCancel();
        setOpen(false);
      }}
    />
  );
}

const confirmButton = () => screen.getByRole('button', { name: 'Delete' });
const field = (name) => screen.getByLabelText(`Type ${name} to confirm`);

beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('TypedConfirmDialog: a guard that costs a deliberate act', () => {
  it('will not fire on the name it was opened for until that name is typed', async () => {
    const onConfirm = vi.fn();
    render(<Harness name="Neema K" onConfirm={onConfirm} />);
    const u = user();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();

    await u.type(field('Neema K'), 'Neema');
    expect(confirmButton()).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();

    await u.type(field('Neema K'), ' K');
    expect(confirmButton()).toBeEnabled();
    await u.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('accepts the name regardless of case or stray spacing: the point is which row, not typing skill', async () => {
    const onConfirm = vi.fn();
    render(<Harness name="Harvest Choir" onConfirm={onConfirm} />);
    const u = user();

    await u.type(field('Harvest Choir'), '  harvest choir  ');
    expect(confirmButton()).toBeEnabled();
    await u.click(confirmButton());

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('will not accept a different name, however similar', async () => {
    const onConfirm = vi.fn();
    render(<Harness name="Neema K" onConfirm={onConfirm} />);
    const u = user();

    await u.type(field('Neema K'), 'Neema K ');
    await u.clear(field('Neema K'));
    await u.type(field('Neema K'), 'Neema Joseph');
    expect(confirmButton()).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('opens empty every time, so a previous confirmation cannot be replayed', async () => {
    function TwoInARow() {
      const [name, setName] = useState('Neema K');
      return (
        <>
          <button type="button" onClick={() => setName('Baraka J')}>
            next
          </button>
          <Harness name={name} />
        </>
      );
    }
    render(<TwoInARow />);
    const u = user();

    await u.type(field('Neema K'), 'Neema K');
    expect(confirmButton()).toBeEnabled();

    // The next deletion must not inherit the typed name, or the enabling.
    await u.click(screen.getByRole('button', { name: 'next' }));
    expect(field('Baraka J')).toHaveValue('');
    expect(confirmButton()).toBeDisabled();
  });

  it('is not dismissed by typing: every other key is a keystroke, only Escape is a refusal', async () => {
    const onCancel = vi.fn();
    render(<Harness name="Neema K" onCancel={onCancel} />);
    const u = user();

    await u.type(field('Neema K'), 'Nee');
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await u.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still answers Escape after focus has left the field', async () => {
    // The panel itself is not focusable, so a click on the heading moves focus to
    // the body: a dialog that only listened on its own subtree would be stranded
    // with no keyboard way out.
    const onCancel = vi.fn();
    render(<Harness name="Neema K" onCancel={onCancel} />);
    const u = user();

    await u.click(screen.getByRole('heading', { name: 'Delete Neema K?' }));
    expect(document.activeElement).toBe(document.body);

    await u.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on the backdrop and on Cancel, sending nothing', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { unmount } = render(<Harness name="Neema K" onConfirm={onConfirm} onCancel={onCancel} />);
    const u = user();

    // The backdrop is the dialog's own wrapper; the panel stops propagation.
    await u.click(screen.getByRole('dialog').parentElement);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    unmount();

    render(<Harness name="Neema K" onConfirm={onConfirm} onCancel={onCancel} />);
    await u.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('refuses to be closed or fired while the request is in flight: the delete cannot be called back', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<Harness name="Neema K" busy onConfirm={onConfirm} onCancel={onCancel} />);
    const u = user();

    await u.keyboard('{Escape}');
    await u.click(screen.getByRole('dialog').parentElement);
    expect(onCancel).not.toHaveBeenCalled();

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('wears the destructive colour, not the brand primary', () => {
    render(<Harness name="Neema K" />);

    expect(confirmButton()).toHaveClass('btn-danger');
    expect(confirmButton()).not.toHaveClass('btn-primary');
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('btn-secondary');
  });

  it('speaks Kiswahili when the app does', async () => {
    await i18n.changeLanguage('sw');
    render(<Harness name="WWK" />);
    const u = user();

    expect(screen.getByRole('button', { name: 'Futa' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Ghairi' })).toBeInTheDocument();
    await u.type(screen.getByLabelText('Andika WWK ili kuthibitisha'), 'WWK');
    expect(screen.getByRole('button', { name: 'Futa' })).toBeEnabled();
  });
});
