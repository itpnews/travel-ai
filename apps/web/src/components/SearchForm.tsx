'use client';

import type { SearchMode } from '@travel-ai/types';

const MODES: { value: SearchMode; label: string }[] = [
  { value: 'best_overall',       label: 'Best overall' },
  { value: 'safest',             label: 'Safest' },
  { value: 'best_value',         label: 'Best value' },
  { value: 'fastest_home',       label: 'Fastest' },
  { value: 'urgent_get_me_home', label: 'Urgent — get me home' },
];

export interface SearchInput {
  origin:        string;
  destination:   string;
  departureDate: string;
  mode:          SearchMode;
}

interface Props {
  onSearch: (input: SearchInput) => void;
  loading:  boolean;
}

export function SearchForm({ onSearch, loading }: Props) {
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    onSearch({
      origin:        (fd.get('origin')       as string).trim().toUpperCase(),
      destination:   (fd.get('destination')  as string).trim().toUpperCase(),
      departureDate: fd.get('departureDate') as string,
      mode:          (fd.get('mode')         as SearchMode) || 'best_overall',
    });
  }

  const defaultDate = new Date(Date.now() + 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);

  return (
    <form className="search-form" onSubmit={handleSubmit} aria-label="Flight search">

      <label className="search-field field-origin">
        <span className="search-field-label">From</span>
        <input
          name="origin"
          type="text"
          placeholder="LHR"
          maxLength={3}
          required
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <span className="search-sep" aria-hidden="true">→</span>

      <label className="search-field field-destination">
        <span className="search-field-label">To</span>
        <input
          name="destination"
          type="text"
          placeholder="JFK"
          maxLength={3}
          required
          autoComplete="off"
          spellCheck={false}
        />
      </label>

      <label className="search-field field-date">
        <span className="search-field-label">Date</span>
        <input
          name="departureDate"
          type="date"
          defaultValue={defaultDate}
          required
        />
      </label>

      <label className="search-field field-mode">
        <span className="search-field-label">Mode</span>
        <select name="mode" defaultValue="best_overall">
          {MODES.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </label>

      <button type="submit" className="search-btn" disabled={loading}>
        {loading ? '…' : 'Search'}
      </button>
    </form>
  );
}
