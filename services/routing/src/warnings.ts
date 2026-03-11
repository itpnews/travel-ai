import type { Route, RouteWarning } from '@travel-ai/types';
import {
  AIRPORT_METADATA,
  COUNTRY_RISKS,
} from '@travel-ai/types';
import { formatDuration } from '@travel-ai/utils';
import { assessConnection, DEFAULT_CONNECTION_CONFIG } from './feasibility.js';

// ─── Thresholds ───────────────────────────────────────────────────────────────

/** Soft limit from ROUTING_CONSTRAINTS.maxTotalDurationHours (penalty at 48h, hard cap at 72h). */
const LONG_TRAVEL_MINUTES = 48 * 60;

/**
 * Routes with 3+ flights are flagged as "many segments" for consumer clarity.
 * The hard filter at maxFlightSegments=4 means consumers will only see 3 or 4.
 * 3 flights → info, 4 flights → warn. Never critical.
 */
const MANY_SEGMENTS_THRESHOLD = 3;

/** riskScore >= this triggers HIGH_DISRUPTION_RISK at 'warn' severity. */
const DISRUPTION_WARN_THRESHOLD = 0.50;

/** riskScore >= this escalates HIGH_DISRUPTION_RISK to 'critical'. */
const DISRUPTION_CRITICAL_THRESHOLD = 0.65;

// ─── Module-level static lookups (derived from static data, computed once) ────

/** ISO country code → operational disruption riskScore */
const COUNTRY_RISK_MAP: ReadonlyMap<string, number> = new Map(
  COUNTRY_RISKS.map(r => [r.isoCode, r.riskScore]),
);

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generates consumer-facing warnings for a route using only the route's own
 * data and the static reference tables in `@travel-ai/types`.
 *
 * Pure function — no side effects, no I/O.
 *
 * Note: VISA_RISK is intentionally deferred and will not be emitted until
 * passport-aware data is available in a future release.
 */
export function generateWarnings(route: Route): RouteWarning[] {
  const warnings: RouteWarning[] = [];

  // ── ASSEMBLED_ROUTE ────────────────────────────────────────────────────────
  // Must always be emitted for separate-ticket routes — the disruption
  // protection gap is a material risk for consumers.
  if (route.bookingMode === 'separate_tickets') {
    warnings.push({
      code: 'ASSEMBLED_ROUTE',
      message:
        'This itinerary combines tickets from separate bookings. If one flight is disrupted, the airline is not obligated to rebook your other ticket.',
      severity: 'warn',
    });
  }

  // ── ALTERNATE_DATE ─────────────────────────────────────────────────────────
  if (route.dateDeltaDays !== 0) {
    const abs = Math.abs(route.dateDeltaDays);
    const dir = route.dateDeltaDays > 0 ? 'later' : 'earlier';
    warnings.push({
      code: 'ALTERNATE_DATE',
      message: `This route departs ${abs} day${abs === 1 ? '' : 's'} ${dir} than your requested date.`,
      severity: 'info',
    });
  }

  // ── LONG_TRAVEL_TIME ───────────────────────────────────────────────────────
  if (route.totalDurationMinutes > LONG_TRAVEL_MINUTES) {
    warnings.push({
      code: 'LONG_TRAVEL_TIME',
      message: `Total travel time is ${formatDuration(route.totalDurationMinutes)}, which exceeds 48 hours door-to-door.`,
      severity: 'warn',
    });
  }

  // ── MANY_SEGMENTS ──────────────────────────────────────────────────────────
  const segmentCount = route.flights.length;
  if (segmentCount >= MANY_SEGMENTS_THRESHOLD) {
    warnings.push({
      code: 'MANY_SEGMENTS',
      message: `This route has ${segmentCount} flights. Each additional connection increases the risk of delays and missed connections.`,
      severity: segmentCount >= 4 ? 'warn' : 'info',
    });
  }

  // ── BUDGET_OVERRUN ─────────────────────────────────────────────────────────
  // 'over' = price exceeds the flexible fare band (1.5× cheapest option found).
  if (route.budgetBand === 'over') {
    warnings.push({
      code: 'BUDGET_OVERRUN',
      message:
        'This route is priced above our flexible fare threshold. You may find better value on nearby dates.',
      severity: 'warn',
    });
  }

  // ── Per-connection checks ──────────────────────────────────────────────────
  //
  // assessConnection() classifies each connection as impossible/risky/feasible.
  // impossible → UNREALISTIC_CONNECTION (routes with impossible connections are
  //              already blocked in checkFeasibility, but we emit the warning
  //              defensively in case this function is called independently).
  // risky      → SHORT_CONNECTION (tight timing) or LONG_LAYOVER (excessive wait)
  // Airport-change connections always emit AIRPORT_TRANSFER_REQUIRED regardless
  // of timing, since the ground transfer itself is a traveler-facing concern.
  for (let i = 0; i < route.flights.length - 1; i++) {
    const inbound  = route.flights[i];
    const outbound = route.flights[i + 1];

    const conn = assessConnection(inbound, outbound, DEFAULT_CONNECTION_CONFIG);
    const { layoverMinutes, sameAirport, airportChange } = conn;

    // Airport-change: always emit the transfer notice.
    if (airportChange) {
      warnings.push({
        code: 'AIRPORT_TRANSFER_REQUIRED',
        message:
          `Your connection requires a ground transfer from ${inbound.destination} to ${outbound.origin}. ` +
          `Allow extra time to exit the terminal, travel between airports, and re-clear security.`,
        severity: 'warn',
      });
    }

    if (conn.assessment === 'impossible') {
      const context = airportChange
        ? `for an airport transfer between ${inbound.destination} and ${outbound.origin}`
        : `to connect at ${inbound.destination}`;
      warnings.push({
        code: 'UNREALISTIC_CONNECTION',
        message:
          `Only ${Math.round(layoverMinutes)} minutes available ${context} — this is not enough time.`,
        severity: 'critical',
      });
    } else if (conn.assessment === 'risky') {
      if (layoverMinutes > DEFAULT_CONNECTION_CONFIG.max_reasonable_layover_minutes) {
        // Long layover: excessive wait, flag as informational.
        const hours = Math.round(layoverMinutes / 60);
        warnings.push({
          code: 'LONG_LAYOVER',
          message:
            `${hours}-hour layover at ${inbound.destination}. ` +
            `This is an unusually long connection — consider whether this is intentional.`,
          severity: 'info',
        });
      } else {
        // Short but feasible connection — tight timing risk.
        const minStr = Math.round(layoverMinutes);
        const context = airportChange
          ? ` for a transfer between ${inbound.destination} and ${outbound.origin}`
          : ` at ${inbound.destination}`;
        warnings.push({
          code: 'SHORT_CONNECTION',
          message:
            `Only ${minStr} minutes${context}. ` +
            `This connection is tight and may be missed if flights are delayed.`,
          severity: 'warn',
        });
      }
    } else if (!sameAirport && !airportChange) {
      // Different airports in different cities — should not arise in valid routes,
      // but guard anyway.
      void 0;
    }
  }

  // ── HIGH_DISRUPTION_RISK ───────────────────────────────────────────────────
  // Evaluate transit airports + destination only. The origin is excluded: the
  // traveller is departing from there and disruption risk at home base is not
  // actionable in the context of route selection.
  //
  // Guard: if route.flights is empty (should not happen after engine filtering,
  // but possible in tests or future callers) return current warnings unchanged.
  const originIata = route.flights[0]?.origin ?? '';
  if (!originIata) return warnings;

  let maxRiskScore = 0;
  const seenCountries = new Set<string>();

  for (const flight of route.flights) {
    for (const iata of [flight.origin, flight.destination]) {
      if (iata === originIata) continue;
      const meta = AIRPORT_METADATA[iata];
      if (!meta || seenCountries.has(meta.country)) continue;
      seenCountries.add(meta.country);
      const risk = COUNTRY_RISK_MAP.get(meta.country) ?? 0;
      if (risk > maxRiskScore) maxRiskScore = risk;
    }
  }

  if (maxRiskScore >= DISRUPTION_WARN_THRESHOLD) {
    warnings.push({
      code: 'HIGH_DISRUPTION_RISK',
      message:
        'This route passes through a region with elevated operational disruption risk. ' +
        'Delays or cancellations are more likely than on routes through stable hubs.',
      severity: maxRiskScore >= DISRUPTION_CRITICAL_THRESHOLD ? 'critical' : 'warn',
    });
  }

  // ── VISA_RISK ──────────────────────────────────────────────────────────────
  // Removed from warnings. Visa and transit checks are now handled by
  // checkFeasibility() in feasibility.ts, which has access to TravelerProfile.

  return warnings;
}
