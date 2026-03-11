/**
 * Amadeus Self-Service API client.
 *
 * Handles OAuth2 token acquisition (client_credentials grant) with in-memory
 * caching, and provides fetchFlightOffers() for the flight search endpoint.
 *
 * Keys are read from process.env and must only be used server-side.
 * Never import this file from any client component.
 */

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = 'https://test.api.amadeus.com';
const TOKEN_URL = `${BASE_URL}/v1/security/oauth2/token`;
const SEARCH_URL = `${BASE_URL}/v2/shopping/flight-offers`;

/** Refresh the token 60 seconds before it expires to avoid races on expiry. */
const EXPIRY_BUFFER_MS = 60_000;

// ─── Amadeus response types ───────────────────────────────────────────────────

export interface AmadeusSegment {
  departure: { iataCode: string; terminal?: string; at: string };
  arrival:   { iataCode: string; terminal?: string; at: string };
  /** IATA marketing carrier code */
  carrierCode: string;
  /** Amadeus uses 'number', not 'flightNumber' */
  number: string;
  duration: string;        // ISO 8601 e.g. "PT7H55M"
  numberOfStops: number;
  aircraft?: { code: string };
  operating?: { carrierCode: string };
}

export interface AmadeusItinerary {
  duration: string;        // ISO 8601 total travel time
  segments: AmadeusSegment[];
}

export interface AmadeusFlightOffer {
  id: string;
  source: string;
  itineraries: AmadeusItinerary[];
  price: {
    total: string;         // numeric string e.g. "850.00"
    currency: string;
    grandTotal?: string;
  };
  travelerPricings?: Array<{
    fareDetailsBySegment: Array<{
      segmentId?: string;
      cabin: string;       // "ECONOMY" | "PREMIUM_ECONOMY" | "BUSINESS" | "FIRST"
      class?: string;
    }>;
  }>;
}

export interface AmadeusSearchResponse {
  data?: AmadeusFlightOffer[];
  errors?: Array<{
    status: number;
    code: number;
    title: string;
    detail?: string;
  }>;
}

// ─── Token cache ──────────────────────────────────────────────────────────────

interface TokenCache {
  value: string;
  expiresAt: number; // Date.now() ms
}

let _tokenCache: TokenCache | null = null;

async function fetchToken(): Promise<string> {
  if (_tokenCache && Date.now() < _tokenCache.expiresAt - EXPIRY_BUFFER_MS) {
    return _tokenCache.value;
  }

  const clientId     = process.env.AMADEUS_CLIENT_ID;
  const clientSecret = process.env.AMADEUS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET are not set');
  }

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AmadeusApiError(res.status, 0, `Token fetch failed: ${res.status}`, text);
  }

  const data = await res.json() as {
    access_token: string;
    expires_in: number;
    token_type: string;
  };

  _tokenCache = {
    value:     data.access_token,
    expiresAt: Date.now() + data.expires_in * 1_000,
  };

  return _tokenCache.value;
}

// ─── Custom error ─────────────────────────────────────────────────────────────

export class AmadeusApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'AmadeusApiError';
  }
}

// ─── Flight offers search ─────────────────────────────────────────────────────

export interface AmadeusSearchParams {
  originLocationCode: string;
  destinationLocationCode: string;
  departureDate: string;   // YYYY-MM-DD
  adults: number;
  currencyCode?: string;
  max?: number;            // max results; Amadeus caps at 250 but we limit to 20
  nonStop?: boolean;
}

/**
 * Calls the Amadeus v2 Flight Offers Search endpoint.
 * Handles token acquisition transparently.
 * Throws AmadeusApiError on API-level failures.
 */
export async function fetchFlightOffers(
  params: AmadeusSearchParams,
): Promise<AmadeusSearchResponse> {
  const token = await fetchToken();

  const qs = new URLSearchParams({
    originLocationCode:      params.originLocationCode,
    destinationLocationCode: params.destinationLocationCode,
    departureDate:           params.departureDate,
    adults:                  String(params.adults),
    currencyCode:            params.currencyCode ?? 'USD',
    max:                     String(Math.min(params.max ?? 20, 20)),
  });

  if (params.nonStop !== undefined) {
    qs.set('nonStop', String(params.nonStop));
  }

  const res = await fetch(`${SEARCH_URL}?${qs.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Accept':      'application/json',
    },
    // Next.js 14 fetch: opt out of caching so each request is fresh
    cache: 'no-store',
  });

  const json = await res.json() as AmadeusSearchResponse;

  if (!res.ok) {
    const err = json.errors?.[0];
    throw new AmadeusApiError(
      res.status,
      err?.code ?? 0,
      err?.title ?? `Amadeus API error ${res.status}`,
      err?.detail,
    );
  }

  return json;
}
