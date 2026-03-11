import type {
  Route,
  Flight,
  TravelerProfile,
  SearchMode,
  FeasibilityResult,
  FeasibilityViolation,
} from '@travel-ai/types';
import {
  AIRPORT_METADATA,
  CITY_AIRPORTS,
  SEARCH_MODE_CONFIGS,
  VISA_RULES,
  TRANSIT_RULES,
} from '@travel-ai/types';

// ─── Connection assessment ────────────────────────────────────────────────────

/**
 * Per-connection feasibility classification.
 *   impossible — layover too short to make the connection; route must be blocked.
 *   risky      — layover is technically possible but tight or excessively long;
 *                route survives filtering but incurs a score penalty.
 *   feasible   — connection is comfortably within safe parameters.
 */
export type ConnectionAssessment = 'feasible' | 'risky' | 'impossible';

export interface ConnectionResult {
  assessment: ConnectionAssessment;
  layoverMinutes: number;
  /** True when both flights use the same airport code. */
  sameAirport: boolean;
  /** True when arrival/departure airports are different but serve the same metro area. */
  airportChange: boolean;
}

/**
 * Configuration-driven connection time thresholds.
 * All values are in minutes.
 */
export interface ConnectionConfig {
  /** Same-airport layover below this is impossible. */
  same_airport_min_connection_minutes: number;
  /** Same-airport layover below this (but ≥ min) is risky. */
  risky_connection_threshold_minutes: number;
  /** Airport-change layover below this is impossible. */
  airport_change_min_connection_minutes: number;
  /** Airport-change layover below this (but ≥ min) is risky. */
  airport_change_risky_threshold_minutes: number;
  /** Any layover above this is risky (excessively long for traveler-friendly ranking). */
  max_reasonable_layover_minutes: number;
}

export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  same_airport_min_connection_minutes:     45,
  risky_connection_threshold_minutes:      90,   // matches fragility TIGHT_SAME_AIRPORT_MINUTES
  airport_change_min_connection_minutes:   90,
  airport_change_risky_threshold_minutes:  150,  // matches fragility TIGHT_TRANSFER_MINUTES
  max_reasonable_layover_minutes:          1440, // 24 hours
};

// ─── Module-level lookup (computed once at load time) ─────────────────────────

/** airport IATA → city metro code (e.g. 'LGW' → 'LON'). Used for transfer detection. */
const AIRPORT_TO_CITY: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [city, airports] of Object.entries(CITY_AIRPORTS)) {
    for (const iata of airports) {
      map.set(iata, city);
    }
  }
  return map;
})();

// ─── Connection assessment (public) ──────────────────────────────────────────

/**
 * Classifies a single connection between two consecutive flights.
 *
 * Exported for use by warnings.ts and sanity.ts.
 * Pure function — no side effects.
 */
export function assessConnection(
  inbound: Flight,
  outbound: Flight,
  config: ConnectionConfig = DEFAULT_CONNECTION_CONFIG,
): ConnectionResult {
  const layoverMinutes =
    (new Date(outbound.departingAt).getTime() - new Date(inbound.arrivingAt).getTime()) / 60_000;

  const sameAirport = inbound.destination === outbound.origin;
  const cityA = AIRPORT_TO_CITY.get(inbound.destination);
  const cityB = AIRPORT_TO_CITY.get(outbound.origin);
  const airportChange = !sameAirport && cityA !== undefined && cityA === cityB;

  let assessment: ConnectionAssessment;

  if (sameAirport) {
    if (layoverMinutes < config.same_airport_min_connection_minutes) {
      assessment = 'impossible';
    } else if (
      layoverMinutes < config.risky_connection_threshold_minutes ||
      layoverMinutes > config.max_reasonable_layover_minutes
    ) {
      assessment = 'risky';
    } else {
      assessment = 'feasible';
    }
  } else if (airportChange) {
    if (layoverMinutes < config.airport_change_min_connection_minutes) {
      assessment = 'impossible';
    } else if (
      layoverMinutes < config.airport_change_risky_threshold_minutes ||
      layoverMinutes > config.max_reasonable_layover_minutes
    ) {
      assessment = 'risky';
    } else {
      assessment = 'feasible';
    }
  } else {
    // Different airports in different cities — should not appear in well-formed routes.
    // Treat conservatively: impossible if layover is below same-airport minimum.
    assessment = layoverMinutes < config.same_airport_min_connection_minutes
      ? 'impossible'
      : 'feasible';
  }

  return { assessment, layoverMinutes, sameAirport, airportChange };
}

/**
 * Evaluates all connections in a route.
 * Returns the count of risky connections and whether any are impossible.
 * Internal helper — not exported.
 */
function assessRouteConnections(route: Route): { hasImpossible: boolean; riskyCount: number } {
  let hasImpossible = false;
  let riskyCount = 0;

  for (let i = 0; i < route.flights.length - 1; i++) {
    const result = assessConnection(route.flights[i], route.flights[i + 1]);
    if (result.assessment === 'impossible') hasImpossible = true;
    if (result.assessment === 'risky') riskyCount++;
  }

  return { hasImpossible, riskyCount };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluates a route for traveler-specific feasibility.
 *
 * Checks (in priority order):
 *
 *   Hard violations — always produce status 'blocked', regardless of mode:
 *     VISA_BLOCKED             passportCountry cannot enter a transit/destination country
 *     TRANSIT_NOT_ALLOWED      airside transit not permitted for this passport
 *     BLOCKED_COUNTRY          route enters a country in traveler.blockedCountries
 *     BUDGET_EXCEEDED          route.totalPrice > traveler.maxBudget
 *     DURATION_EXCEEDED        route exceeds traveler.maxTotalDurationHours
 *
 *   Soft violations — behaviour depends on SearchModeConfig.relaxedFeasibility:
 *     SEPARATE_TICKETS_NOT_ALLOWED  assembled route + traveler.willingSeparateTickets=false
 *     AIRPORT_TRANSFER_NOT_ALLOWED  transfer required + traveler.allowAirportTransfers=false
 *     → relaxedFeasibility=false (standard): status 'blocked'
 *     → relaxedFeasibility=true  (urgent):   status 'restricted'
 *
 * In all cases, violations are recorded in FeasibilityResult.violations and
 * propagated downstream. 'restricted' does not mean the violation is ignored —
 * scoring and ranking stages receive violations for soft-penalty computation.
 *
 * Note: VISA_RULES and TRANSIT_RULES are empty at MVP. Their checks are
 * structurally complete and will produce violations once rule data is populated.
 *
 * Pure function — no side effects, no I/O.
 */
export function checkFeasibility(
  route: Route,
  traveler: TravelerProfile,
  mode: SearchMode,
): FeasibilityResult {
  const violations: FeasibilityViolation[] = [];
  const { relaxedFeasibility } = SEARCH_MODE_CONFIGS[mode];

  // ── Hard: IMPOSSIBLE_CONNECTION ──────────────────────────────────────────────
  // Evaluated first so obviously invalid routes are rejected before visa/budget
  // checks. A single impossible layover is sufficient to block the route.
  const { hasImpossible, riskyCount } = assessRouteConnections(route);
  if (hasImpossible) {
    return {
      status: 'blocked',
      violations: [{
        constraint: 'IMPOSSIBLE_CONNECTION',
        reason: 'At least one connection has an insufficient layover time.',
        severity: 'hard',
      }],
      riskyConnectionCount: 0,
    };
  }

  const originIata    = route.flights[0]?.origin ?? '';
  const originCountry = AIRPORT_METADATA[originIata]?.country ?? '';

  // ── Hard: VISA_BLOCKED ───────────────────────────────────────────────────────
  // Checks every destination country in the route. An entry in VISA_RULES with
  // requiresVisa=true blocks the route. Currently empty at MVP — no violations
  // will be raised until rule data is populated.
  if (VISA_RULES.length > 0) {
    for (const flight of route.flights) {
      const destCountry = AIRPORT_METADATA[flight.destination]?.country;
      if (!destCountry || destCountry === originCountry) continue;

      const blocked = VISA_RULES.some(
        r =>
          r.passportCountry    === traveler.passportCountry &&
          r.destinationCountry === destCountry &&
          r.requiresVisa,
      );
      if (blocked) {
        violations.push({
          constraint: 'VISA_BLOCKED',
          reason:     `Passport ${traveler.passportCountry} requires a visa to enter ${destCountry}.`,
          severity:   'hard',
        });
        break; // one violation is sufficient to block
      }
    }
  }

  // ── Hard: TRANSIT_NOT_ALLOWED ────────────────────────────────────────────────
  // Checks every intermediate stop. An entry in TRANSIT_RULES with
  // airsideTransitAllowed=false blocks the route. Currently empty at MVP.
  if (TRANSIT_RULES.length > 0) {
    for (let i = 0; i < route.flights.length - 1; i++) {
      const transitIata    = route.flights[i].destination;
      const transitCountry = AIRPORT_METADATA[transitIata]?.country;
      if (!transitCountry || transitCountry === originCountry) continue;

      const blocked = TRANSIT_RULES.some(
        r =>
          r.passportCountry  === traveler.passportCountry &&
          r.transitCountry   === transitCountry &&
          !r.airsideTransitAllowed,
      );
      if (blocked) {
        violations.push({
          constraint: 'TRANSIT_NOT_ALLOWED',
          reason:     `Airside transit through ${transitCountry} is not permitted for passport ${traveler.passportCountry}.`,
          severity:   'hard',
        });
        break;
      }
    }
  }

  // ── Hard: BLOCKED_COUNTRY ────────────────────────────────────────────────────
  // Traveler-specified countries that must not appear anywhere on the route.
  if (traveler.blockedCountries && traveler.blockedCountries.length > 0) {
    const blocked = new Set(traveler.blockedCountries);
    const flagged = new Set<string>();

    for (const flight of route.flights) {
      for (const iata of [flight.origin, flight.destination]) {
        const country = AIRPORT_METADATA[iata]?.country;
        if (country && blocked.has(country) && !flagged.has(country)) {
          flagged.add(country);
          violations.push({
            constraint: 'BLOCKED_COUNTRY',
            reason:     `Route passes through ${country}, which is in your blocked countries list.`,
            severity:   'hard',
          });
        }
      }
    }
  }

  // ── Hard: BUDGET_EXCEEDED ────────────────────────────────────────────────────
  if (traveler.maxBudget !== undefined && route.totalPrice > traveler.maxBudget) {
    violations.push({
      constraint: 'BUDGET_EXCEEDED',
      reason:     `Route total ${route.totalPrice} ${route.currency} exceeds your budget of ${traveler.maxBudget}.`,
      severity:   'hard',
    });
  }

  // ── Hard: DURATION_EXCEEDED ──────────────────────────────────────────────────
  if (traveler.maxTotalDurationHours !== undefined) {
    const limitMinutes = traveler.maxTotalDurationHours * 60;
    if (route.totalDurationMinutes > limitMinutes) {
      violations.push({
        constraint: 'DURATION_EXCEEDED',
        reason:     `Route duration ${route.totalDurationMinutes} min exceeds your ${traveler.maxTotalDurationHours}h limit.`,
        severity:   'hard',
      });
    }
  }

  // ── Soft: SEPARATE_TICKETS_NOT_ALLOWED ───────────────────────────────────────
  if (route.bookingMode === 'separate_tickets' && !traveler.willingSeparateTickets) {
    violations.push({
      constraint: 'SEPARATE_TICKETS_NOT_ALLOWED',
      reason:     'This itinerary requires purchasing separate tickets, which you have disabled.',
      severity:   'soft',
    });
  }

  // ── Soft: AIRPORT_TRANSFER_NOT_ALLOWED ───────────────────────────────────────
  // An airport transfer occurs when consecutive flights land at and depart from
  // different airports that serve the same city metro area (e.g. LHR and LGW
  // are both in CITY_AIRPORTS['LON']). Same-airport connections (same IATA code)
  // are not transfers — only inter-airport ground moves count.
  if (!traveler.allowAirportTransfers) {
    for (let i = 0; i < route.flights.length - 1; i++) {
      const arrivalIata   = route.flights[i].destination;
      const departureIata = route.flights[i + 1].origin;

      if (arrivalIata === departureIata) continue; // same airport — no transfer

      const cityA = AIRPORT_TO_CITY.get(arrivalIata);
      const cityB = AIRPORT_TO_CITY.get(departureIata);

      // Only flag if both airports belong to the same metro area.
      // If either is unknown or they're in different cities, this is not a
      // same-city transfer (it would have been caught by route assembly already).
      if (cityA !== undefined && cityA === cityB) {
        violations.push({
          constraint: 'AIRPORT_TRANSFER_NOT_ALLOWED',
          reason:     `Connection from ${arrivalIata} to ${departureIata} requires a ground transfer between airports.`,
          severity:   'soft',
        });
        break; // one is enough; remaining connections follow the same booking pattern
      }
    }
  }

  // ── Resolve status ────────────────────────────────────────────────────────────
  const hasHard = violations.some(v => v.severity === 'hard');
  const hasSoft = violations.some(v => v.severity === 'soft');

  if (hasHard) {
    return { status: 'blocked', violations, riskyConnectionCount: 0 };
  }

  if (hasSoft) {
    return {
      // In urgent_get_me_home soft violations do not block; route is surfaced
      // with violations attached for downstream penalty scoring.
      status: relaxedFeasibility ? 'restricted' : 'blocked',
      violations,
      riskyConnectionCount: riskyCount,
    };
  }

  return { status: 'feasible', violations: [], riskyConnectionCount: riskyCount };
}
