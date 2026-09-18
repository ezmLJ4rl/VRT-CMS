import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import GivingByPayment from './GivingByPayment';
import i18n from '../i18n';

/*
 * The card is the whole of the pastor's view of how money arrived, so it is
 * tested for the two things that matter about it: the totals are the ledger's
 * own, and nothing travels with them that the pastor has no business seeing.
 */
afterEach(async () => {
  await i18n.changeLanguage('en');
});

// A day's giving with the details the API really returns alongside the method:
// the giver (decrypted for a pastor) and the payment reference they wrote down.
const OFFERINGS = [
  { id: 1, payment_method: 'cash', amount: 50000, currency: 'TZS', offererName: 'Ruth Mwita', payment_reference: null },
  { id: 2, payment_method: 'mobile_money', amount: 30000, currency: 'TZS', offererName: 'Peter Sanga', payment_reference: 'MP240916001' },
  { id: 3, payment_method: 'cash', amount: 20000, currency: 'TZS', offererName: null, payment_reference: null },
];

// The card is found by its own heading, in whichever language is on, so a
// Kiswahili assertion is about the same card, not about a looser query.
const card = (heading = /How giving came in/) => screen.getByRole('heading', { name: heading }).closest('section');
const rowFor = (label, root = card()) => within(root).getByText(label).closest('li');

describe('GivingByPayment', () => {
  it('totals each method and says how many gifts are behind it', () => {
    render(<GivingByPayment offerings={OFFERINGS} />);

    expect(within(rowFor('Cash')).getByText('70,000 TZS')).toBeInTheDocument();
    expect(within(rowFor('Cash')).getByText('2 gifts')).toBeInTheDocument();
    expect(within(rowFor('Mobile money')).getByText('30,000 TZS')).toBeInTheDocument();
    expect(within(rowFor('Mobile money')).getByText('1 gift')).toBeInTheDocument();
  });

  it('lists only the methods that took money, in the same order every time', () => {
    render(<GivingByPayment offerings={OFFERINGS} />);

    const labels = within(card()).getAllByRole('listitem').map((li) => li.textContent);
    expect(labels[0]).toContain('Cash');
    expect(labels[1]).toContain('Mobile money');
    expect(within(card()).queryByText('Bank transfer')).not.toBeInTheDocument();
    expect(within(card()).queryByText('Cheque')).not.toBeInTheDocument();
  });

  it('names a gift with no recorded method honestly, and does not count it as cash', () => {
    render(<GivingByPayment offerings={[...OFFERINGS, { id: 4, payment_method: null, amount: 5000, currency: 'TZS' }]} />);

    expect(within(rowFor('Not recorded')).getByText('5,000 TZS')).toBeInTheDocument();
    expect(within(rowFor('Cash')).getByText('70,000 TZS')).toBeInTheDocument();
    expect(within(card()).getByText(/not treated as cash/)).toBeInTheDocument();
  });

  it('never shows a giver or a payment reference: a method total is not a ledger of people', () => {
    render(<GivingByPayment offerings={OFFERINGS} />);

    expect(within(card()).queryByText('Ruth Mwita')).not.toBeInTheDocument();
    expect(within(card()).queryByText('Peter Sanga')).not.toBeInTheDocument();
    expect(within(card()).queryByText('MP240916001')).not.toBeInTheDocument();
  });

  it('says the period recorded no giving rather than showing an empty list', () => {
    render(<GivingByPayment offerings={[]} />);

    expect(within(card()).getByText('No offerings recorded in this period.')).toBeInTheDocument();
  });

  it('labels the methods in Kiswahili for a Kiswahili reader', async () => {
    await i18n.changeLanguage('sw');
    render(<GivingByPayment offerings={OFFERINGS} />);

    const sw = card(/Sadaka zilivyolipwa/);
    expect(within(rowFor('Fedha taslimu', sw)).getByText('70,000 TZS')).toBeInTheDocument();
    expect(within(rowFor('Pesa za simu', sw)).getByText('30,000 TZS')).toBeInTheDocument();
    expect(within(rowFor('Sadaka 2', sw)).getByText('70,000 TZS')).toBeInTheDocument();
  });
});
