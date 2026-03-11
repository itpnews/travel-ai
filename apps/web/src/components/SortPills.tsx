'use client';

export type SortKey = 'best' | 'cheapest' | 'fastest' | 'safest';

const PILLS: { key: SortKey; label: string }[] = [
  { key: 'best',     label: 'Best' },
  { key: 'cheapest', label: 'Cheapest' },
  { key: 'fastest',  label: 'Fastest' },
  { key: 'safest',   label: 'Lowest risk' },
];

interface Props {
  active:   SortKey;
  onChange: (key: SortKey) => void;
}

export function SortPills({ active, onChange }: Props) {
  return (
    <div className="sort-pills" role="group" aria-label="Sort results">
      {PILLS.map(({ key, label }) => (
        <button
          key={key}
          className={`sort-pill ${active === key ? 'sort-pill-active' : ''}`}
          onClick={() => onChange(key)}
          aria-pressed={active === key}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
