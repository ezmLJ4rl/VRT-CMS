import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import StatusBanner from './StatusBanner';
import { MotionRoot } from '../motionUi.jsx';

/*
 * The banner is the app's answer to "did that work?": the record was saved, the
 * receipt was issued, the church account was connected. Three things matter:
 * it appears with a movement the eye catches instead of teleporting; it is in
 * its resting state once the movement is over (not left at the animation's
 * first frame, invisible, by a renderer that never painted); and a message that
 * is replaced in place is NOT re-animated, because that is how a countdown or a
 * refreshed figure would turn into a banner flickering under the reader's eyes.
 */
const show = (props) =>
  render(
    <MotionRoot>
      <StatusBanner {...props} />
    </MotionRoot>
  );

describe('StatusBanner', () => {
  it('says nothing when there is nothing to say', () => {
    const { container } = render(<StatusBanner message={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('arrives as a notice, and settles visible', async () => {
    show({ message: 'Attendance recorded.' });
    const notice = screen.getByRole('status');

    expect(notice.textContent).toContain('Attendance recorded.');
    // Mid-entrance the animation owns the element.
    expect(notice.className).not.toContain('motion-settled');
    // …and once it is over, the resting state is asserted from the stylesheet.
    await waitFor(() => expect(notice.className).toContain('motion-settled'));
  });

  it('fades out when it is dismissed rather than vanishing', async () => {
    const { rerender } = render(
      <MotionRoot>
        <StatusBanner message="Offering recorded." />
      </MotionRoot>
    );
    expect(screen.getByRole('status')).toBeInTheDocument();

    rerender(
      <MotionRoot>
        <StatusBanner message={null} />
      </MotionRoot>
    );
    // Still in the document, on its way out: the exit is what makes a dismissal
    // read as deliberate rather than as the screen losing its place.
    expect(screen.getByRole('status')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
  });

  it('carries the error tone it was given', () => {
    show({ type: 'error', message: 'That did not save.' });
    expect(screen.getByRole('status').className).toContain('border-danger-300');
  });

  it('replaces a message in place instead of animating it again', () => {
    const { rerender } = render(
      <MotionRoot>
        <StatusBanner type="info" message="Try again in 0:07" />
      </MotionRoot>
    );
    const notice = screen.getByRole('status');

    rerender(
      <MotionRoot>
        <StatusBanner type="info" message="Try again in 0:06" />
      </MotionRoot>
    );
    // The same element, with the new text: no exit, no re-entry, no flash.
    expect(screen.getByRole('status')).toBe(notice);
    expect(screen.getByRole('status').textContent).toContain('0:06');
  });
});
