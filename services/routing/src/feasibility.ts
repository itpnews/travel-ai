import type { Route, TravelerProfile, SearchMode, FeasibilityResult } from '@travel-ai/types';

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
 * Pure function — no side effects, no I/O.
 */
export function checkFeasibility(
  route: Route,
  traveler: TravelerProfile,
  mode: SearchMode,
): FeasibilityResult {
  throw new Error('checkFeasibility: not implemented');
}
