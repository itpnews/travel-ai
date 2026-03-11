/**
 * Flex date search — evaluates a ±3-day window around the requested date.
 *
 * Each date is searched independently (parallel for live, derived for mock).
 * Results are normalised and enriched per date, then grouped into a single
 * FlexSearchResult that the API route returns and the UI consumes.
 */

import type {
  SearchResult,
  SearchParams,
  SearchMode,
  Route,
  RoutingError,
} from '@travel-ai/types';
import { fetchFlightOffers, AmadeusApiError } from './amadeus';
import { normalizeAmadeusResponse } from './normalize';
import { enrichRoutes } from './enrichment';
import { mockSearch } from './mock';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DateOption {
  /** YYYY-MM-DD */
  date: string;
  cheapestPrice: number | null;
  currency: string;
  bestScore: number | null;
  routeCount: number;
}

export interface FlexSearchResult {
  /** The date the user originally requested (center of the window) */
  selectedDate: string;
  /** Summary row for each date in the window — drives the date strip UI */
  dateOptions: DateOption[];
  /** Full SearchResult keyed by date — switch client-side on date selection */
  resultsByDate: Record<string, SearchResult>;
  mode: SearchMode;
  generatedAt: string;
  /** Top-level errors (e.g. validation). Per-date errors live inside resultsByDate. */
  errors?: RoutingError[];
}

// ─── Date window ──────────────────────────────────────────────────────────────

/** Returns 7 YYYY-MM-DD strings centred on centerDate (±3 days). */
export function getDateWindow(centerDate: string, delta = 3): string[] {
  const msPerDay = 86_400_000;
  const centerMs = new Date(centerDate + 'T00:00:00Z').getTime();
  const dates: string[] = [];
  for (let d = -delta; d <= delta; d++) {
    dates.push(new Date(centerMs + d * msPerDay).toISOString().slice(0, 10));
  }
  return dates;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function isTodayOrFuture(date: string): boolean {
  return date >= new Date().toISOString().slice(0, 10);
}

function emptyResult(params: SearchParams, mode: SearchMode): SearchResult {
  return { params, routes: [], mode, generatedAt: new Date().toISOString() };
}

function summarize(result: SearchResult): DateOption {
  const { routes } = result;
  const cheapestPrice = routes.length > 0
    ? Math.min(...routes.map((r: Route) => r.totalPrice))
    : null;
  const bestScore = routes.length > 0
    ? Math.max(...routes.map((r: Route) => r.score))
    : null;
  return {
    date:         result.params.departureDate,
    cheapestPrice,
    currency:     routes[0]?.currency ?? result.params.currency,
    bestScore,
    routeCount:   routes.length,
  };
}

// ─── Mock flex search ─────────────────────────────────────────────────────────

/**
 * Mock price multipliers per date-window slot (index 0 = -3 days, 6 = +3 days).
 * Gives the date strip realistic variation without randomness.
 */
const MOCK_FACTORS = [1.12, 1.05, 1.08, 1.00, 0.95, 0.88, 1.10] as const;

function scaleMockResult(base: SearchResult, date: string, factor: number): SearchResult {
  return {
    ...base,
    params: { ...base.params, departureDate: date },
    routes: base.routes.map((r: Route) => ({
      ...r,
      id:                  r.id + '-' + date,          // ensure unique IDs across dates
      actualDepartureDate: date,
      totalPrice:          Math.round(r.totalPrice * factor),
      budgetBand:          r.budgetBand,
    })),
  };
}

export async function flexMockSearch(
  input: { origin: string; destination: string; departureDate: string; mode: SearchMode },
): Promise<FlexSearchResult> {
  // Single mock call (includes its own simulated delay); all other dates are derived
  const base   = await mockSearch(input);
  const dates  = getDateWindow(input.departureDate);

  const resultsByDate: Record<string, SearchResult> = {};
  const dateOptions: DateOption[] = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    let result: SearchResult;

    if (!isTodayOrFuture(date)) {
      result = emptyResult({ ...base.params, departureDate: date }, input.mode);
    } else {
      result = scaleMockResult(base, date, MOCK_FACTORS[i] ?? 1.0);
    }

    resultsByDate[date] = result;
    dateOptions.push(summarize(result));
  }

  return {
    selectedDate: input.departureDate,
    dateOptions,
    resultsByDate,
    mode:        input.mode,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Live flex search ─────────────────────────────────────────────────────────

export async function flexLiveSearch(
  params:     SearchParams,
  mode:       SearchMode,
  maxPerDate  = 10,
): Promise<FlexSearchResult> {
  const dates = getDateWindow(params.departureDate);

  // Fetch all dates in parallel; per-date failures return empty (not fatal)
  const settled = await Promise.allSettled(
    dates.map(async (date): Promise<SearchResult> => {
      if (!isTodayOrFuture(date)) {
        return emptyResult({ ...params, departureDate: date }, mode);
      }
      try {
        const raw = await fetchFlightOffers({
          originLocationCode:      params.origin,
          destinationLocationCode: params.destination,
          departureDate:           date,
          adults:                  1,
          currencyCode:            params.currency,
          max:                     maxPerDate,
        });

        if (!raw.data || raw.data.length === 0) {
          return emptyResult({ ...params, departureDate: date }, mode);
        }

        const result = normalizeAmadeusResponse(raw, { ...params, departureDate: date }, mode);
        enrichRoutes(result.routes, mode);
        return result;

      } catch (err) {
        // Rate-limited or failed dates silently return empty — other dates still render
        if (err instanceof AmadeusApiError && err.status === 429) {
          console.warn(`[flex-search] Rate limited for ${date}, returning empty`);
        }
        return emptyResult({ ...params, departureDate: date }, mode);
      }
    }),
  );

  const resultsByDate: Record<string, SearchResult> = {};
  const dateOptions: DateOption[] = [];

  for (let i = 0; i < dates.length; i++) {
    const date  = dates[i];
    const s     = settled[i];
    const result = s.status === 'fulfilled'
      ? s.value
      : emptyResult({ ...params, departureDate: date }, mode);
    resultsByDate[date] = result;
    dateOptions.push(summarize(result));
  }

  return {
    selectedDate: params.departureDate,
    dateOptions,
    resultsByDate,
    mode,
    generatedAt: new Date().toISOString(),
  };
}
