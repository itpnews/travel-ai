import type {
  Route,
  SearchMode,
  Flight,
  BookingGroup,
  BudgetBand,
} from '@travel-ai/types';
import {
  HUB_POOL,
  AIRPORT_METADATA,
  ROUTING_CONSTRAINTS,
  SEARCH_MODE_CONFIGS,
} from '@travel-ai/types';
import type { ProviderAdapter, ProviderOffer } from './provider.js';
import type { RouteCache } from './cache.js';
import { makeCacheKey } from './cache.js';
import type { ProviderScheduler } from './scheduler.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** First phase of progressive hub expansion: try top 3 before expanding. */
const INITIAL_HUB_LIMIT = 3;

/** Maximum hubs evaluated per fallback run (top N after geographic filtering). */
const TOP_HUB_LIMIT = 6;

/**
 * Maximum assembled fallback route candidates before stopping generation.
 * Prevents unbounded cross-join explosion from large provider leg result sets.
 */
const MAX_FALLBACK_CANDIDATES = 25;

/**
 * Maximum hub permutations (1-hub + 2-hub combinations) attempted per run.
 * Each permutation consumes up to 3 scheduler budget slots (2 for 1-hub, 3 for 2-hub).
 */
const MAX_HUB_PERMUTATIONS = 20;

/**
 * Fallback is triggered when provider routes are fewer than this count.
 * Below this, the result set is considered insufficient for meaningful ranking.
 */
const MIN_ROUTE_COUNT = 5;

/**
 * Fallback is triggered when the best provider route scores below this threshold.
 * Routes below 0.35 are structurally or economically poor regardless of mode.
 */
const MIN_ACCEPTABLE_SCORE = 0.35;

/** Minimum same-airport layover for a connection to be realistic (minutes). */
const MIN_LAYOVER_SAME_AIRPORT = 45;

/**
 * Minimum layover when successive flights depart from different airports.
 * Must cover deplaning, ground transfer, and security re-entry.
 */
const MIN_LAYOVER_TRANSFER = 90;

/** Maximum layover between two connected legs. Beyond this is an unrealistic connection. */
const MAX_LAYOVER_MINUTES = 24 * 60; // 24 hours

/** Hard cap on assembled route total duration. Mirrors ROUTING_CONSTRAINTS.maxTotalDurationHours. */
const MAX_TOTAL_DURATION_MINUTES = ROUTING_CONSTRAINTS.maxTotalDurationHours * 60;

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Input context for a single fallback generation run.
 * Scoped to one (origin, destination, date) tuple.
 */
export interface FallbackContext {
  origin: string;       // IATA
  destination: string;  // IATA
  /** Center date from SearchParams.departureDate (YYYY-MM-DD). Used as reference for dateDeltaDays. */
  date: string;
  passengers: number;
  currency: string;
  mode: SearchMode;
}

// ─── Internal types ───────────────────────────────────────────────────────────

/** Hub candidate with a computed priority score used for sorting. */
interface HubEntry {
  airport: string;
  /** Higher = preferred. Derived from stabilityScore + optional inter-regional boost. */
  priority: number;
}

// ─── Regional data ────────────────────────────────────────────────────────────

/**
 * Country-to-region mapping used for inter-regional hub boosting.
 * Countries not listed are treated as region unknown; geographic filter still applies.
 */
const COUNTRY_REGION: Readonly<Record<string, string>> = {
  // Europe
  AT: 'europe', BE: 'europe', CH: 'europe', CZ: 'europe', DE: 'europe',
  DK: 'europe', ES: 'europe', FI: 'europe', FR: 'europe', GB: 'europe',
  GR: 'europe', IE: 'europe', IT: 'europe', NL: 'europe', NO: 'europe',
  PL: 'europe', PT: 'europe', RO: 'europe', RU: 'europe', SE: 'europe',
  TR: 'europe', UA: 'europe',
  // Middle East
  AE: 'middle_east', EG: 'middle_east', IL: 'middle_east', JO: 'middle_east',
  QA: 'middle_east', SA: 'middle_east',
  // North America
  CA: 'north_america', MX: 'north_america', US: 'north_america',
  // South America
  AR: 'south_america', BR: 'south_america', CO: 'south_america', VE: 'south_america',
  // Asia-Pacific
  AU: 'asia_pacific', CN: 'asia_pacific', HK: 'asia_pacific', ID: 'asia_pacific',
  IN: 'asia_pacific', JP: 'asia_pacific', KR: 'asia_pacific', MY: 'asia_pacific',
  NZ: 'asia_pacific', PH: 'asia_pacific', PK: 'asia_pacific', SG: 'asia_pacific',
  TH: 'asia_pacific', VN: 'asia_pacific',
  // Africa
  ET: 'africa', KE: 'africa', MA: 'africa', NG: 'africa', ZA: 'africa',
};

/**
 * Hubs to boost when the route crosses inter-regional boundaries.
 * Keys are sorted region-pair strings. Values are IATA codes of preferred transit hubs.
 * Only references airports that exist in HUB_POOL — no synthetic hubs.
 */
const INTER_REGIONAL_HUB_BOOST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['asia_pacific:europe',        new Set(['DXB', 'DOH'])],
  ['asia_pacific:middle_east',   new Set(['DXB', 'DOH', 'SIN'])],
  ['asia_pacific:north_america', new Set(['NRT', 'HKG', 'SIN', 'LAX'])],
  ['europe:middle_east',         new Set(['DXB', 'DOH'])],
  ['europe:north_america',       new Set(['LHR', 'CDG', 'JFK'])],
  ['africa:europe',              new Set(['CDG', 'LHR', 'FRA'])],
  ['africa:middle_east',         new Set(['DXB', 'DOH'])],
  ['middle_east:north_america',  new Set(['DXB', 'DOH'])],
  ['north_america:south_america',new Set(['ATL', 'JFK', 'ORD'])],
  ['south_america:europe',       new Set(['MAD', 'LHR', 'CDG'])],
]);

/** Boost applied to inter-regional hubs in priority scoring. */
const INTER_REGIONAL_BOOST = 0.15;

/**
 * Priority bonus for hubs that are geometrically "between" origin and destination.
 * Applied as an additive signal, not a hard gate — off-axis hubs remain candidates
 * but rank below forward-aligned ones.
 */
const DIRECTION_BONUS = 0.10;

// ─── Fallback activation ──────────────────────────────────────────────────────

/**
 * Decides whether fallback route generation should run.
 *
 * Fallback is triggered when:
 *   - No provider routes survived feasibility filtering, OR
 *   - Fewer than MIN_ROUTE_COUNT provider routes survived (result set too thin), OR
 *   - The best provider route score is below MIN_ACCEPTABLE_SCORE (poor quality)
 *
 * Call after provider routes have been scored. If providerCandidateCount === 0,
 * bestProviderScore should be passed as 0.
 *
 * Fallback routes are merged into the candidate pool alongside provider routes —
 * they do not replace them. The merged pool continues through:
 * warnings → fragility → risk → score → ranking → dedup.
 */
export function shouldRunFallback(
  providerCandidateCount: number,
  bestProviderScore: number,
): boolean {
  if (providerCandidateCount === 0) return true;
  if (providerCandidateCount < MIN_ROUTE_COUNT) return true;
  if (bestProviderScore < MIN_ACCEPTABLE_SCORE) return true;
  return false;
}

// ─── Fallback generation ──────────────────────────────────────────────────────

/**
 * Generates fallback routes by assembling hub-connected itineraries when
 * provider results are insufficient.
 *
 * Generation strategy (depth-1 only; depth-2 deferred to v1):
 *   - 1-hub routes: origin → hub → destination (2 provider legs)
 *   - 2-hub routes: origin → hub1 → hub2 → destination (3 provider legs)
 *
 * Hub selection uses a curated pool (HUB_POOL), filtered by geographic
 * direction and ranked by stabilityScore + optional inter-regional boost.
 * Progressive expansion tries the top 3 hubs first, then expands to top 6
 * if the candidate count is still below MAX_FALLBACK_CANDIDATES.
 *
 * All provider calls go through the scheduler (budget + concurrency gating).
 * A request-scoped leg cache prevents duplicate provider calls for the same
 * leg within a single fallback run.
 *
 * Stop conditions:
 *   - assembled.length >= MAX_FALLBACK_CANDIDATES
 *   - permutationCount >= MAX_HUB_PERMUTATIONS
 *   - scheduler.budgetRemaining() <= 0
 *   - no valid hub combinations remain
 *
 * Returned routes have source='fallback', bookingMode='separate_tickets'.
 * Budget bands are computed relative to the fallback set only; the caller
 * (engine) should recompute them after merging with provider routes.
 * Routes must be passed through deduplicateRoutes by the caller before
 * entering the scoring pipeline.
 */
export async function generateFallbackRoutes(
  ctx: FallbackContext,
  adapter: ProviderAdapter,
  sharedCache: RouteCache<ProviderOffer[]>,
  scheduler: ProviderScheduler,
): Promise<Route[]> {
  const { origin, destination, date, passengers, currency, mode } = ctx;
  const { maxFlightSegments, maxHubs } = SEARCH_MODE_CONFIGS[mode];

  const assembled: Route[] = [];
  // Tracks tried hub combinations (e.g. "DXB" or "DXB:LHR") across both phases.
  const triedCombinations = new Set<string>();
  let permutationCount = 0;

  // ── Request-scoped leg cache ──────────────────────────────────────────────
  // Key: "FROM:TO:DATE" — avoids duplicate provider calls within one fallback run.
  // Keyed without passengers/currency since those are fixed for the run.
  // Null value means the provider was unavailable (budget exhausted or error).
  const legCache = new Map<string, ProviderOffer[] | null>();

  // ── Closures scoped over run state ────────────────────────────────────────

  async function fetchLeg(from: string, to: string): Promise<ProviderOffer[] | null> {
    return fetchLegOffers(
      from, to, date, passengers, currency,
      adapter, sharedCache, legCache, scheduler,
    );
  }

  async function tryOneHub(hub: string): Promise<void> {
    if (assembled.length >= MAX_FALLBACK_CANDIDATES) return;
    if (permutationCount >= MAX_HUB_PERMUTATIONS) return;
    if (scheduler.budgetRemaining() <= 0) return;

    const key = hub;
    if (triedCombinations.has(key)) return;
    triedCombinations.add(key);
    permutationCount++;

    const [legAOffers, legBOffers] = await Promise.all([
      fetchLeg(origin, hub),
      fetchLeg(hub, destination),
    ]);
    if (!legAOffers || !legBOffers) return;

    for (const legA of legAOffers) {
      for (const legB of legBOffers) {
        if (assembled.length >= MAX_FALLBACK_CANDIDATES) return;
        if (!isValidConnection(legA, legB)) continue;
        const route = assembleFallbackRoute([legA, legB], date, maxFlightSegments);
        if (route) assembled.push(route);
      }
    }
  }

  async function tryTwoHubs(hub1: string, hub2: string): Promise<void> {
    if (maxHubs < 2) return;
    if (assembled.length >= MAX_FALLBACK_CANDIDATES) return;
    if (permutationCount >= MAX_HUB_PERMUTATIONS) return;
    if (scheduler.budgetRemaining() <= 0) return;

    const key = `${hub1}:${hub2}`;
    if (triedCombinations.has(key)) return;
    triedCombinations.add(key);
    permutationCount++;

    const [legAOffers, legBOffers, legCOffers] = await Promise.all([
      fetchLeg(origin, hub1),
      fetchLeg(hub1, hub2),
      fetchLeg(hub2, destination),
    ]);
    if (!legAOffers || !legBOffers || !legCOffers) return;

    for (const legA of legAOffers) {
      for (const legB of legBOffers) {
        if (!isValidConnection(legA, legB)) continue;
        for (const legC of legCOffers) {
          if (assembled.length >= MAX_FALLBACK_CANDIDATES) return;
          if (!isValidConnection(legB, legC)) continue;
          const route = assembleFallbackRoute([legA, legB, legC], date, maxFlightSegments);
          if (route) assembled.push(route);
        }
      }
    }
  }

  async function runHubs(hubs: HubEntry[]): Promise<void> {
    // 1-hub combinations first (simpler itineraries preferred)
    for (const hub of hubs) {
      if (assembled.length >= MAX_FALLBACK_CANDIDATES) return;
      if (permutationCount >= MAX_HUB_PERMUTATIONS) return;
      await tryOneHub(hub.airport);
    }

    // 2-hub combinations (ordered pairs — direction matters for connections)
    for (const hub1 of hubs) {
      for (const hub2 of hubs) {
        if (hub1.airport === hub2.airport) continue;
        if (assembled.length >= MAX_FALLBACK_CANDIDATES) return;
        if (permutationCount >= MAX_HUB_PERMUTATIONS) return;
        await tryTwoHubs(hub1.airport, hub2.airport);
      }
    }
  }

  // ── Phase 1: top 3 hubs ───────────────────────────────────────────────────
  const initialHubs = selectCandidateHubs(origin, destination, mode, INITIAL_HUB_LIMIT);
  await runHubs(initialHubs);

  // ── Phase 2: expand to top 6 if still insufficient ───────────────────────
  // triedCombinations prevents re-running phase-1 hub combinations.
  if (assembled.length < MAX_FALLBACK_CANDIDATES && scheduler.budgetRemaining() > 0) {
    const allHubs = selectCandidateHubs(origin, destination, mode, TOP_HUB_LIMIT);
    await runHubs(allHubs);
  }

  // ── Assign budget bands relative to the fallback set ─────────────────────
  // Placeholder 'cheapest' is set in assembleFallbackRoute; computed here once
  // all routes are assembled so the full price distribution is available.
  if (assembled.length > 0) {
    const minPrice = Math.min(...assembled.map(r => r.totalPrice));
    for (const route of assembled) {
      route.budgetBand = computeBudgetBand(route.totalPrice, minPrice);
    }
  }

  return assembled;
}

// ─── Hub selection ────────────────────────────────────────────────────────────

/**
 * Selects candidate hubs for fallback routing.
 *
 * Steps:
 *   1. Exclude origin and destination from the hub pool.
 *   2. Compute priority for each hub:
 *        base             = hub.stabilityScore
 *        + directionBonus = DIRECTION_BONUS (0.10) if the hub is geometrically
 *                           "between" origin and destination (forward-aligned).
 *                           Hubs that are off-axis still remain candidates but
 *                           rank lower. No hub is hard-rejected for geometry alone —
 *                           this allows valid patterns such as GOX → DXB → IST → WAW.
 *        + regionalBoost  = INTER_REGIONAL_BOOST (0.15) if the route crosses
 *                           regions and the hub is a known inter-regional connector.
 *   3. Sort by priority descending; return the top `limit` candidates.
 *
 * If AIRPORT_METADATA is missing for origin or destination (should not happen
 * after sanity validation), the direction bonus is skipped (all hubs receive 0).
 */
export function selectCandidateHubs(
  origin: string,
  destination: string,
  _mode: SearchMode,
  limit: number,
): HubEntry[] {
  const originMeta = AIRPORT_METADATA[origin];
  const destMeta = AIRPORT_METADATA[destination];

  const originRegion = airportRegion(origin);
  const destRegion = airportRegion(destination);

  // Determine inter-regional boost set (undefined if same region or region unknown)
  const boostedHubs: ReadonlySet<string> | undefined =
    originRegion && destRegion && originRegion !== destRegion
      ? INTER_REGIONAL_HUB_BOOST.get(regionPairKey(originRegion, destRegion))
      : undefined;

  const excluded = new Set([origin, destination]);

  const candidates: HubEntry[] = [];

  for (const hub of HUB_POOL) {
    if (excluded.has(hub.iata)) continue;

    // Geographic direction signal: bonus if hub is between origin and destination.
    // Off-axis hubs (e.g. a Middle East hub for a trans-Atlantic route) are not
    // rejected — they receive no bonus and rank below forward-aligned hubs.
    let directionBonus = 0;
    if (originMeta && destMeta) {
      const originDestDist = haversineKm(originMeta.lat, originMeta.lng, destMeta.lat, destMeta.lng);
      const originHubDist  = haversineKm(originMeta.lat, originMeta.lng, hub.lat, hub.lng);
      const hubDestDist    = haversineKm(hub.lat, hub.lng, destMeta.lat, destMeta.lng);

      const isForward = originHubDist < originDestDist && hubDestDist < originDestDist;
      if (isForward) directionBonus = DIRECTION_BONUS;
    }

    const boost    = boostedHubs?.has(hub.iata) ? INTER_REGIONAL_BOOST : 0;
    const priority = hub.stabilityScore + directionBonus + boost;

    candidates.push({ airport: hub.iata, priority });
  }

  return candidates
    // Secondary tiebreaker on IATA code ensures deterministic ordering when
    // two hubs share an identical priority score.
    .sort((a, b) => b.priority - a.priority || a.airport.localeCompare(b.airport))
    .slice(0, limit);
}

// ─── Leg fetching ─────────────────────────────────────────────────────────────

/**
 * Fetches provider offers for a single leg (point-to-point), checking caches first.
 *
 * Cache hierarchy (hit = return immediately; no further I/O):
 *   1. Request-scoped leg cache (Map keyed by "FROM:TO:DATE") — cheapest, no I/O.
 *      Null entry means a prior call for this leg was unavailable; skip provider.
 *   2. Shared TTL RouteCache (keyed by makeCacheKey) — survives across requests.
 *
 * On cache miss: calls scheduler.schedule(adapter.fetchOffers).
 *   - Returns null if the scheduler budget is exhausted.
 *   - Returns null on fetch error (treated as empty for fallback purposes).
 *   - On success: stores in both caches and returns offers.
 */
async function fetchLegOffers(
  from: string,
  to: string,
  date: string,
  passengers: number,
  currency: string,
  adapter: ProviderAdapter,
  sharedCache: RouteCache<ProviderOffer[]>,
  legCache: Map<string, ProviderOffer[] | null>,
  scheduler: ProviderScheduler,
): Promise<ProviderOffer[] | null> {
  const legKey = `${from}:${to}:${date}`;

  // ── Request-scoped leg cache ──────────────────────────────────────────────
  if (legCache.has(legKey)) {
    return legCache.get(legKey)!; // null entry = previously unavailable
  }

  // ── Shared TTL cache ──────────────────────────────────────────────────────
  const sharedKey = makeCacheKey(from, to, date, passengers);
  const sharedCached = sharedCache.get(sharedKey);
  if (sharedCached !== undefined) {
    legCache.set(legKey, sharedCached);
    return sharedCached;
  }

  // ── Provider call via scheduler ───────────────────────────────────────────
  try {
    const result = await scheduler.schedule(() =>
      adapter.fetchOffers({ origin: from, destination: to, date, passengers, currency }),
    );

    if (result === null) {
      // Budget exhausted — cache the miss so subsequent calls skip the scheduler
      legCache.set(legKey, null);
      return null;
    }

    sharedCache.set(sharedKey, result);
    legCache.set(legKey, result);
    return result;
  } catch {
    // Provider error — treat as unavailable for this run
    legCache.set(legKey, null);
    return null;
  }
}

// ─── Connection validation ────────────────────────────────────────────────────

/**
 * Returns true if outboundOffer can realistically follow inboundOffer.
 *
 * Checks (all must pass):
 *   1. Timezone sanity: outbound departure must be strictly after inbound arrival.
 *      Rejects impossible time sequences (including clock-reversal across timezones).
 *   2. Minimum layover:
 *      - Same airport (inbound.destination === outbound.origin): ≥ 45 min
 *      - Different airports (transfer): ≥ 90 min
 *   3. Maximum layover: ≤ 24 hours. Beyond this is not a realistic connection.
 *
 * Uses the last flight of inboundOffer and the first flight of outboundOffer
 * as the boundary flights for layover measurement.
 */
export function isValidConnection(
  inboundOffer: ProviderOffer,
  outboundOffer: ProviderOffer,
): boolean {
  const inboundLast    = inboundOffer.flights[inboundOffer.flights.length - 1];
  const outboundFirst  = outboundOffer.flights[0];

  if (!inboundLast || !outboundFirst) return false;

  const arrivalMs    = new Date(inboundLast.arrivingAt).getTime();
  const departureMs  = new Date(outboundFirst.departingAt).getTime();

  // Timezone sanity: departure must be strictly after arrival
  if (departureMs <= arrivalMs) return false;

  const layoverMinutes = (departureMs - arrivalMs) / 60_000;

  // Reject connections with non-finite layover (malformed timestamps yield NaN,
  // which would silently pass all numeric comparisons below).
  if (!isFinite(layoverMinutes)) return false;

  // Maximum layover cap
  if (layoverMinutes > MAX_LAYOVER_MINUTES) return false;

  // Minimum layover: same-airport vs transfer
  const sameAirport = inboundLast.destination === outboundFirst.origin;
  const minLayover  = sameAirport ? MIN_LAYOVER_SAME_AIRPORT : MIN_LAYOVER_TRANSFER;

  return layoverMinutes >= minLayover;
}

// ─── Route assembly ───────────────────────────────────────────────────────────

/**
 * Assembles a Route from an ordered list of provider leg offers.
 *
 * Rejects the combination (returns null) when:
 *   - Total flight count exceeds maxFlightSegments
 *   - Total duration exceeds MAX_TOTAL_DURATION_MINUTES (early pruning)
 *   - Any airport appears more than once in the sequence (loop detection)
 *   - Final arrival is not strictly after first departure (timezone sanity)
 *
 * Does not validate connection timing between legs — that is done by
 * isValidConnection before this function is called.
 *
 * Returned route has:
 *   source = 'fallback'
 *   bookingMode = 'separate_tickets'
 *   bookingGroups = one group per leg offer
 *   budgetBand = 'cheapest' placeholder (caller updates after full assembly)
 */
function assembleFallbackRoute(
  legs: ProviderOffer[],
  originalRequestedDate: string,
  maxFlightSegments: number,
): Route | null {
  const allFlights: Flight[] = legs.flatMap(leg => leg.flights);

  // Segment cap
  if (allFlights.length === 0 || allFlights.length > maxFlightSegments) return null;

  const firstFlight = allFlights[0];
  const lastFlight  = allFlights[allFlights.length - 1];

  const departureMs = new Date(firstFlight.departingAt).getTime();
  const arrivalMs   = new Date(lastFlight.arrivingAt).getTime();

  // Timezone sanity for the overall route
  if (arrivalMs <= departureMs) return null;

  const totalDurationMinutes = Math.round((arrivalMs - departureMs) / 60_000);

  // Early pruning: reject before building expensive data structures
  if (totalDurationMinutes > MAX_TOTAL_DURATION_MINUTES) return null;

  // Airport loop detection: rejects routes where the same IATA code appears more
  // than once (e.g. DXB → IST → DXB → WAW). Comparison is by IATA code only —
  // different airports in the same city are distinct codes and are never flagged
  // (e.g. a route touching both LHR and LGW is valid).
  const airportSequence: string[] = allFlights.map(f => f.origin);
  airportSequence.push(lastFlight.destination);

  if (new Set(airportSequence).size < airportSequence.length) return null;

  const totalPrice = legs.reduce((sum, l) => sum + l.totalPrice, 0);
  const currency   = legs[0].currency;

  const actualDepartureDate = firstFlight.departingAt.slice(0, 10);
  const dateDeltaDays       = dayDelta(originalRequestedDate, actualDepartureDate);

  return {
    id:                   fallbackRouteId(legs),
    flights:              allFlights,
    totalDurationMinutes,
    totalPrice,
    currency,
    actualDepartureDate,
    dateDeltaDays,
    source:               'fallback',
    bookingMode:          'separate_tickets',
    bookingGroups:        buildBookingGroups(legs),
    budgetBand:           'cheapest', // placeholder; updated after full assembly
    fragilityLabel:       'low',      // overwritten after computeFragility
    score:                0,          // overwritten after scoreRoute
    safeScore:            0,          // overwritten after scoreRoute
    routeLabel:           '',         // overwritten after assignRouteLabels
    summary:              '',         // overwritten after buildSummary
    warnings:             [],         // overwritten after generateWarnings
  };
}

/**
 * Builds one BookingGroup per provider leg offer.
 *
 * Each offer represents a separately purchased ticket. At MVP (depth-1 fallback),
 * assembled routes have 2 or 3 booking groups. Tickets are never merged across
 * provider offers — inter-line protection cannot be assumed.
 */
function buildBookingGroups(legs: ProviderOffer[]): BookingGroup[] {
  return legs.map((offer, i) => ({
    id:        `bg-${i}`,
    flightIds: offer.flights.map(f => f.id),
    carrier:   offer.flights[0]?.carrier,
  }));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Derives the region string for an airport from AIRPORT_METADATA + COUNTRY_REGION. */
function airportRegion(iata: string): string | undefined {
  const meta = AIRPORT_METADATA[iata];
  if (!meta) return undefined;
  return COUNTRY_REGION[meta.country];
}

/** Returns a canonical (sorted) key for a region pair, used for map lookup. */
function regionPairKey(r1: string, r2: string): string {
  return [r1, r2].sort().join(':');
}

/** Haversine great-circle distance between two lat/lng points (kilometres). */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  // Clamp to [0, 1] before asin: floating-point drift can produce values like
  // 1.0000000000000002, which Math.asin() turns into NaN.
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))));
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/** Deterministic identifier for a fallback route assembled from multiple offers. */
function fallbackRouteId(legs: ProviderOffer[]): string {
  const flights = legs.flatMap(l => l.flights);
  const legStr  = flights.map(f => `${f.carrier}${f.flightNumber}`).join('-');
  const price   = legs.reduce((sum, l) => sum + l.totalPrice, 0);
  return `fb:${legStr}@${price}`;
}

/**
 * Computes dateDeltaDays: signed number of calendar days between the original
 * requested date and the actual departure date of this route.
 */
function dayDelta(requested: string, actual: string): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round(
    (new Date(actual).getTime() - new Date(requested).getTime()) / MS_PER_DAY,
  );
}

/**
 * Classifies a price into a budget band relative to the cheapest option in the set.
 * Mirrors the same logic in engine.ts — both must remain in sync.
 */
function computeBudgetBand(price: number, minPrice: number): BudgetBand {
  if (minPrice <= 0) return 'cheapest';
  const ratio = price / minPrice;
  if (ratio <= 1.05)                                       return 'cheapest';
  if (ratio <= ROUTING_CONSTRAINTS.budgetBandBalanced)     return 'balanced';
  if (ratio <= ROUTING_CONSTRAINTS.budgetBandFlexible)     return 'flexible';
  return 'over';
}
