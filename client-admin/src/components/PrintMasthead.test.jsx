import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import PrintMasthead from './PrintMasthead';
import i18n from '../i18n';

/*
 * The masthead exists only for the printed sheet, and its job is to make
 * the paper self-identifying: whose record, what it is, which day, and
 * what the tables below add up to. These tests pin that content, and
 * the .print-only class the print stylesheet in index.css relies on to
 * keep the block off the screen and on the paper.
 */
describe('PrintMasthead', () => {
  const t = (key) => i18n.t(key, { lng: 'en' });

  // formatDate goes through Intl, so the test derives the expected label
  // the same way rather than pinning a CLDR month spelling.
  const expectedDate = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date('2026-09-16T12:00:00'));

  it('renders the letterhead: church name, address, title, day and both totals', () => {
    render(
      <PrintMasthead
        date="2026-09-16"
        lang="en"
        people={87}
        offeringsTotal={[['TZS', 125000], ['USD', 40]]}
        t={t}
      />,
    );

    expect(screen.getByText('Victory Revival Temple')).toBeInTheDocument();
    expect(screen.getByText('Mbezi Juu, Dar es Salaam, Tanzania')).toBeInTheDocument();
    expect(screen.getByText('Day record: attendance & offerings')).toBeInTheDocument();
    expect(screen.getByText(expectedDate)).toBeInTheDocument();
    // Attendance is people, and the money line keeps the caller's order
    // (biggest first) with every currency on one line.
    expect(screen.getByText('87 people')).toBeInTheDocument();
    expect(screen.getByText('125,000 TZS · 40 USD')).toBeInTheDocument();
  });

  it('stays on the .print-only / .print-masthead contract with the print stylesheet', () => {
    const { container } = render(<PrintMasthead date="2026-09-16" lang="en" t={t} />);
    expect(container.firstChild).toHaveClass('print-only');
    expect(container.firstChild).toHaveClass('print-masthead');
  });

  it('falls back to the default currency and zero counts on an empty day', () => {
    render(<PrintMasthead date="2026-09-16" lang="en" people={0} offeringsTotal={[]} t={t} />);
    expect(screen.getByText('0 people')).toBeInTheDocument();
    expect(screen.getByText('0 TZS')).toBeInTheDocument();
  });
});
