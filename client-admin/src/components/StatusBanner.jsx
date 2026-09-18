import { CheckCircle2, AlertTriangle, Info } from 'lucide-react';
import { AnimatePresence, m } from 'motion/react';
import { NOTICE, settled, useSettled } from '../motion';

const TONES = {
  error: 'border-danger-300 bg-danger-50 text-danger-700',
  info: 'border-ink-200 bg-ink-50 text-ink-700',
  success: 'border-people-300 bg-people-50 text-people-700',
};

/**
 * The app's one confirmation/error surface.
 *
 * It fades and slides in when it appears and fades out when it is dismissed,
 * because this banner is the app's answer to "did that work?", the record was
 * saved, the receipt was issued, the church account was connected, and a notice
 * that appears by teleporting is one the eye can miss while a hand is still
 * moving to the next field. Exit is animated through AnimatePresence, which
 * means a caller that CLEARS the message keeps the banner mounted long enough to
 * fade; a caller that unmounts the banner itself removes it at once (its own
 * markup, not this component's business).
 *
 * The `key` is the TONE, not the message: a countdown ("try again in 0:07 … 0:06")
 * or any other message replaced in place must not exit and re-enter every second.
 * A notice that changes tone genuinely is a different notice, and animates as one.
 */
export default function StatusBanner({ type = 'success', message }) {
  const Icon = type === 'error' ? AlertTriangle : type === 'info' ? Info : CheckCircle2;
  // Once the entrance would be over the resting style is asserted, so a renderer
  // that never painted a frame cannot leave the confirmation invisible.
  const done = useSettled(!!message);
  return (
    <AnimatePresence>
      {message ? (
        <m.div
          key={type}
          role="status"
          {...NOTICE}
          className={settled(`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${TONES[type] || TONES.success}`, done)}
        >
          <Icon size={16} className="mt-0.5 shrink-0" />
          <span>{message}</span>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
