'use client';

import type { DateOption } from '@/lib/flex-search';

// ─── Formatting helpers ───────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };

function parseUtcDate(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00Z');
}

function fmtDayLabel(dateStr: string): string {
  const d = parseUtcDate(dateStr);
  return DAY_NAMES[d.getUTCDay()];
}

function fmtDateNum(dateStr: string): string {
  const d = parseUtcDate(dateStr);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function fmtPrice(price: number | null, currency: string): string {
  if (price === null) return '—';
  const sym = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  if (price >= 10_000) return `${sym}${Math.round(price / 1000)}k`;
  if (price >= 1_000)  return `${sym}${(price / 1000).toFixed(1)}k`;
  return `${sym}${price}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  options:      DateOption[];
  selectedDate: string;
  onSelect:     (date: string) => void;
}

export function DateStrip({ options, selectedDate, onSelect }: Props) {
  return (
    <div className="date-strip" role="group" aria-label="Select departure date">
      {options.map(opt => {
        const isActive = opt.date === selectedDate;
        const isEmpty  = opt.routeCount === 0;

        return (
          <button
            key={opt.date}
            className={[
              'date-option',
              isActive ? 'date-option-active' : '',
              isEmpty  ? 'date-option-empty'  : '',
            ].filter(Boolean).join(' ')}
            onClick={() => !isEmpty && onSelect(opt.date)}
            aria-pressed={isActive}
            aria-label={`${fmtDayLabel(opt.date)} ${fmtDateNum(opt.date)}${opt.cheapestPrice !== null ? `, from ${fmtPrice(opt.cheapestPrice, opt.currency)}` : ', no flights'}`}
            disabled={isEmpty && !isActive}
          >
            <span className="date-option-day">{fmtDayLabel(opt.date)}</span>
            <span className="date-option-num">{fmtDateNum(opt.date)}</span>
            <span className="date-option-price">{fmtPrice(opt.cheapestPrice, opt.currency)}</span>
          </button>
        );
      })}
    </div>
  );
}
