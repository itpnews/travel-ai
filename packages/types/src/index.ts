// ─── Search Params ────────────────────────────────────────────────────────────

export interface SearchParams {
  origin: string;          // IATA code
  destination: string;     // IATA code
  departureDate: string;   // "YYYY-MM-DD" — center of ±3 day window
  passengers: number;      // default 1
  currency: string;        // default "USD"
}

// ─── Flight ───────────────────────────────────────────────────────────────────

export interface Flight {
  id: string;
  origin: string;
  destination: string;
  departingAt: string;     // ISO datetime
  arrivingAt: string;      // ISO datetime
  carrier: string;         // airline IATA code
  flightNumber: string;
  durationMinutes: number;
  cabinClass: 'economy' | 'premium_economy' | 'business' | 'first';
}

// ─── Route ────────────────────────────────────────────────────────────────────

export type BudgetBand = 'cheapest' | 'balanced' | 'flexible' | 'over';

/**
 * Internal values. UI maps to user-readable strings:
 * low → "Reliable", medium → "Moderate", high → "Risky", critical → "Very risky"
 */
export type FragilityLabel = 'low' | 'medium' | 'high' | 'critical';

export type RouteWarningCode =
  | 'LONG_TRAVEL_TIME'
  | 'VISA_RISK'
  | 'BUDGET_OVERRUN'
  | 'UNREALISTIC_CONNECTION'
  | 'HIGH_DISRUPTION_RISK'
  | 'MANY_SEGMENTS'
  | 'ALTERNATE_DATE'
  | 'AIRPORT_TRANSFER_REQUIRED'
  | 'ASSEMBLED_ROUTE';

export interface RouteWarning {
  code: RouteWarningCode;
  message: string;           // plain language shown in UI
  severity: 'info' | 'warn' | 'critical';
}

/**
 * A group of flights that must be purchased as a single booking.
 * Only present on routes where bookingMode === 'separate_tickets'.
 */
export interface BookingGroup {
  id: string;
  flightIds: string[];
  carrier?: string;               // IATA code of the marketing carrier for this booking
}

/** Public route — what the API returns and the UI consumes. */
export interface Route {
  id: string;
  flights: Flight[];
  totalDurationMinutes: number;
  totalPrice: number;
  currency: string;
  actualDepartureDate: string;    // "YYYY-MM-DD"
  dateDeltaDays: number;          // -3..+3
  /** Where this route came from: direct provider result or hub-fallback assembly */
  source: 'provider' | 'fallback';
  /** How the route must be purchased */
  bookingMode: 'single_booking' | 'separate_tickets';
  /** Present only when bookingMode === 'separate_tickets' */
  bookingGroups?: BookingGroup[];
  budgetBand: BudgetBand;
  fragilityLabel: FragilityLabel;
  /** Sort key for normal mode — do NOT display */
  score: number;
  /** Sort key for safe mode — do NOT display */
  safeScore: number;
  /** "Best overall" | "Best value" | "Safest option" | "Last resort" | "" */
  routeLabel: string;
  /** One-sentence plain-language explanation */
  summary: string;
  warnings: RouteWarning[];
}

// ─── Static data (re-exported for consumers) ──────────────────────────────────

export * from './static.js';

// ─── Static data types ────────────────────────────────────────────────────────

export interface Hub {
  iata: string;
  name: string;
  region: string;
  stabilityScore: number;    // 0..1
  lat: number;
  lng: number;
}

export interface CountryRisk {
  isoCode: string;
  riskScore: number;           // 0..1
  visaComplexityScore: number; // 0..1
}

export interface SafeModeConfig {
  enabled: boolean;
  stabilityWeight: number;
  visaRiskPenalty: number;
  longFlightPenalty: number;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export type RoutingErrorCode =
  | 'PROVIDER_TIMEOUT'
  | 'API_RATE_LIMIT'
  /** provider + fallback both ran; nothing viable after filtering */
  | 'NO_ROUTES_FOUND'
  /** all date-window calls failed; fallback not attempted */
  | 'NO_PROVIDER_RESULTS'
  /** valid IATA format but not in AIRPORT_METADATA */
  | 'INVALID_AIRPORT'
  /** past date or malformed */
  | 'INVALID_DATE'
  /** not exactly 3 uppercase letters */
  | 'INVALID_IATA'
  /** no valid dates in ±3 window */
  | 'EMPTY_DATE_WINDOW'
  /** Duffel response shape unexpected */
  | 'PROVIDER_SCHEMA_CHANGED';

export interface RoutingError {
  code: RoutingErrorCode;
  message: string;
}

// ─── Search Result ────────────────────────────────────────────────────────────

export interface SearchResult {
  params: SearchParams;
  /** Sorted by score descending; max ROUTING_CONSTRAINTS.maxRoutesReturned */
  routes: Route[];
  safeMode: boolean;
  generatedAt: string;
  errors?: RoutingError[];
}
