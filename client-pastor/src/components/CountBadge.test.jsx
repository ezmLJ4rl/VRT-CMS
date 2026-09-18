import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';

import CountBadge from './CountBadge';

// The badge is one component rendered in three places (both nav presentations
// and the Home notifications tile), which is what makes those three consistent
// rather than merely similar.
describe('CountBadge', () => {
  it('renders nothing at zero, so an item with nothing waiting has no bubble', () => {
    expect(render(<CountBadge count={0} />).container).toBeEmptyDOMElement();
    expect(render(<CountBadge />).container).toBeEmptyDOMElement();
  });

  it('shows the count, tabular so the pill does not jump between values', () => {
    const { container } = render(<CountBadge count={3} />);

    expect(container.textContent).toBe('3');
    expect(container.firstChild.className).toContain('tabular-nums');
  });

  it('uses the brand fill by default and the alert fill when asked for it', () => {
    expect(render(<CountBadge count={1} />).container.firstChild.className).toContain('bg-brand-600');
    expect(render(<CountBadge count={1} tone="danger" />).container.firstChild.className).toContain('bg-danger-600');
  });

  it('clamps a three-digit count so the pill cannot outgrow its icon', () => {
    expect(render(<CountBadge count={150} />).container.textContent).toBe('99+');
    expect(render(<CountBadge count={99} />).container.textContent).toBe('99');
  });
});
