import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import MemberPicker from './MemberPicker';
import api from '../api';
import i18n from '../i18n';

// Only the HTTP client is faked; the picker's own debounce and filtering run for
// real so the tests exercise the behaviour a receptionist gets.
vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual.default, get: vi.fn() } };
});

const MEMBERS = {
  Elisha: [{ id: 7, name: 'Elisha Makala', center_name: 'Mbezi Juu', zone_name: 'Zone A' }],
  Neema: [{ id: 9, name: 'Neema Joseph', center_name: 'Mbezi Juu', zone_name: 'Zone B' }],
};

// The offering form's contract: `selected` is always an array, and recording an
// offering clears it. The harness mirrors both so the reset is testable.
function Harness({ single, tone, freetextKey, allowFreetext }) {
  const [selected, setSelected] = useState([]);
  return (
    <div>
      <MemberPicker
        single={single}
        tone={tone}
        freetextKey={freetextKey}
        allowFreetext={allowFreetext}
        selected={selected}
        onChange={setSelected}
        placeholder="Search giver by name…"
      />
      <output data-testid="value">{JSON.stringify(selected)}</output>
      <button type="button" onClick={() => setSelected([])}>
        Record offering
      </button>
    </div>
  );
}

function selectedValue() {
  return JSON.parse(screen.getByTestId('value').textContent);
}

const user = () => userEvent.setup();

async function pick(u, query, name) {
  await u.clear(screen.getByRole('textbox'));
  await u.type(screen.getByRole('textbox'), query);
  const option = await screen.findByRole('button', { name: new RegExp(name) }, { timeout: 3000 });
  await u.click(option);
}

beforeEach(async () => {
  api.get.mockImplementation((url, { params } = {}) => {
    const search = params?.search || '';
    const members = MEMBERS[search] || [];
    return Promise.resolve({ data: { members } });
  });
  await i18n.changeLanguage('en');
});

describe('MemberPicker: single select (offering giver)', () => {
  it('starts as the giver search field with nothing selected', () => {
    render(<Harness single tone="offering" />);
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', 'Search giver by name…');
    expect(selectedValue()).toEqual([]);
  });

  it('replaces the search field with one confirmed state once a member is picked', async () => {
    const u = user();
    render(<Harness single tone="offering" />);

    await pick(u, 'Elisha', 'Elisha Makala');

    // The field itself shows the pick: no search box left above a stray chip.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('Elisha Makala')).toBeInTheDocument();
    expect(selectedValue()).toEqual([{ memberId: 7, name: 'Elisha Makala' }]);
  });

  it('wears the offerings colour, never the attendance/people green', async () => {
    const u = user();
    render(<Harness single tone="offering" />);

    await pick(u, 'Elisha', 'Elisha Makala');

    const field = screen.getByTitle('Change').closest('div');
    expect(field).toHaveClass('bg-offering-50');
    expect(field).toHaveClass('border-offering-300');
    expect(field).not.toHaveClass('bg-people-50');
  });

  it('uses the people tone when the caller asks for it', async () => {
    const u = user();
    render(<Harness single tone="people" />);

    await pick(u, 'Elisha', 'Elisha Makala');

    const field = screen.getByTitle('Change').closest('div');
    expect(field).toHaveClass('bg-people-50');
    expect(field).not.toHaveClass('bg-offering-50');
  });

  it('replaces (never adds to) the selection when another name is picked', async () => {
    const u = user();
    render(<Harness single tone="offering" />);

    await pick(u, 'Elisha', 'Elisha Makala');
    await u.click(screen.getByTitle('Change'));
    await pick(u, 'Neema', 'Neema Joseph');

    expect(selectedValue()).toEqual([{ memberId: 9, name: 'Neema Joseph' }]);
    expect(screen.queryByText('Elisha Makala')).toBeNull();
    expect(screen.queryAllByTitle('Remove')).toHaveLength(1);
  });

  it('clears back to an empty search field when the × is used', async () => {
    const u = user();
    render(<Harness single tone="offering" />);

    await pick(u, 'Elisha', 'Elisha Makala');
    await u.click(screen.getByRole('button', { name: 'Remove Elisha Makala' }));

    expect(selectedValue()).toEqual([]);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('offers a "record as typed" path when no member matches, and flags it as not a member', async () => {
    const u = user();
    render(<Harness single tone="offering" freetextKey="receptionist.giverFreetext" />);

    await u.type(screen.getByRole('textbox'), 'Visitor One');

    expect(await screen.findByText('No matching members.', {}, { timeout: 3000 })).toBeInTheDocument();
    await u.click(await screen.findByRole('button', { name: /Record "Visitor One" as typed/ }));

    expect(selectedValue()).toEqual([{ memberId: null, name: 'Visitor One' }]);
    expect(screen.getByText('Visitor One')).toBeInTheDocument();
    // The free-text case is labelled, not silently indistinguishable from a member.
    expect(screen.getByText('Not a member, recorded as typed')).toBeInTheDocument();
  });

  it('can refuse a typed name outright, for a field that must resolve to a member', async () => {
    const u = user();
    render(<Harness single tone="people" allowFreetext={false} />);

    await u.type(screen.getByRole('textbox'), 'Visitor One');

    expect(await screen.findByText('No matching members.', {}, { timeout: 3000 })).toBeInTheDocument();
    // A zone leader has to be somebody the church can open and reach, so there
    // is no "as typed" escape hatch…
    expect(screen.queryByRole('button', { name: /as typed/ })).toBeNull();
    // …and Enter cannot smuggle one in either.
    await u.keyboard('{Enter}');
    expect(selectedValue()).toEqual([]);
  });

  it('returns to the empty/ready state when the parent clears the selection after recording', async () => {
    const u = user();
    render(<Harness single tone="offering" />);

    await pick(u, 'Elisha', 'Elisha Makala');
    await u.click(screen.getByRole('button', { name: 'Record offering' }));

    expect(selectedValue()).toEqual([]);
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByText('Elisha Makala')).toBeNull();
  });

  it('drops a half-finished change when the parent clears the selection', async () => {
    const u = user();
    render(<Harness single tone="offering" />);

    await pick(u, 'Elisha', 'Elisha Makala');
    // Reopened for changing, then the receptionist records (or switches offering
    // type) before picking a replacement: the stale name must not survive.
    await u.click(screen.getByTitle('Change'));
    expect(screen.getByRole('textbox')).toHaveValue('Elisha Makala');

    await u.click(screen.getByRole('button', { name: 'Record offering' }));

    expect(selectedValue()).toEqual([]);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});

describe('MemberPicker: list mode (attendance, groups)', () => {
  it('keeps the search box and stacks one removable chip per person', async () => {
    const u = user();
    render(<Harness />);

    await pick(u, 'Elisha', 'Elisha Makala');
    await pick(u, 'Neema', 'Neema Joseph');

    // Two people, two chips, search box still available for a third.
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(selectedValue()).toEqual([
      { memberId: 7, name: 'Elisha Makala' },
      { memberId: 9, name: 'Neema Joseph' },
    ]);
    expect(screen.getAllByTitle('Remove')).toHaveLength(2);
  });

  it('does not show the single-select confirmed field', async () => {
    const u = user();
    render(<Harness />);

    await pick(u, 'Elisha', 'Elisha Makala');

    const chips = screen.getAllByTitle('Remove')[0].closest('ul');
    expect(within(chips).getByText('Elisha Makala')).toBeInTheDocument();
    expect(screen.queryByTitle('Change')).toBeNull();
  });
});
