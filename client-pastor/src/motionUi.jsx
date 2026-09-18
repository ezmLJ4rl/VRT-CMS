import { LazyMotion, MotionConfig, domAnimation, m } from 'motion/react';
import { PANEL, settled, useSettled } from './motion';

/*
 * The two components of the motion system; the durations, presets and the
 * settled-state guarantee are in ./motion.js, with the reasoning for all of it.
 */

/**
 * Wraps the app: `m` components only, with the DOM feature set they actually
 * use (no layout projection, no drag, no gestures), so the bundle carries what
 * is used and nothing else. `reducedMotion="user"` makes Motion honour the
 * OS/browser setting: transforms are skipped for those users, which is the one
 * behaviour the global CSS rule in index.css cannot reach, because Motion
 * animates inline styles rather than CSS animations.
 *
 * Mounted at the app root (main.jsx). A component rendered outside it still
 * works: it renders and simply does not animate, and the settle class below
 * still puts it in its resting state: a page cannot end up with content that
 * only appears if the provider was there.
 */
export function MotionRoot({ children }) {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}

/**
 * The collapsed → expanded edit state (Service Types rows, a Revival Center's
 * manage panel): the panel grows to its own height instead of the page jumping
 * to a new layout in one frame while the eye is still on the button that opened
 * it.
 *
 * Usage: the page keeps its own `{open && …}`, and this replaces only the
 * panel's own element:
 *
 *     {isEditing && <ExpandingPanel className="border-t p-4">…</ExpandingPanel>}
 *
 * The CONDITION stays outside on purpose. JSX children are built before the
 * component runs, so passing the panel a draft that is null while closed would
 * evaluate `draft.name` (and throw) no matter what the component did with it.
 *
 * WHY CLOSING IS STILL INSTANT: these panels render a DRAFT, one open row, and
 * discarding it on save/cancel is the rule the pages are built on. Animating the
 * close would mean holding that discarded draft mounted for the length of the
 * exit, so a half-typed form would stay in the DOM and in memory after the admin
 * has finished with it, and an unsaved editor would come back on screen to fade
 * away. The direction that needs the animation is the one that reveals
 * something; the one that takes it away is already unambiguous.
 */
export function ExpandingPanel({ className = '', children }) {
  // Mounted per opening, so the settle state below begins with the panel rather
  // than with the row it belongs to.
  const done = useSettled(true);
  return (
    <m.div {...PANEL} className={settled(`overflow-hidden ${className}`, done)}>
      {children}
    </m.div>
  );
}
