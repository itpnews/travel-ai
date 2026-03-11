/**
 * POST /api/search
 *
 * Accepts a route search request, calls the Amadeus API if credentials are
 * configured, and falls back to the local mock adapter otherwise.
 *
 * Always returns HTTP 200 with a SearchResult JSON body. API-level errors are
 * surfaced through SearchResult.errors[] so the client has a single code path.
 */

import type { SearchResult, SearchMode, RoutingErrorCode } from '@travel-ai/types';
import { isValidIata, isValidFutureDate } from '@travel-ai/utils';
import { fetchFlightOffers, AmadeusApiError } from '@/lib/amadeus';
import { normalizeAmadeusResponse } from '@/lib/normalize';
import { enrichRoutes } from '@/lib/enrichment';
import { mockSearch } from '@/lib/mock';

// ─── Request shape ────────────────────────────────────────────────────────────

interface SearchBody {
  origin:        string;
  destination:   string;
  departureDate: string;
  mode:          SearchMode;
  currency?:     string;
}

// ─── Error helpers ────────────────────────────────────────────────────────────

function errorResult(
  body:    Omit<SearchBody, 'currency'>,
  code:    RoutingErrorCode,
  message: string,
): SearchResult {
  return {
    params: {
      origin:        body.origin,
      destination:   body.destination,
      departureDate: body.departureDate,
      passengers:    1,
      currency:      'USD',
    },
    routes:      [],
    mode:        body.mode,
    generatedAt: new Date().toISOString(),
    errors:      [{ code, message }],
  };
}

function mapAmadeusError(err: AmadeusApiError): RoutingErrorCode {
  if (err.status === 429) return 'API_RATE_LIMIT';
  if (err.status >= 500)  return 'PROVIDER_TIMEOUT';
  const title = err.message.toLowerCase();
  if (title.includes('date'))     return 'INVALID_DATE';
  if (title.includes('location') || title.includes('airport')) return 'INVALID_AIRPORT';
  return 'PROVIDER_TIMEOUT';
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  // Parse body
  let body: Partial<SearchBody>;
  try {
    body = await request.json() as Partial<SearchBody>;
  } catch {
    return Response.json(
      { routes: [], errors: [{ code: 'NO_ROUTES_FOUND', message: 'Invalid request body.' }] },
      { status: 200 },
    );
  }

  const { origin = '', destination = '', departureDate = '', mode = 'best_overall', currency = 'USD' } = body;
  const safeBody = { origin, destination, departureDate, mode };

  // Validate inputs
  if (!isValidIata(origin.toUpperCase())) {
    return Response.json(
      errorResult(safeBody, 'INVALID_IATA', `"${origin}" is not a valid 3-letter IATA code.`),
      { status: 200 },
    );
  }
  if (!isValidIata(destination.toUpperCase())) {
    return Response.json(
      errorResult(safeBody, 'INVALID_IATA', `"${destination}" is not a valid 3-letter IATA code.`),
      { status: 200 },
    );
  }
  if (!isValidFutureDate(departureDate)) {
    return Response.json(
      errorResult(safeBody, 'INVALID_DATE', `"${departureDate}" is not a valid future date (YYYY-MM-DD).`),
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

  // Decide: live Amadeus or local mock
  const useMock =
    !process.env.AMADEUS_CLIENT_ID ||
    !process.env.AMADEUS_CLIENT_SECRET;

  if (useMock) {
    const result = await mockSearch({ origin, destination, departureDate, mode });
    return Response.json(result, {
      status:  200,
      headers: { 'X-Demo-Mode': 'true' },
    });
  }

  // Live Amadeus path
  try {
    const raw = await fetchFlightOffers({
      originLocationCode:      params.origin,
      destinationLocationCode: params.destination,
      departureDate:           params.departureDate,
      adults:                  1,
      currencyCode:            params.currency,
      max:                     20,
    });

    if (!raw.data || raw.data.length === 0) {
      return Response.json(
        errorResult(safeBody, 'NO_ROUTES_FOUND', `No flights found for ${params.origin} → ${params.destination} on ${params.departureDate}.`),
        { status: 200 },
      );
    }

    const result = normalizeAmadeusResponse(raw, params, mode);
    enrichRoutes(result.routes, mode);
    return Response.json(result, { status: 200 });

  } catch (err) {
    if (err instanceof AmadeusApiError) {
      const code = mapAmadeusError(err);
      return Response.json(
        errorResult(safeBody, code, err.detail ?? err.message),
        { status: 200 },
      );
    }

    // Network / unexpected error
    return Response.json(
      errorResult(safeBody, 'PROVIDER_TIMEOUT', 'Could not reach the flight data provider. Please try again.'),
      { status: 200 },
    );
  }
}
