import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { m, useReducedMotion } from 'motion/react';

import { DURATION, SETTLED_CLASS, settled, useSettled } from './motion';
import { MotionRoot } from './motionUi.jsx';

/*
 * The pastor app carries its own copy of the motion system (motion.js /
 * motionUi.jsx: the same file as the admin client's), so it needs its own
 * version of these guarantees: the resting state comes from CSS rather than from
 * a painted frame, a user who asked for less motion gets it, nothing animates
 * for longer than a third of a second, and the charts keep their own animator.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, rel), 'utf8');
const css = read('index.css').replace(/\s+/g, ' ');

describe('motion: the settled resting state', () => {
  it('is asserted from the stylesheet, over whatever inline style is there', () => {
    expect(css).toContain(`.${SETTLED_CLASS} { transform: none !important; opacity: 1 !important; height: auto !important; }`);
  });

  it('keeps the settle class out of the cascade for anything it was not applied to', () => {
    expect(settled('tile p-4', false)).toBe('tile p-4');
    expect(settled('tile p-4', true)).toBe(`tile p-4 ${SETTLED_CLASS}`);
    expect(settled('', true)).toBe(SETTLED_CLASS);
  });

  it('fires once the animation would be over, and starts over for a new appearance', async () => {
    // A second appearance in the same mounted component is a NEW animation: a
    // list that inherited the first one's settled state would stop animating.
    function Probe({ identity }) {
      const done = useSettled(identity, 40);
      return <span>{String(done)}</span>;
    }
    const { rerender } = render(<Probe identity="a" />);
    expect(screen.getByText('false')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('true')).toBeInTheDocument(), { timeout: 1000 });

    rerender(<Probe identity="b" />);
    expect(screen.getByText('false')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('true')).toBeInTheDocument(), { timeout: 1000 });
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
    withReducedMotion();
    render(
      <MotionRoot>
        <m.div data-testid="notice" initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.2 }}>
          notice
        </m.div>
      </MotionRoot>
    );
    await new Promise((r) => setTimeout(r, 60));
    const style = document.querySelector('[data-testid="notice"]').getAttribute('style') || '';
    expect(style).not.toMatch(/translateY\(-8px\)/);
  });

  it('still animates for a user who has not asked for it', async () => {
    render(
      <MotionRoot>
        <m.div data-testid="notice" initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.2 }}>
          notice
        </m.div>
      </MotionRoot>
    );
    // Guards the test above from passing because Motion never animates at all.
    expect(document.querySelector('[data-testid="notice"]').getAttribute('style') || '').toMatch(/translateY\(-8px\)/);
    await waitFor(() => expect(document.querySelector('[data-testid="notice"]').getAttribute('style') || '').not.toMatch(/translateY\(-8px\)/));
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
    expect(read('main.jsx')).toMatch(/<MotionRoot>[\s\S]*<App \/>[\s\S]*<\/MotionRoot>/);
  });

  it('leaves the charts to their own animator: one animation per element', () => {
    // The bars animate through Recharts, gated on the same setting through the
    // hook (the global CSS rule cannot reach a JS-driven animation) and timed
    // from the shared scale. A Motion component here would be a second system
    // writing the same element.
    for (const chart of ['components/BarChart.jsx']) {
      const source = read(chart);
      expect(source, `${chart} should gate the chart animation on reduced motion`).toContain('isAnimationActive={!reduced}');
      expect(source, `${chart} should take its duration from the shared scale`).toContain('DURATION.chart');
      expect(source, `${chart} must not import a Motion component`).not.toMatch(/import \{[^}]*\bm\b[^}]*\} from 'motion\/react'/);
    }
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
