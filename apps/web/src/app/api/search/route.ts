/**
 * POST /api/search
 *
 * Accepts a route search request and returns a FlexSearchResult covering
 * the requested date ±3 days. Each date is searched independently
 * (parallel Amadeus calls in live mode; mock derivation in demo mode).
 *
 * Always returns HTTP 200. Errors are surfaced in the response body.
 */

import type { SearchMode, RoutingErrorCode } from '@travel-ai/types';
import { isValidIata, isValidFutureDate } from '@travel-ai/utils';
import { flexLiveSearch, flexMockSearch, type FlexSearchResult } from '@/lib/flex-search';

// ─── Request shape ────────────────────────────────────────────────────────────

interface SearchBody {
  origin:        string;
  destination:   string;
  departureDate: string;
  mode:          SearchMode;
  currency?:     string;
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function flexErrorResult(
  body:    Omit<SearchBody, 'currency'>,
  code:    RoutingErrorCode,
  message: string,
): FlexSearchResult {
  return {
    selectedDate: body.departureDate,
    dateOptions:  [],
    resultsByDate: {},
    mode:         body.mode,
    generatedAt:  new Date().toISOString(),
    errors:       [{ code, message }],
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // Parse body
  let body: Partial<SearchBody>;
  try {
    body = await request.json() as Partial<SearchBody>;
  } catch {
    return Response.json(
      { selectedDate: '', dateOptions: [], resultsByDate: {}, mode: 'best_overall',
        generatedAt: new Date().toISOString(),
        errors: [{ code: 'NO_ROUTES_FOUND', message: 'Invalid request body.' }] },
      { status: 200 },
    );
  }

  const {
    origin        = '',
    destination   = '',
    departureDate = '',
    mode          = 'best_overall',
    currency      = 'USD',
  } = body;

  const safeBody = { origin, destination, departureDate, mode };

  // Validate inputs
  if (!isValidIata(origin.toUpperCase())) {
    return Response.json(
      flexErrorResult(safeBody, 'INVALID_IATA', `"${origin}" is not a valid 3-letter IATA code.`),
      { status: 200 },
    );
  }
  if (!isValidIata(destination.toUpperCase())) {
    return Response.json(
      flexErrorResult(safeBody, 'INVALID_IATA', `"${destination}" is not a valid 3-letter IATA code.`),
      { status: 200 },
    );
  }
  if (!isValidFutureDate(departureDate)) {
    return Response.json(
      flexErrorResult(safeBody, 'INVALID_DATE', `"${departureDate}" is not a valid future date (YYYY-MM-DD).`),
      { status: 200 },
    );
  }

  const params = {
    origin:        origin.toUpperCase(),
    destination:   destination.toUpperCase(),
    departureDate,
    passengers:    1,
    currency:      currency.toUpperCase(),
  };

  // Decide: live Amadeus or demo mock
  const useMock =
    !process.env.AMADEUS_CLIENT_ID ||
    !process.env.AMADEUS_CLIENT_SECRET;

  if (useMock) {
    const result = await flexMockSearch({ ...params, mode });
    return Response.json(result, {
      status:  200,
      headers: { 'X-Demo-Mode': 'true' },
    });
  }

  // Live flex search — per-date errors are handled inside flexLiveSearch
  try {
    const result = await flexLiveSearch(params, mode);
    return Response.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not reach the flight data provider.';
    return Response.json(
      flexErrorResult(safeBody, 'PROVIDER_TIMEOUT', message),
      { status: 200 },
    );
  }
}
