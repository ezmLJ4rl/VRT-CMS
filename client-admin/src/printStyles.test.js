import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * "Print-only" is two rules, not one: a top-level `.print-only { display:
 * none }` that keeps the element off the screen, and a `.print-only
 * { display: block }` inside @media print that puts it on the paper.
 *
 * Getting half of it wrong is invisible until someone prints, which is
 * exactly how the first version of the masthead shipped. `.print-only`
 * was added to the print block's hide list instead, so the letterhead
 * rendered as loose text on the dashboard and would have vanished from
 * the paper. Nothing failed, because the component test can only see the
 * class names, not what the stylesheet does with them.
 *
 * So this reads index.css the way the browser splits it, top-level rules
 * for the screen, rules inside the print block for paper, and pins both
 * directions, plus the masthead's own rules.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, 'index.css'), 'utf8').replace(/\s+/g, ' ');

const printAt = css.indexOf('@media print');
const screenPart = css.slice(0, printAt);
const printPart = css.slice(printAt);

describe('print stylesheet', () => {
  it('splits the stylesheet into screen rules and a print block', () => {
    // Guards against the slices below passing because they are empty.
    expect(printAt).toBeGreaterThan(0);
    expect(screenPart).toContain('.no-print');
    expect(printPart).toContain('.print-masthead');
  });

  it('hides .print-only on the screen', () => {
    expect(screenPart).toContain('.print-only { display: none; }');
  });

  it('reveals .print-only on paper', () => {
    expect(printPart).toContain('.print-only { display: block !important; }');
  });

  it('never hides .print-only while printing', () => {
    // The exact mistake that shipped: .print-only in the print hide list.
    expect(printPart).toContain('header, nav, .no-print { display: none !important; }');
    expect(printPart).not.toContain('.no-print, .print-only');
  });

  it('keeps the masthead design in the print block', () => {
    for (const rule of ['.print-masthead-church', '.print-masthead-address', '.print-masthead-totals']) {
      expect(printPart).toContain(rule);
    }
  });
});
