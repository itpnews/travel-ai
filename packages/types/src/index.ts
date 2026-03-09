// ─── Search Params ────────────────────────────────────────────────────────────

export interface SearchParams {
  origin: string;          // IATA code
  destination: string;     // IATA code
  departureDate: string;   // "YYYY-MM-DD" — center of ±3 day window
  passengers: number;      // default 1
  currency: string;        // default "USD"
}

// ─── Flight ───────────────────────────────────────────────────────────────────

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

export interface Flight {
  id: string;
  origin: string;
  destination: string;
  departingAt: string;     // ISO datetime
  arrivingAt: string;      // ISO datetime
  carrier: string;         // airline IATA code
  flightNumber: string;
  durationMinutes: number;
  cabinClass: CabinClass;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export type BudgetBand = 'cheapest' | 'balanced' | 'flexible' | 'over';

/**
 * Internal values. UI maps to user-readable strings:
 * low → "Reliable", medium → "Moderate", high → "Risky", critical → "Very risky"
 */
export type FragilityLabel = 'low' | 'medium' | 'high' | 'critical';

// VISA_RISK removed — visa/transit checks now handled in feasibility (VISA_BLOCKED, TRANSIT_NOT_ALLOWED)
export type RouteWarningCode =
  | 'LONG_TRAVEL_TIME'
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

// ─── Traveler Profile ─────────────────────────────────────────────────────────

export interface TravelerProfile {
  passportCountry: string;       // ISO 3166-1 alpha-2 — drives visa/transit checks
  blockedCountries?: string[];   // ISO 3166-1 alpha-2 — route must not enter these
  maxBudget?: number;            // hard ceiling, in search currency
  maxTotalDurationHours?: number;// hard ceiling; overrides system default when set
  /**
   * If false, this traveler will not take assembled (separate-ticket) routes.
   * Treated as a blocking constraint in standard search modes.
   * In urgent_get_me_home, this constraint becomes non-blocking — the route
   * is still surfaced, but the violation is propagated to scoring.
   */
  willingSeparateTickets: boolean;
  /**
   * If false, this traveler will not use routes that require an airport transfer.
   * Treated as a blocking constraint in standard search modes.
   * In urgent_get_me_home, this constraint becomes non-blocking — the route
   * is still surfaced, but the violation is propagated to scoring.
   */
  allowAirportTransfers: boolean;
}

// ─── Search Mode ──────────────────────────────────────────────────────────────

export type SearchMode =
  | 'best_overall'
  | 'safest'
  | 'best_value'
  | 'fastest_home'
  | 'urgent_get_me_home';

export interface SearchModeConfig {
  /** Hub candidates evaluated in fallback routing. */
  maxHubs: number;
  /** Hard segment cap for routes in this mode. */
  maxFlightSegments: number;
  /**
   * Hub-to-hub fallback layers.
   * Extensibility hook: future emergency routing may increase this for urgent_get_me_home.
   */
  maxFallbackDepth: number;
  /**
   * When true (urgent_get_me_home), soft feasibility violations do not block the route.
   * Violations are still recorded in FeasibilityResult.violations and propagated to
   * scoring and ranking — they are not ignored, just no longer gatekeepers.
   */
  relaxedFeasibility: boolean;
}

// ─── Search Request ───────────────────────────────────────────────────────────

/** Top-level engine input. Replaces bare SearchParams at the engine boundary. */
export interface SearchRequest {
  params: SearchParams;
  traveler: TravelerProfile;
  mode: SearchMode;
}

// ─── Static Rule Types ────────────────────────────────────────────────────────

export interface VisaRule {
  passportCountry: string;        // ISO 3166-1 alpha-2
  destinationCountry: string;     // ISO 3166-1 alpha-2
  requiresVisa: boolean;
  airsideTransitAllowed: boolean;
}

export interface TransitRule {
  passportCountry: string;        // ISO 3166-1 alpha-2
  transitCountry: string;         // ISO 3166-1 alpha-2
  /** false → entry visa required even for airside transit */
  airsideTransitAllowed: boolean;
}

/**
 * Country access restriction for a given passport country.
 * status drives the feasibility decision; reason provides context.
 */
export interface CountryAccessRule {
  passportCountry: string;        // ISO 3166-1 alpha-2
  targetCountry: string;          // ISO 3166-1 alpha-2
  status: 'blocked' | 'restricted' | 'advisory';
  reason: 'sanctions' | 'bilateral_block' | 'entry_ban' | 'travel_warning';
}

// ─── Feasibility ──────────────────────────────────────────────────────────────

export type FeasibilityConstraintCode =
  | 'VISA_BLOCKED'
  | 'TRANSIT_NOT_ALLOWED'
  | 'BLOCKED_COUNTRY'
  | 'BUDGET_EXCEEDED'
  | 'DURATION_EXCEEDED'
  | 'SEPARATE_TICKETS_NOT_ALLOWED'
  | 'AIRPORT_TRANSFER_NOT_ALLOWED';

export interface FeasibilityViolation {
  constraint: FeasibilityConstraintCode;
  reason: string;              // plain-language explanation
  /** hard: always blocks; soft: blocks in standard modes, propagated in urgent */
  severity: 'hard' | 'soft';
}

export type FeasibilityStatus = 'feasible' | 'restricted' | 'blocked';

/**
 * Pipeline-internal. Never attached to Route or SearchResult.
 * violations is always populated when violations exist, regardless of status.
 * Scoring and ranking stages receive violations for soft-penalty computation.
 */
export interface FeasibilityResult {
  status: FeasibilityStatus;
  violations: FeasibilityViolation[];
}

// ─── Route Risk ───────────────────────────────────────────────────────────────

export type RouteRiskLabel = 'low' | 'moderate' | 'high' | 'critical';

export interface RouteRiskResult {
  /** Aggregate operational risk score 0..1 from COUNTRY_RISKS, transit + destination only */
  riskScore: number;
  riskLabel: RouteRiskLabel;
  /** ISO 3166-1 alpha-2 codes of elevated-risk countries on route (origin excluded) */
  highRiskCountries: string[];
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
  mode: SearchMode;
  generatedAt: string;
  errors?: RoutingError[];
}
