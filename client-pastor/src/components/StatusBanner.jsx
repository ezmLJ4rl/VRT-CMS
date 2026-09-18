import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { AnimatePresence, m } from 'motion/react';
import { NOTICE, settled, useSettled } from '../motion';

/**
 * The pastor app's one confirmation/error surface.
 *
 * It fades and slides in when it appears and fades out when it is dismissed:
 * the same motion, the same durations, as the admin app's banner (src/motion.js),
 * because these two apps are one product. That is all the motion this screen
 * gets: the home view stays calm on purpose, and nothing here is scroll-linked
 * or decorative.
 *
 * The `key` is the TONE, not the message, so a message replaced in place (a
 * countdown, a refreshed figure) updates in the same element instead of exiting
 * and re-entering.
 */
export default function StatusBanner({ type = 'success', message }) {
  const isError = type === 'error';
  // Once the entrance would be over the resting style is asserted, so a renderer
  // that never painted a frame cannot leave a confirmation invisible.
  const done = useSettled(message || null);
  return (
    <AnimatePresence>
      {message ? (
        <m.div
          key={type}
          role="status"
          {...NOTICE}
          className={settled(
            `flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
              isError ? 'border-danger-300 bg-danger-50 text-danger-700' : 'border-people-300 bg-people-50 text-people-700'
            }`,
            done
          )}
        >
          {isError ? <AlertTriangle size={16} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={16} className="mt-0.5 shrink-0" />}
          <span>{message}</span>
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}
