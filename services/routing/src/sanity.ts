import type { SearchParams, Route, RoutingError } from '@travel-ai/types';
import { AIRPORT_METADATA } from '@travel-ai/types';
import { isValidIata, isValidFutureDate } from '@travel-ai/utils';
import { assessConnection } from './feasibility.js';

/**
 * Post-ranking invariant check on the final route set.
 *
 * Verifies:
 *   1. No impossible connection appears in any returned route.
 *   2. Routes with risky connections carry at least one connection warning.
 *   3. Routes retain their expected score ordering (monotone descending by index).
 *
 * Logs to console.error / console.warn only — does not throw or mutate results.
 * Intended to catch regressions during development; silent in production as
 * long as the routing pipeline maintains its invariants.
 */
export function sanityCheckFinalRoutes(routes: Route[]): void {
  for (const route of routes) {
    let hasRiskyConnection = false;

    for (let i = 0; i < route.flights.length - 1; i++) {
      const conn = assessConnection(route.flights[i], route.flights[i + 1]);

      if (conn.assessment === 'impossible') {
        console.error(
          `[sanity] INVARIANT VIOLATION: impossible connection in final route ${route.id} ` +
          `(flight ${i}: ${route.flights[i].destination} → ${route.flights[i + 1].origin}, ` +
          `${Math.round(conn.layoverMinutes)} min layover)`,
        );
      }

      if (conn.assessment === 'risky') hasRiskyConnection = true;
    }

    if (hasRiskyConnection) {
      const hasConnectionWarning = route.warnings.some(
        w => w.code === 'SHORT_CONNECTION' || w.code === 'LONG_LAYOVER' || w.code === 'UNREALISTIC_CONNECTION',
      );
      if (!hasConnectionWarning) {
        console.warn(
          `[sanity] Route ${route.id} has risky connection(s) but no connection warning was generated.`,
        );
      }
    }
  }

  // Verify descending score order (routes are pre-sorted; this catches regressions).
  for (let i = 1; i < routes.length; i++) {
    if (routes[i].score > routes[i - 1].score + 1e-9) {
      console.warn(
        `[sanity] Score order violation: routes[${i}].score (${routes[i].score}) > ` +
        `routes[${i - 1}].score (${routes[i - 1].score})`,
      );
    }
  }
}

/**
 * Validates SearchParams before any provider or fallback call.
 * Returns an array of RoutingErrors; empty means the params are valid.
 */
export function validateSearchParams(params: SearchParams): RoutingError[] {
  const errors: RoutingError[] = [];

  // Origin
  if (!isValidIata(params.origin)) {
    errors.push({ code: 'INVALID_IATA', message: `Origin "${params.origin}" is not a valid IATA code.` });
  } else if (!(params.origin in AIRPORT_METADATA)) {
    errors.push({ code: 'INVALID_AIRPORT', message: `Origin "${params.origin}" is not a recognised airport.` });
  }

  // Destination
  if (!isValidIata(params.destination)) {
    errors.push({ code: 'INVALID_IATA', message: `Destination "${params.destination}" is not a valid IATA code.` });
  } else if (!(params.destination in AIRPORT_METADATA)) {
    errors.push({ code: 'INVALID_AIRPORT', message: `Destination "${params.destination}" is not a recognised airport.` });
  }

  // Date
  if (!isValidFutureDate(params.departureDate)) {
    errors.push({ code: 'INVALID_DATE', message: `Departure date "${params.departureDate}" is in the past or not a valid YYYY-MM-DD date.` });
  }

  return errors;
}
