import type { Route, RouteRiskResult, RouteRiskLabel } from '@travel-ai/types';
import { AIRPORT_METADATA, COUNTRY_RISKS } from '@travel-ai/types';

// ─── Module-level lookup (computed once at load time) ─────────────────────────

/** ISO country code → operational disruption riskScore. */
const RISK_BY_COUNTRY: ReadonlyMap<string, number> = new Map(
  COUNTRY_RISKS.map(r => [r.isoCode, r.riskScore]),
);

/**
 * Countries with riskScore >= this threshold are included in highRiskCountries.
 * Mirrors the DISRUPTION_WARN_THRESHOLD used in warnings.ts for HIGH_DISRUPTION_RISK.
 */
const HIGH_RISK_THRESHOLD = 0.50;

// ─── Public API ───────────────────────────────────────────────────────────────

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
 * Risk aggregation: max riskScore across all transit and destination countries.
 * Max (rather than average) reflects the traveler's exposure to the single
 * highest-risk point on the route; a stable transit through DXB followed by a
 * high-risk destination should not dilute the destination risk.
 *
 * Countries not in COUNTRY_RISKS default to 0.05 (low operational risk).
 *
 * Pure function — no side effects, no I/O.
 */
export function computeRouteRisk(route: Route): RouteRiskResult {
  const originIata    = route.flights[0]?.origin ?? '';
  const originCountry = AIRPORT_METADATA[originIata]?.country ?? '';

  let maxRiskScore = 0;
  const highRiskCountries: string[] = [];
  const seen = new Set<string>();

  // Evaluate every airport on the route except those in the origin country.
  // The origin is excluded because the traveler is already departing from there;
  // disruption risk at the origin is not actionable in the context of route selection.
  for (const flight of route.flights) {
    for (const iata of [flight.origin, flight.destination]) {
      if (iata === originIata) continue;

      const country = AIRPORT_METADATA[iata]?.country;
      if (!country || country === originCountry || seen.has(country)) continue;
      seen.add(country);

      const riskScore = RISK_BY_COUNTRY.get(country) ?? 0.05; // default: low
      if (riskScore > maxRiskScore) maxRiskScore = riskScore;
      if (riskScore >= HIGH_RISK_THRESHOLD) highRiskCountries.push(country);
    }
  }

  return {
    riskScore:        maxRiskScore,
    riskLabel:        deriveLabel(maxRiskScore),
    highRiskCountries,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function deriveLabel(score: number): RouteRiskLabel {
  if (score < 0.30) return 'low';
  if (score < 0.60) return 'moderate';
  if (score < 0.80) return 'high';
  return 'critical';
}
