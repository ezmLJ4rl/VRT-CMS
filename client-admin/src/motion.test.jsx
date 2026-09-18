import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { m, useReducedMotion } from 'motion/react';

import { ARRIVAL, ARRIVAL_CLEAR, ARRIVAL_TINT, DURATION, SETTLED_CLASS, settled, useSettled } from './motion';
import { MotionRoot } from './motionUi.jsx';

/*
 * The motion system is mostly invisible, a confirmation that slides in is a
 * confirmation either way, so what is pinned here is the part that is NOT
 * merely cosmetic:
 *
 *   1. the resting state is guaranteed by CSS, not by a frame having been
 *      painted (the .motion-settled rule, which has to use !important to beat
 *      the inline style Motion writes);
 *   2. a user who asked their system for less motion gets it, including from
 *      the animations Motion itself drives (the global CSS rule cannot reach
 *      those);
 *   3. no animation in the app is long enough to make the desk wait.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'index.css'), 'utf8').replace(/\s+/g, ' ');
const adminMain = fs.readFileSync(path.join(HERE, 'main.jsx'), 'utf8');

describe('motion: the settled resting state', () => {
  it('is asserted from the stylesheet, over whatever inline style is there', () => {
    // The three properties Motion writes while animating: the transform it
    // positions with, the opacity it fades with, the height a panel opens to.
    expect(css).toContain(`.${SETTLED_CLASS} { transform: none !important; opacity: 1 !important; height: auto !important; }`);
  });

  it('leaves exactly one animator for the drawer', () => {
    // The drawer's animation is Motion's now. If the old keyframe classes were
    // still here, two systems would be writing the same transform.
    expect(css).not.toContain('.drawer-in');
    expect(css).not.toContain('.overlay-in');
    expect(css).not.toContain('@keyframes drawer-in');
    expect(css).not.toContain('@keyframes overlay-in');
  });

  it('keeps the settle class out of the cascade for anything it was not applied to', () => {
    // One class, checked by name so a component cannot opt in by accident.
    expect(settled('tile p-4', false)).toBe('tile p-4');
    expect(settled('tile p-4', true)).toBe(`tile p-4 ${SETTLED_CLASS}`);
    expect(settled('', true)).toBe(SETTLED_CLASS);
  });

  it('fires once the animation would be over, and starts over for a new appearance', async () => {
    function Probe({ identity }) {
      const done = useSettled(identity, 40);
      return <span>{String(done)}</span>;
    }
    const { rerender } = render(<Probe identity="a" />);

    // Nothing is settled on the first paint: the animation owns the element.
    expect(screen.getByText('false')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('true')).toBeInTheDocument(), { timeout: 1000 });

    // A new appearance is a new animation, even in the same mounted component:
    // the drawer's second opening must not inherit the first one's settled state
    // (which would pin it in place instead of sliding).
    rerender(<Probe identity="b" />);
    expect(screen.getByText('false')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('true')).toBeInTheDocument(), { timeout: 1000 });
  });

  it('never settles an animation that has no identity', async () => {
    function Probe() {
      const done = useSettled(null, 20);
      return <span>{String(done)}</span>;
    }
    render(<Probe />);
    await new Promise((r) => setTimeout(r, 60));
    expect(screen.getByText('false')).toBeInTheDocument();
  });
});

describe('motion: the user’s own setting', () => {
  afterEach(() => vi.unstubAllGlobals());

  function withReducedMotion() {
    vi.stubGlobal('matchMedia', (query) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
  }

  it('is read from the system, not assumed', () => {
    withReducedMotion();
    function Probe() {
      return <span>{String(useReducedMotion())}</span>;
    }
    render(<Probe />);
    expect(screen.getByText('true')).toBeInTheDocument();
  });

  it('drops the transform animations when the system asks for less motion', async () => {
    function Slide() {
      return (
        <m.div data-testid="slide" initial={{ x: '-100%' }} animate={{ x: 0 }} transition={{ duration: 0.2 }}>
          panel
        </m.div>
      );
    }
    // With the setting on, MotionConfig reducedMotion="user" skips transform
    // animations: the panel is simply at rest, never parked off-screen.
    withReducedMotion();
    render(
      <MotionRoot>
        <Slide />
      </MotionRoot>
    );
    await new Promise((r) => setTimeout(r, 60));
    const style = document.querySelector('[data-testid="slide"]').getAttribute('style') || '';
    expect(style).not.toMatch(/translateX\(-100%\)/);
  });

  it('still animates for a user who has not asked for it', async () => {
    render(
      <MotionRoot>
        <m.div data-testid="slide" initial={{ x: '-100%' }} animate={{ x: 0 }} transition={{ duration: 0.2 }}>
          panel
        </m.div>
      </MotionRoot>
    );
    // Guards the test above from passing because Motion never animates at all.
    expect(document.querySelector('[data-testid="slide"]').getAttribute('style') || '').toMatch(/translateX\(-100%\)/);
    await waitFor(() => expect(document.querySelector('[data-testid="slide"]').getAttribute('style') || '').not.toMatch(/translateX\(-100%\)/));
  });
});

describe('motion: the tint on a row that has just been added', () => {
  it('fades between two values the animation can actually interpolate', () => {
    // The first version of this animated `var(--color-offering-50)` →
    // `transparent`, which Motion cannot mix: the highlight snapped out instead
    // of fading, and only a console warning said so. Both ends are now the same
    // colour, one of them at zero alpha, and this is what says so.
    const [from, to] = ARRIVAL.animate.backgroundColor;
    expect(from).toBe(ARRIVAL_TINT);
    expect(to).toBe(ARRIVAL_CLEAR);

    const channels = (value) => (value.match(/\d+/g) || []).map(Number).slice(0, 3);
    const hex = ARRIVAL_TINT.match(/^#(\w\w)(\w\w)(\w\w)$/).slice(1).map((pair) => parseInt(pair, 16));
    expect(channels(ARRIVAL_CLEAR)).toEqual(hex);
    // Alpha of exactly zero: the row ends up as if nothing had ever been there.
    expect(ARRIVAL_CLEAR).toMatch(/rgba\([^)]*,\s*0\)$/);
  });

  it('wears the offering colour token, read out of the stylesheet', () => {
    // The tint is a literal colour (see above), so the token it was copied from
    // is checked here: change `--color-offering-50` and this test moves it.
    const token = css.match(/--color-offering-50:\s*(#[0-9A-Fa-f]{6})/);
    expect(token, 'index.css no longer defines --color-offering-50').not.toBeNull();
    expect(ARRIVAL_TINT.toUpperCase()).toBe(token[1].toUpperCase());
  });
});

describe('motion: the app-wide rules', () => {
  it('keeps every animation inside the 150–300ms band', () => {
    for (const [name, seconds] of Object.entries(DURATION)) {
      expect(seconds, `${name} is longer than the app allows`).toBeLessThanOrEqual(0.3);
      expect(seconds, `${name} is shorter than a perceptible transition`).toBeGreaterThanOrEqual(0.15);
    }
  });

  it('mounts the provider at the app root, so the setting is honoured everywhere', () => {
    // Rendering App without this loses reduced-motion handling (and leaves m
    // components unanimated): the one wiring mistake that would be invisible.
    expect(adminMain).toMatch(/<MotionRoot>[\s\S]*<App \/>[\s\S]*<\/MotionRoot>/);
  });
});

describe('motion: the guards that keep it the only animator', () => {
  /*
   * Everything below is a rule that decays SILENTLY: one eager import undoes the
   * lazy feature set with no error anywhere, and a second animation library
   * arrives as a single line in package.json. So they are pinned three ways: a
   * scan of the source, a scan of the dependencies, and the lint rule itself.
   */

  const CLIENT = path.join(HERE, '..');

  const sourceFiles = () =>
    fs
      .readdirSync(HERE, { recursive: true })
      .map(String)
      .filter((entry) => /\.(js|jsx|mjs)$/.test(entry))
      .map((entry) => path.join(HERE, entry));

  /** Every `import … from '<specifier>'` and `export … from '<specifier>'`. */
  function importsIn(source) {
    const found = [];
    const pattern = /(?:import|export)\s+([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = pattern.exec(source)) !== null) found.push({ clause: match[1], specifier: match[2] });
    return found;
  }

  it('never imports the eager `motion` component, and nothing from a second animator', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      for (const { clause, specifier } of importsIn(fs.readFileSync(file, 'utf8'))) {
        const eager = specifier === 'motion/react' && /\bmotion\b/.test(clause);
        const foreign =
          specifier === 'motion' || specifier === 'motion/react-m' || specifier.startsWith('framer-motion');
        if (eager || foreign) offenders.push(`${path.relative(CLIENT, file)}: ${clause} from '${specifier}'`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ships exactly one animation library', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(CLIENT, 'package.json'), 'utf8'));
    const installed = { ...pkg.dependencies, ...pkg.devDependencies };
    // Charts are allowed their own animation: one animator per ELEMENT, and the
    // chart's library is that animator. These are libraries that would fight
    // Motion for the elements Motion already owns.
    const others = [
      'framer-motion',
      'react-spring',
      '@react-spring/web',
      'gsap',
      'animejs',
      'auto-animate',
      '@formkit/auto-animate',
      'lottie-react',
      'react-transition-group',
      'popmotion',
      'rc-motion',
      '@use-gesture/react',
    ];
    expect(others.filter((name) => name in installed)).toEqual([]);
    expect(installed.motion, 'the one animation library').toBeTruthy();
  });

  it('keeps the lint rule that enforces the same thing', () => {
    // A test is easy to keep passing; a lint rule is easy to delete while fixing
    // lint. This says the rule is still there, still an error, and still about
    // the eager `motion` import.
    const config = JSON.parse(fs.readFileSync(path.join(CLIENT, '.oxlintrc.json'), 'utf8'));
    const rule = config.rules['no-restricted-imports'];
    expect(rule, 'no-restricted-imports must stay configured').toBeTruthy();
    expect(rule[0]).toBe('error');
    expect(JSON.stringify(rule)).toContain('"importNames":["motion"]');
  });
});
