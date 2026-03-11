import type {
  SearchRequest,
  SearchResult,
  Route,
  RoutingError,
  BudgetBand,
  Flight,
} from '@travel-ai/types';
import { ROUTING_CONSTRAINTS } from '@travel-ai/types';
import { validateSearchParams, sanityCheckFinalRoutes } from './sanity.js';
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
import { shouldRunFallback, generateFallbackRoutes } from './fallback.js';
import { EngineTrace } from './trace.js';

// ─── Engine entry point ───────────────────────────────────────────────────────

/**
 * End-to-end routing pipeline for a single SearchRequest.
 *
 * Pipeline:
 *   1.  validate params
 *   2.  build date window (±flexDateWindowDays, past dates excluded)
 *   3.  fetch + cache  — scheduler is the single authority for provider call
 *                        budget and concurrency. Promise.all dispatches all date
 *                        fetches concurrently, but each fetch is wrapped in
 *                        scheduler.schedule() so the p-limit limiter controls
 *                        how many run in parallel, and the budget counter prevents
 *                        more than maxProviderCallsPerSearch total calls.
 *                        Cache hits bypass the scheduler entirely.
 *   4.  dedup          — keep best route per unique flight sequence
 *   5.  feasibility    — blocked routes removed; restricted routes continue
 *                        downstream with soft violations attached to scoring
 *   6.  warnings + fragility + route risk (computed on surviving routes only)
 *   7.  score          — preliminary pass on provider routes only; required to
 *                        evaluate the score-based fallback activation threshold
 *   8.  fallback       — triggered when provider results are insufficient by
 *                        count or quality (shouldRunFallback). Fallback routes
 *                        are assembled hub-by-hub using the same scheduler.
 *                        The merged set (provider + fallback) then re-runs the
 *                        full sub-pipeline: dedup → feasibility → warnings →
 *                        fragility → risk → score, so both sources are evaluated
 *                        under a unified scoring context and budget distribution.
 *                        When fallback does not trigger, provider routes already
 *                        scored in step 7 proceed directly to ranking.
 *   9.  rank           — sorted by route.score descending (never by safeScore)
 *  10.  return SearchResult
 */
export async function search(
  request: SearchRequest,
  adapter: ProviderAdapter,
  cache: RouteCache<ProviderOffer[]> = new RouteCache(),
): Promise<SearchResult> {
  const { params, traveler, mode } = request;
  const errors: RoutingError[] = [];
  const trace = new EngineTrace();

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
  //   - Provider call budget: callsUsed vs maxProviderCallsPerSearch.
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
  //
  // The scheduler instance is created once here and reused by fallback (step 8),
  // so the single budget cap covers both the provider fetch phase and the
  // hub-leg fetch phase. No provider calls can occur outside this scheduler.
  const scheduler = new ProviderScheduler();

  trace.begin('providerFetch');

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

  trace.end('providerFetch', { calls: dates.length, offers: allOffers.length });

  // Record the error but do NOT return — fallback (step 8) may still produce
  // viable routes even when the provider returns nothing.
  if (allOffers.length === 0) {
    errors.push({ code: 'NO_PROVIDER_RESULTS', message: 'All provider fetches returned no offers.' });
  }

  // ── Map provider offers to routes ────────────────────────────────────────────
  // Budget bands require a global minPrice, so routes are built after all
  // offers are collected. Empty when allOffers is empty.
  const providerRoutes: Route[] = [];
  if (allOffers.length > 0) {
    const minPrice = Math.min(...allOffers.map(o => o.totalPrice));
    for (const offer of allOffers) {
      providerRoutes.push(offerToRoute(offer, params.departureDate, minPrice));
    }
  }

  // ── 4. Dedup (provider) ──────────────────────────────────────────────────────
  trace.begin('dedup');
  const dedupedProviderRoutes = deduplicateRoutes(providerRoutes);
  trace.end('dedup', { before: providerRoutes.length, after: dedupedProviderRoutes.length });

  // ── 5–7. Feasibility → warnings → fragility → risk → score (provider) ────────
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
  //
  // Scoring is run on provider routes before the fallback decision so that
  // bestProviderScore is available for the score-based activation threshold.
  // If fallback is not triggered, these scores are final and used directly for
  // ranking. If fallback is triggered, all candidates are re-scored together
  // under a unified context after the merge (step 8).
  //
  // Scoring context (price percentiles, duration range) is derived exclusively
  // from routes that survived feasibility filtering.
  trace.begin('feasibility+scoring');
  const providerCandidates = buildCandidates(dedupedProviderRoutes, traveler, mode);
  scoreAll(providerCandidates, mode, traveler);
  trace.end('feasibility+scoring', { scored: providerCandidates.length });

  // ── 8. Fallback ──────────────────────────────────────────────────────────────
  //
  // Activation rule (any condition triggers fallback):
  //   a. No provider routes survived feasibility filtering.
  //   b. Provider route count < MIN_ROUTE_COUNT (result set too thin to rank).
  //   c. Best provider route score < MIN_ACCEPTABLE_SCORE (poor quality).
  //
  // When triggered:
  //   - Fallback routes are assembled hub-by-hub via the same scheduler,
  //     consuming from the shared budget. No direct adapter calls occur outside
  //     scheduler.schedule().
  //   - The fallback routes are merged with the (deduped) provider routes.
  //   - The merged set re-runs the full sub-pipeline so provider and fallback
  //     routes are evaluated under the same scoring context:
  //       dedup → feasibility → warnings → fragility → risk → score
  //   - Budget bands are recomputed after the merge so the global minPrice
  //     reflects the combined price distribution of both sources.
  //
  // When not triggered: providerCandidates (already scored) go straight to rank.
  const bestProviderScore = providerCandidates.length > 0
    ? Math.max(...providerCandidates.map(c => c.route.score))
    : 0;

  let candidates: ScoringCandidate[];

  if (shouldRunFallback(providerCandidates.length, bestProviderScore)) {
    trace.begin('fallback');

    const fallbackRoutes = await generateFallbackRoutes(
      {
        origin:      params.origin,
        destination: params.destination,
        date:        params.departureDate,
        passengers:  params.passengers,
        currency:    params.currency,
        mode,
      },
      adapter,
      cache,
      scheduler,
    );

    // Merge and re-run the full sub-pipeline on the combined set.
    // Placing dedupedProviderRoutes first ensures that when a fallback route
    // duplicates a provider route, deduplicateRoutes keeps the provider version
    // (smaller |dateDeltaDays| wins; ties favour the first occurrence).
    const mergedRoutes  = [...dedupedProviderRoutes, ...fallbackRoutes];
    const mergedDeduped = deduplicateRoutes(mergedRoutes);

    candidates = buildCandidates(mergedDeduped, traveler, mode);

    // Recompute budget bands with the unified minPrice before scoring so the
    // price distribution reflects both sources equally.
    if (candidates.length > 0) {
      const unifiedMinPrice = Math.min(...candidates.map(c => c.route.totalPrice));
      for (const c of candidates) {
        c.route.budgetBand = computeBudgetBand(c.route.totalPrice, unifiedMinPrice);
      }
      scoreAll(candidates, mode, traveler);
    }

    trace.end('fallback', { routesAdded: fallbackRoutes.length, total: candidates.length });
  } else {
    // Fallback not needed — provider routes already scored in step 7.
    candidates = providerCandidates;
  }

  if (candidates.length === 0) {
    errors.push({ code: 'NO_ROUTES_FOUND', message: 'No viable routes after feasibility filtering.' });
    return makeResult(request, [], errors);
  }

  // ── Presentation helpers (temporary; isolated from core scoring logic) ────────
  assignRouteLabels(candidates, mode);
  for (const candidate of candidates) {
    candidate.route.summary = buildSummary(candidate.route, mode);
  }

  // ── 9. Rank ──────────────────────────────────────────────────────────────────
  // Sorted by route.score descending. safeScore is never used as a sort key.
  // Secondary tiebreaker on route.id ensures deterministic ordering when two
  // routes share an identical score (JS sort is stable but needs a tiebreaker
  // to guarantee the same result across engine runs).
  trace.begin('ranking');
  const ranked = candidates
    .map(c => c.route)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, ROUTING_CONSTRAINTS.maxRoutesReturned);
  trace.end('ranking', { total: ranked.length });

  // ── Invariant check ───────────────────────────────────────────────────────────
  // Validates that no impossible connections escaped feasibility filtering and
  // that risky connections are properly flagged. Logs warnings only — does not
  // alter the result set. Silent in production; useful during development.
  sanityCheckFinalRoutes(ranked);

  trace.summary();
  return makeResult(request, ranked, errors.length > 0 ? errors : undefined);
}

// ─── Pipeline helpers ─────────────────────────────────────────────────────────

/**
 * Runs a list of routes through feasibility → warnings → fragility → risk,
 * returning only surviving (non-blocked) routes as ScoringCandidates.
 *
 * Used for both the provider-only pass (step 5–6) and the merged pass (step 8).
 * Pure in the sense that it only reads route data and static rule tables —
 * it mutates route.warnings and route.fragilityLabel as pipeline side-effects,
 * matching the existing convention in the engine.
 */
function buildCandidates(
  routes: Route[],
  traveler: Parameters<typeof checkFeasibility>[1],
  mode: Parameters<typeof checkFeasibility>[2],
): ScoringCandidate[] {
  const candidates: ScoringCandidate[] = [];

  for (const route of routes) {
    const feasibility = checkFeasibility(route, traveler, mode);
    if (feasibility.status === 'blocked') continue;

    route.warnings       = generateWarnings(route);
    const fragility      = computeFragility(route, route.warnings);
    route.fragilityLabel = fragility.fragilityLabel;
    const risk           = computeRouteRisk(route);

    candidates.push({
      route,
      fragility,
      risk,
      // Hard violations are already handled (route would be blocked).
      // Only soft violations reach here, and only in urgent_get_me_home.
      softViolations: feasibility.violations.filter(v => v.severity === 'soft'),
      riskyConnectionCount: feasibility.riskyConnectionCount,
    });
  }

  return candidates;
}

/**
 * Scores all candidates in-place using a scoring context derived from the
 * full candidate set. Both route.score and route.safeScore are overwritten.
 *
 * Used for both the provider-only preliminary pass (step 7) and the unified
 * re-score after fallback merge (step 8).
 */
function scoreAll(
  candidates: ScoringCandidate[],
  mode: Parameters<typeof scoreRoute>[1],
  traveler: Parameters<typeof scoreRoute>[3],
): void {
  if (candidates.length === 0) return;
  const ctx = buildScoringContext(candidates);
  for (const candidate of candidates) {
    const { score, safeScore } = scoreRoute(candidate, mode, ctx, traveler);

    // Pipeline invariant: non-finite scores must never reach the ranking sort.
    // scoreRoute's clamp() guards should prevent this, but we enforce it here
    // as a last line of defence so future changes cannot silently break ranking.
    if (!isFinite(score)) {
      console.warn(`[engine] route ${candidate.route.id} produced non-finite score (${score}); clamped to 0`);
      candidate.route.score = 0;
    } else {
      candidate.route.score = score;
    }

    if (!isFinite(safeScore)) {
      console.warn(`[engine] route ${candidate.route.id} produced non-finite safeScore (${safeScore}); clamped to 0`);
      candidate.route.safeScore = 0;
    } else {
      candidate.route.safeScore = safeScore;
    }
  }
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
