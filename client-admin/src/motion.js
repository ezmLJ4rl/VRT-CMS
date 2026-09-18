import { useEffect, useState } from 'react';

/*
 * The app's motion system: durations, presets and the settled-state guarantee.
 * The components that use them (MotionRoot, ExpandingPanel) live next door in
 * motionUi.jsx: split so this file stays plain logic, and so the component file
 * exports components and nothing else.
 *
 * WHAT THIS IS FOR: motion here is feedback, never decoration. A confirmation
 * slides in so the eye lands on it; a drawer slides so its direction of travel
 * explains where it came from; a new row is tinted so the record just created is
 * findable. Nothing animates a page, nothing animates on scroll (see README §9),
 * and no animation may make the desk wait: every duration below is inside the
 * 150–300ms band, which is where a controlled action stops feeling instant.
 *
 * ONE ANIMATOR PER ELEMENT: the charts keep their own library's animation
 * (Recharts) and are never also driven from here: two systems writing the same
 * transform is how a bar ends up fighting itself. Chart durations are read from
 * `DURATION.chart` below so the whole app still shares one scale.
 *
 * WHY THE SETTLE CLASS EXISTS (`useSettled` + `.motion-settled` in index.css):
 * an animation library positions elements by writing inline styles, so a
 * renderer that never advances its animation timeline: a throttled background
 * webview, a non-compositing embed, a machine under enough load to starve the
 * frame loop, would leave the element parked where the animation STARTED: a
 * drawer stuck off-screen, a confirmation stuck invisible, an edit panel stuck
 * at zero height. `useSettled` fires once the animation would be over and adds
 * the class, whose declarations (with `!important`) assert the resting state
 * over whatever inline style is there. Where an element rests never depends on
 * a frame having been painted. This is the guarantee the drawer's CSS keyframes
 * used to provide, carried over to Motion.
 */

/** Durations, in seconds: all inside the 150–300ms band. */
export const DURATION = {
  /** A confirmation or error notice appearing/leaving. */
  notice: 0.2,
  /** The nav drawer sliding, and its scrim fading alongside it. */
  drawer: 0.18,
  /** An edit panel opening. */
  panel: 0.18,
  /** The tint on a row that was just created, fading away. */
  arrival: 0.28,
  /** A chart drawing itself in, on its own library's animation (never this one). */
  chart: 0.28,
};

/** One easing for every screen: fast out of the gate, soft at the end. */
export const EASE = 'easeOut';

/** How long after an animation starts its resting state is asserted. */
const SETTLE_MS = 260;

/** The class that asserts an element's resting state (see index.css). */
export const SETTLED_CLASS = 'motion-settled';

/** `className` plus the settle class once the animation would be over. */
export function settled(className, isSettled) {
  return isSettled ? `${className} ${SETTLED_CLASS}`.trim() : className;
}

/**
 * True once the animation started by `identity` would be over: the signal to
 * add `motion-settled`.
 *
 * `identity` is what makes this safe to reuse: it must be a VALUE THAT IS FRESH
 * FOR EACH APPEARANCE (`true` for something that mounts when it animates, the
 * open token of a drawer, the message of a notice). Two appearances with the
 * same identity are the same animation as far as this is concerned, which is
 * exactly right for a message that is merely re-rendered with new text.
 *
 * State rather than a ref, because the resting style has to be part of the
 * render: a class toggled imperatively would vanish the next time React
 * re-wrote the element's className.
 */
export function useSettled(identity, ms = SETTLE_MS) {
  const [settledFor, setSettledFor] = useState(null);
  useEffect(() => {
    if (identity == null) return undefined;
    const timer = setTimeout(() => setSettledFor(identity), ms);
    return () => clearTimeout(timer);
  }, [identity, ms]);
  return identity != null && settledFor === identity;
}

/** A notice's enter and leave. Paired with AnimatePresence at the call site. */
export const NOTICE = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: DURATION.notice, ease: EASE },
};

/** An edit panel opening: height 0 → its own height. */
export const PANEL = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  transition: { duration: DURATION.panel, ease: EASE },
};

/**
 * The tint a brand-new row wears for a moment, then the same colour at zero
 * alpha that it fades to.
 *
 * Spelled as a colour value rather than `var(--color-offering-50)` →
 * `transparent` because both ends have to be values Motion can interpolate, and
 * that pair is not: a variable reference is not a colour it can read, and
 * `transparent` is not one it can mix with a solid, so instead of fading, the
 * highlight snapped. The hex is `--color-offering-50` in index.css, and
 * motion.test.jsx reads that token so the two cannot drift apart.
 */
export const ARRIVAL_TINT = '#FBEBEC';
export const ARRIVAL_CLEAR = 'rgba(251, 235, 236, 0)';

/**
 * The animation a row newly added to a list plays: tinted, then clean. Keyframes
 * rather than `initial`, so a renderer that never paints a frame leaves NO
 * inline style at all: the row is simply untinted, which is where it was going
 * to end up anyway.
 */
export const ARRIVAL = {
  animate: { backgroundColor: [ARRIVAL_TINT, ARRIVAL_CLEAR] },
  transition: { duration: DURATION.arrival, ease: EASE },
};
