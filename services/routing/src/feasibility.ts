import type {
  Route,
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
    return { status: 'blocked', violations };
  }

  if (hasSoft) {
    return {
      // In urgent_get_me_home soft violations do not block; route is surfaced
      // with violations attached for downstream penalty scoring.
      status: relaxedFeasibility ? 'restricted' : 'blocked',
      violations,
    };
  }

  return { status: 'feasible', violations: [] };
}
