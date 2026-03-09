import type {
  SearchRequest,
  SearchResult,
  Route,
  RoutingError,
  BudgetBand,
  Flight,
} from '@travel-ai/types';
import { ROUTING_CONSTRAINTS } from '@travel-ai/types';
import { validateSearchParams } from './sanity.js';
import { buildDateWindow } from './dates.js';
import { ProviderScheduler } from './scheduler.js';
import { RouteCache, makeCacheKey } from './cache.js';
import type { ProviderAdapter, ProviderOffer } from './provider.js';
import { deduplicateRoutes } from './dedup.js';
import { generateWarnings } from './warnings.js';
import { computeFragility } from './fragility.js';
import { checkFeasibility } from './feasibility.js';
import { computeRouteRisk } from './risk.js';
import {
  buildScoringContext,
  scoreRoute,
  assignRouteLabels,
  buildSummary,
  type ScoringCandidate,
} from './score.js';

// ─── Engine entry point ───────────────────────────────────────────────────────

/**
 * End-to-end routing pipeline for a single SearchRequest.
 *
 * Pipeline:
 *   1. validate params
 *   2. build date window (±flexDateWindowDays, past dates excluded)
 *   3. fetch + cache  — scheduler is the single authority for provider call
 *                       budget and concurrency. Promise.all dispatches all date
 *                       fetches concurrently, but each fetch is wrapped in
 *                       scheduler.schedule() so the p-limit limiter controls
 *                       how many run in parallel, and the budget counter prevents
 *                       more than maxProviderCallsPerSearch total calls.
 *                       Cache hits bypass the scheduler entirely.
 *   4. dedup          — keep best route per unique flight sequence
 *   5. feasibility    — blocked routes removed; restricted routes continue
 *                       downstream with soft violations attached to scoring
 *   6. warnings + fragility + route risk (computed on surviving routes only)
 *   7. score          — mode-weighted; context built from surviving candidates
 *   8. rank           — sorted by route.score descending (never by safeScore)
 *   9. return SearchResult
 */
export async function search(
  request: SearchRequest,
  adapter: ProviderAdapter,
  cache: RouteCache<ProviderOffer[]> = new RouteCache(),
): Promise<SearchResult> {
  const { params, traveler, mode } = request;
  const errors: RoutingError[] = [];

  // ── 1. Validate ──────────────────────────────────────────────────────────────
  const validationErrors = validateSearchParams(params);
  if (validationErrors.length > 0) {
    return makeResult(request, [], validationErrors);
  }

  // ── 2. Date window ───────────────────────────────────────────────────────────
  const { dates, error: dateError } = buildDateWindow(params);
  if (dateError) {
    return makeResult(request, [], [dateError]);
  }

  // ── 3. Fetch + cache ─────────────────────────────────────────────────────────
  //
  // scheduler.schedule() is the single authority for:
  //   - Provider call budget: callsUsed vs maxProviderCallsPerSearch (15).
  //     Budget is consumed at scheduling time. Once exhausted, schedule()
  //     returns null immediately without calling the provider.
  //   - Concurrency: p-limit(parallelProviderRequests = 3) inside the scheduler
  //     ensures at most 3 provider calls run simultaneously.
  //
  // Each date is wrapped in scheduler.schedule() before Promise.all dispatches
  // them. This means Promise.all never bypasses scheduler control — it only
  // observes the results that the scheduler has already gated.
  //
  // Cache hits return the cached value directly, before schedule() is reached,
  // and do NOT consume a budget slot.
  const scheduler = new ProviderScheduler();

  const fetchPromises = dates.map(date =>
    fetchWithCache(
      params.origin,
      params.destination,
      date,
      params.passengers,
      params.currency,
      adapter,
      cache,
      scheduler,
    ),
  );

  const fetchResults = await Promise.all(fetchPromises);

  const allOffers: ProviderOffer[] = [];
  for (let i = 0; i < fetchResults.length; i++) {
    const result = fetchResults[i];
    if (result === null) {
      errors.push({
        code: 'API_RATE_LIMIT',
        message: `Provider call budget exhausted; skipped date ${dates[i]}.`,
      });
    } else if (result instanceof Error) {
      errors.push({
        code: 'PROVIDER_TIMEOUT',
        message: `Provider fetch failed for ${dates[i]}: ${result.message}`,
      });
    } else {
      for (const offer of result) allOffers.push(offer);
    }
  }

  if (allOffers.length === 0) {
    errors.push({ code: 'NO_PROVIDER_RESULTS', message: 'All provider fetches returned no offers.' });
    return makeResult(request, [], errors);
  }

  // ── Map offers to routes ─────────────────────────────────────────────────────
  // Budget bands require a global minPrice, so routes are built after all
  // offers are collected.
  const minPrice = Math.min(...allOffers.map(o => o.totalPrice));
  const routes = allOffers.map(offer => offerToRoute(offer, params.departureDate, minPrice));

  // ── 4. Dedup ─────────────────────────────────────────────────────────────────
  const dedupedRoutes = deduplicateRoutes(routes);

  // ── 5. Feasibility filtering ─────────────────────────────────────────────────
  //
  // checkFeasibility evaluates each route against the traveler profile and
  // mode config using only static rule data + route fields (no pre-computed
  // warnings needed).
  //
  //   blocked    → removed immediately; never reach scoring or the response.
  //   restricted → survive with soft violations attached (only in
  //                urgent_get_me_home where relaxedFeasibility = true).
  //   feasible   → continue with no violations.
  //
  // Warnings, fragility, and risk are computed only on surviving routes —
  // there is no value in computing these for blocked routes.
  const candidates: ScoringCandidate[] = [];

  for (const route of dedupedRoutes) {
    const feasibility = checkFeasibility(route, traveler, mode);
    if (feasibility.status === 'blocked') continue;

    // ── 6a. Warnings (depends only on route static data) ──────────────────────
    route.warnings = generateWarnings(route);

    // ── 6b. Fragility (depends on warnings for transfer detection) ────────────
    const fragility = computeFragility(route, route.warnings);
    route.fragilityLabel = fragility.fragilityLabel;

    // ── 6c. Route risk (geopolitical / operational) ────────────────────────────
    const risk = computeRouteRisk(route);

    candidates.push({
      route,
      fragility,
      risk,
      // Hard violations are already handled (route would be blocked).
      // Only soft violations reach here, and only in urgent_get_me_home.
      softViolations: feasibility.violations.filter(v => v.severity === 'soft'),
    });
  }

  if (candidates.length === 0) {
    errors.push({ code: 'NO_ROUTES_FOUND', message: 'No viable routes after feasibility filtering.' });
    return makeResult(request, [], errors);
  }

  // ── 7. Score ─────────────────────────────────────────────────────────────────
  //
  // Scoring context (price percentiles, duration range) is derived exclusively
  // from routes that survived feasibility filtering — blocked routes do not
  // distort the reference distribution.
  const ctx = buildScoringContext(candidates);

  for (const candidate of candidates) {
    const { score, safeScore } = scoreRoute(candidate, mode, ctx, traveler);
    candidate.route.score     = score;
    candidate.route.safeScore = safeScore;
  }

  // ── Presentation helpers (temporary; isolated from core scoring logic) ────────
  assignRouteLabels(candidates, mode);
  for (const candidate of candidates) {
    candidate.route.summary = buildSummary(candidate.route, mode);
  }

  // ── 8. Rank ──────────────────────────────────────────────────────────────────
  // Sorted by route.score descending. safeScore is never used as a sort key.
  const ranked = candidates
    .map(c => c.route)
    .sort((a, b) => b.score - a.score)
    .slice(0, ROUTING_CONSTRAINTS.maxRoutesReturned);

  return makeResult(request, ranked, errors.length > 0 ? errors : undefined);
}

// ─── Fetch with cache ─────────────────────────────────────────────────────────

/**
 * Fetches offers for a single date, checking the cache first.
 *
 * Cache hit  → returns cached offers immediately; scheduler is NOT called;
 *              no provider call budget is consumed.
 *
 * Cache miss → calls scheduler.schedule(fn), which:
 *              (a) returns null if the provider call budget is exhausted, or
 *              (b) queues fn under the p-limit concurrency limiter and returns
 *                  a promise that resolves to the provider result.
 *
 * Returns:
 *   ProviderOffer[] — successful result (may be empty)
 *   null            — scheduler declined (budget exhausted)
 *   Error           — provider call failed
 */
async function fetchWithCache(
  origin: string,
  destination: string,
  date: string,
  passengers: number,
  currency: string,
  adapter: ProviderAdapter,
  cache: RouteCache<ProviderOffer[]>,
  scheduler: ProviderScheduler,
): Promise<ProviderOffer[] | null | Error> {
  const key = makeCacheKey(origin, destination, date, passengers);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const result = await scheduler.schedule(() =>
      adapter.fetchOffers({ origin, destination, date, passengers, currency }),
    );
    if (result === null) return null; // Budget exhausted
    cache.set(key, result);
    return result;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

// ─── Route builder ────────────────────────────────────────────────────────────

/**
 * Maps a raw provider offer to a Route.
 *
 * dateDeltaDays is computed relative to params.departureDate (the original
 * center of the date window), not relative to the specific window slot that
 * returned this offer. This gives the UI a consistent reference point.
 *
 * budgetBand requires a global minPrice across all offers from all dates —
 * this is why routes are built after all fetches complete.
 */
function offerToRoute(
  offer: ProviderOffer,
  originalRequestedDate: string,
  minPrice: number,
): Route {
  const actualDepartureDate =
    offer.flights[0]?.departingAt.slice(0, 10) ?? originalRequestedDate;
  const dateDeltaDays = dayDelta(originalRequestedDate, actualDepartureDate);

  return {
    id:                   routeId(offer),
    flights:              offer.flights,
    totalDurationMinutes: computeTotalDuration(offer.flights),
    totalPrice:           offer.totalPrice,
    currency:             offer.currency,
    actualDepartureDate,
    dateDeltaDays,
    source:               'provider',
    bookingMode:          'single_booking',
    budgetBand:           computeBudgetBand(offer.totalPrice, minPrice),
    fragilityLabel:       'low',  // overwritten after computeFragility
    score:                0,      // overwritten after scoreRoute
    safeScore:            0,      // overwritten after scoreRoute
    routeLabel:           '',     // overwritten after assignRouteLabels
    summary:              '',     // overwritten after buildSummary
    warnings:             [],     // overwritten after generateWarnings
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function computeBudgetBand(price: number, minPrice: number): BudgetBand {
  if (minPrice <= 0) return 'cheapest';
  const ratio = price / minPrice;
  if (ratio <= 1.05)                                          return 'cheapest';
  if (ratio <= ROUTING_CONSTRAINTS.budgetBandBalanced)        return 'balanced';
  if (ratio <= ROUTING_CONSTRAINTS.budgetBandFlexible)        return 'flexible';
  return 'over';
}

function computeTotalDuration(flights: Flight[]): number {
  if (flights.length === 0) return 0;
  const first = new Date(flights[0].departingAt).getTime();
  const last  = new Date(flights[flights.length - 1].arrivingAt).getTime();
  return Math.round((last - first) / 60_000);
}

function dayDelta(requested: string, actual: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round(
    (new Date(actual).getTime() - new Date(requested).getTime()) / msPerDay,
  );
}

function routeId(offer: ProviderOffer): string {
  const legs = offer.flights.map(f => `${f.carrier}${f.flightNumber}`).join('-');
  return `${legs}@${offer.totalPrice}`;
}

function makeResult(
  request: SearchRequest,
  routes: Route[],
  errors?: RoutingError[],
): SearchResult {
  const result: SearchResult = {
    params:      request.params,
    routes,
    mode:        request.mode,
    generatedAt: new Date().toISOString(),
  };
  if (errors && errors.length > 0) result.errors = errors;
  return result;
}
