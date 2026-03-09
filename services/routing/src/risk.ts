import type { Route, RouteRiskResult } from '@travel-ai/types';

/**
 * Computes a route-level geopolitical and operational risk assessment.
 *
 * MVP scope — static data only:
 *   - Derived entirely from COUNTRY_RISKS in @travel-ai/types
 *   - Evaluates transit and destination countries; origin country is excluded
 *     (traveler is departing from there; origin disruption is not actionable
 *     in the context of route selection)
 *   - No real-time disruption feeds, weather data, or live risk signals
 *
 * The result (riskScore, riskLabel, highRiskCountries) is consumed by the
 * scoring stage. It is distinct from:
 *   - fragilityScore: structural (segments, booking protection, connections)
 *   - HIGH_DISRUPTION_RISK warning: qualitative user-facing signal, generated
 *     earlier in the pipeline from the same underlying data
 *
 * Pure function — no side effects, no I/O.
 */
export function computeRouteRisk(route: Route): RouteRiskResult {
  throw new Error('computeRouteRisk: not implemented');
}
