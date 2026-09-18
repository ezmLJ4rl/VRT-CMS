import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, X, UserPlus, Check } from 'lucide-react';
import api from '../api';

// One picker, two shapes:
//
//   • list (default): a search box plus removable chips underneath. Right for
//     attendance lists and groups, where there can be many people at once.
//   • single: exactly one giver (an offering has one giver by definition), so
//     the field itself becomes the selected state instead of leaving an empty
//     search box above a floating chip. Picking a new name replaces the current
//     one; the field is the only place the value lives (Law of Proximity).
//
// `tone` colours the single-select field by the category whose data it feeds:
// offerings are the red family, people/attendance the green one.
//
// `freetextKey` lets the caller name what the person is being added *as*: the
// default suits an attendance list, while the groups screen adds a member and
// the offerings form records a giver. `allowFreetext` turns the typed-by-hand
// row off entirely, for a field that must resolve to a real member record (a
// zone leader is somebody the church has to be able to open and reach).
const SINGLE_TONES = {
  offering: { field: 'border-offering-300 bg-offering-50', name: 'text-offering-800', tick: 'bg-offering-600' },
  people: { field: 'border-people-300 bg-people-50', name: 'text-people-800', tick: 'bg-people-700' },
};

export default function MemberPicker({ selected, onChange, single, placeholder, freetextKey = 'members.addFreetext', tone = 'people', allowFreetext = true }) {
  const { t } = useTranslation();
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const boxRef = useRef(null);

  const pick = single ? selected[0] : null;
  const pickKey = pick ? `${pick.memberId ?? 'n'}:${pick.name}` : null;

  // The draft text and the "reopened for changing" flag are keyed to the pick
  // they belong to. So when the parent clears `selected`, after recording an
  // offering, or on an offering-type switch, nothing matches any more and the
  // field falls straight back to an empty search box, with no stale name and no
  // effect needed to undo it.
  const [editingKey, setEditingKey] = useState(null);
  const [draft, setDraft] = useState({ key: null, text: '' });
  const query = draft.key === pickKey ? draft.text : '';
  const changing = pickKey !== null && editingKey === pickKey;
  const setQuery = (text) => setDraft({ key: pickKey, text });

  // Single mode shows either the confirmed field or the search box, never both.
  const showSearch = !pick || changing;
  const toneStyles = SINGLE_TONES[tone] || SINGLE_TONES.people;

  useEffect(() => {
    const q = query.trim();
    if (!q || !showSearch) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api
        .get('/members', { params: { search: q, active: '1', limit: 8 } })
        .then(({ data }) => setResults(data.members))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, showSearch]);

  function commit(member) {
    const next = single ? [member] : [...selected, member];
    onChange(next);
  }

  function addMember(m) {
    if (single) {
      if (m && m.name) commit({ memberId: m.memberId ?? null, name: m.name });
    } else if (m && m.name && !selected.some((s) => s.memberId === m.memberId && s.memberId != null)) {
      commit({ memberId: m.memberId ?? null, name: m.name });
    } else if (m && m.name && !selected.some((s) => s.name.toLowerCase() === m.name.toLowerCase())) {
      commit({ memberId: null, name: m.name });
    }
    setDraft({ key: null, text: '' });
    setResults([]);
    setEditingKey(null);
  }

  function addFreetext() {
    const name = query.trim();
    if (!name) return;
    addMember({ name });
  }

  function clear() {
    onChange([]);
    setDraft({ key: null, text: '' });
    setResults([]);
    setEditingKey(null);
  }

  function stopChanging() {
    setDraft({ key: null, text: '' });
    setResults([]);
    setEditingKey(null);
  }

  function remove(idx) {
    onChange(selected.filter((_, i) => i !== idx));
  }

  const shown = results.filter((r) => !selected.some((s) => s.memberId === r.id && s.memberId != null));

  // Picked giver: the field *is* the selected state, in the category colour.
  if (pick && !changing) {
    return (
      <div ref={boxRef} className={`flex items-center gap-2 rounded-md border px-3 py-2 ${toneStyles.field}`}>
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white ${toneStyles.tick}`}>
          <Check size={12} strokeWidth={3} aria-hidden="true" />
        </span>
        <button
          type="button"
          onClick={() => {
            setQuery(pick.name);
            setEditingKey(pickKey);
          }}
          title={t('common.change')}
          className="min-w-0 flex-1 text-left"
        >
          <span className={`block truncate text-sm font-medium ${toneStyles.name}`}>{pick.name}</span>
          <span className="block truncate text-[11px] text-ink-400">
            {pick.memberId ? t('members.pickedFromDirectory') : t('members.typedByHand')}
          </span>
        </button>
        <button
          type="button"
          onClick={clear}
          title={t('common.remove')}
          aria-label={`${t('common.remove')} ${pick.name}`}
          className="shrink-0 rounded-full p-1 text-ink-400 transition-colors hover:bg-paper hover:text-ink-700"
        >
          <X size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2" ref={boxRef}>
      <div className="relative">
        <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              // Enter takes the typed name only where a typed name is a legal
              // answer: with freetext off it would commit a person with no
              // member record behind them.
              if (allowFreetext) addFreetext();
            }
            if (e.key === 'Escape' && single && pick) stopChanging();
          }}
          placeholder={placeholder || t('members.searchPlaceholder')}
          className={`w-full rounded-md border border-ink-200 py-2.5 pl-9 pr-3 text-base focus-visible:border-brand-600 ${single && pick ? 'pr-20' : ''}`}
        />
        {searching && (
          <span
            className={`absolute top-1/2 h-4 w-4 -translate-y-1/2 animate-spin rounded-full border-2 border-ink-200 border-t-brand-600 ${single && pick ? 'right-16' : 'right-3'}`}
          />
        )}
        {/* Backing out of a change keeps the current giver in place. */}
        {single && pick && (
          <button
            type="button"
            onClick={stopChanging}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-ink-400 hover:text-ink-700"
          >
            {t('common.cancel')}
          </button>
        )}

        {query.trim() && (
          <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border border-ink-200 bg-paper shadow-lg">
            {shown.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => addMember({ memberId: r.id, name: r.name })}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-ink-50"
                >
                  <span className="font-medium">{r.name}</span>
                  <span className="truncate pl-3 text-xs text-ink-400">
                    {r.center_name || ''} {r.center_name && r.zone_name ? `· ${r.zone_name}` : r.zone_name}
                  </span>
                </button>
              </li>
            ))}
            {shown.length === 0 && !searching && (
              <li className="px-3 py-2 text-sm text-ink-400">{t('members.noMatch')}</li>
            )}
            {allowFreetext && (
              <li>
                <button
                  type="button"
                  onClick={addFreetext}
                  className="flex w-full items-center justify-center gap-1.5 border-t border-ink-100 px-3 py-2 text-sm font-medium text-brand-800 hover:bg-brand-50"
                >
                  <UserPlus size={14} /> {t(freetextKey, { name: query.trim() })}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>

      {!single && selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((s, i) => (
            <li key={`${s.memberId ?? 'n'}-${s.name}-${i}`}>
              <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${s.memberId ? 'bg-people-50 text-people-700' : 'bg-ink-100 text-ink-700'}`}>
                {s.memberId == null && <UserPlus size={11} />}
                {s.name}
                <button type="button" onClick={() => remove(i)} className="rounded-full p-0.5 hover:bg-ink-200" title={t('common.remove')}>
                  <X size={11} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
