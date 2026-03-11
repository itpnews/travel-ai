// ─── Airport Selection Layer — Search-Space Control ───────────────────────────
//
// Reduces the search space before route generation begins by:
//   A. Selecting top candidate airports per country using static heuristics.
//   B. Generating and pruning airport pairs (origin × destination).
//   C. Gating route expansion (stops, detour, duration, loops).
//   D. Pruning dominated routes before the scoring pipeline.
//
// No provider calls are made in this layer. All data is from static tables.

import { AIRPORT_METADATA, HUB_POOL, COUNTRY_RISKS } from '@travel-ai/types';
import type { Hub } from '@travel-ai/types';
import { isSameCluster, getAirportCluster } from './city-airports.js';

// ─── Limits ───────────────────────────────────────────────────────────────────

/** Hard caps for the airport selection stage. */
export const AIRPORT_SELECTION_LIMITS = {
  maxOriginAirports:      4,
  maxDestinationAirports: 5,
  maxAirportPairs:        12,
} as const;

/**
 * Hard caps for route expansion.
 * maxTotalDurationHours is taken from the traveler profile (per-request constraint).
 */
export const EXPANSION_LIMITS = {
  /** Maximum intermediate stops (layover airports, not counting origin/destination). */
  maxStops: 3,
  /**
   * Maximum ratio of (route distance) / (direct great-circle distance).
   * A factor of 2.5 allows generous detours while preventing obviously circular routing.
   */
  maxDetourDistanceFactor: 2.5,
} as const;

/** Score below which a pair is considered too weak and pruned before ranking. */
const PAIR_PRUNE_THRESHOLD = 0.30;

// ─── Types ────────────────────────────────────────────────────────────────────

/** A scored airport candidate for one side (origin or destination) of a route. */
export interface AirportCandidate {
  iata: string;
  /** Composite heuristic score 0..1. Higher = better candidate. */
  score: number;
  countryRisk: number;
  isHub: boolean;
  hubStabilityScore: number;
}

/** A scored origin–destination airport pair. */
export interface AirportPair {
  origin: string;
  destination: string;
  /** Composite pair score 0..1. Higher = better candidate pair. */
  pairScore: number;
}

/** Result of the airport selection stage. */
export interface AirportSelectionResult {
  /** Top-scored origin airports; at most AIRPORT_SELECTION_LIMITS.maxOriginAirports. */
  originCandidates: AirportCandidate[];
  /** Top-scored destination airports; at most AIRPORT_SELECTION_LIMITS.maxDestinationAirports. */
  destinationCandidates: AirportCandidate[];
  /** Scored and pruned pairs; at most AIRPORT_SELECTION_LIMITS.maxAirportPairs. */
  airportPairs: AirportPair[];
}

/**
 * Dimensions required to evaluate route dominance.
 * Callers populate this from route data before calling applyDominancePruning.
 */
export interface RouteDimensions {
  /** Unique stable identifier (e.g. route.id). */
  id: string;
  totalPrice: number;
  totalDurationMinutes: number;
  /** Operational risk score 0..1 (from RouteRiskResult.riskScore). */
  riskScore: number;
  /** Structural fragility score 0..1 (from FragilityResult.fragilityScore). */
  fragilityScore: number;
  /** Number of intermediate stops (flights.length − 1). */
  stops: number;
  /**
   * True when the route contains an inter-airport ground transfer within a
   * metro cluster (e.g. arriving at LHR and departing from LGW).
   * Dominance comparison is skipped when this differs between two routes.
   */
  hasAirportTransfer: boolean;
  /**
   * City code of the destination cluster (e.g. "LON"), or undefined when the
   * destination airport does not belong to a known cluster.
   * Dominance comparison is skipped when routes differ by destination cluster.
   */
  destinationCluster: string | undefined;
}

/**
 * State passed to checkExpansion at each step of route construction.
 * Callers maintain this state as the route is assembled airport by airport.
 */
export interface ExpansionState {
  /** IATA codes of airports already visited on this route (origin + all stops so far). */
  visitedAirports: ReadonlySet<string>;
  /** Total route duration accumulated so far, in minutes. */
  currentDurationMinutes: number;
  /** Origin latitude (for detour calculation). */
  originLat: number;
  /** Origin longitude. */
  originLng: number;
  /** Destination latitude (for detour calculation). */
  destLat: number;
  /** Destination longitude. */
  destLng: number;
  /** Hard duration ceiling in minutes (from traveler.maxTotalDurationHours × 60). */
  maxTotalDurationMinutes: number;
}

/** Gate decision returned by checkExpansion. */
export interface ExpansionCheckResult {
  allowed: boolean;
  reason?: string;
}

// ─── Static data (computed once at load time) ─────────────────────────────────

/**
 * ISO country code → set of airport IATA codes.
 * Built from AIRPORT_METADATA at module load; never mutated.
 */
const COUNTRY_AIRPORTS: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const map = new Map<string, Set<string>>();
  for (const [iata, meta] of Object.entries(AIRPORT_METADATA)) {
    let set = map.get(meta.country);
    if (!set) { set = new Set(); map.set(meta.country, set); }
    set.add(iata);
  }
  return map;
})();

/** IATA → Hub entry. Used for hub importance scoring. */
const HUB_BY_IATA: ReadonlyMap<string, Hub> = new Map(
  HUB_POOL.map(h => [h.iata, h]),
);

/** ISO country code → operational risk score 0..1. Defaults to 0.5 for unknown countries. */
const COUNTRY_RISK_SCORE: ReadonlyMap<string, number> = new Map(
  COUNTRY_RISKS.map(r => [r.isoCode, r.riskScore]),
);

// ─── A. Airport scoring ───────────────────────────────────────────────────────

/**
 * Scores a single airport using static heuristics only. No provider calls.
 * Returns a score in 0..1 where 1.0 = ideal candidate.
 *
 * Factors and weights:
 *   hubScore    (0.40) — HUB_POOL stabilityScore, or 0.0 if not a hub
 *   stability   (0.35) — 1 − country risk (political stability proxy)
 *   connectivity(0.25) — 1.0 for international hubs, 0.5 for regional airports
 *
 * Hub importance and political stability are the dominant signals. Connectivity
 * acts as a tiebreaker: hubs serving international routes rank above regional
 * airports with the same country risk.
 */
function scoreAirport(iata: string): AirportCandidate {
  const meta    = AIRPORT_METADATA[iata];
  const country = meta?.country ?? '';
  const hub     = HUB_BY_IATA.get(iata);

  const countryRisk        = COUNTRY_RISK_SCORE.get(country) ?? 0.50;
  const hubStabilityScore  = hub?.stabilityScore ?? 0;
  const isHub              = hub !== undefined;

  const hubScore       = hubStabilityScore;
  const stabilityScore = 1 - countryRisk;
  const connectivity   = isHub ? 1.0 : 0.5;

  const score = 0.40 * hubScore + 0.35 * stabilityScore + 0.25 * connectivity;

  return { iata, score, countryRisk, isHub, hubStabilityScore };
}

/**
 * Returns scored airport candidates for a country, sorted by score descending.
 * Returns at most `limit` candidates. Returns an empty array for unknown countries.
 */
function selectAirportsForCountry(
  countryCode: string,
  limit: number,
): AirportCandidate[] {
  const airports = COUNTRY_AIRPORTS.get(countryCode);
  if (!airports || airports.size === 0) return [];

  return Array.from(airports)
    .map(scoreAirport)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ─── B. Airport pair generation and pruning ───────────────────────────────────

/**
 * Computes a directional alignment score for an origin–destination airport pair.
 * Uses a soft decay based on great-circle distance:
 *   - Very close pairs (< 500 km) score near 0.95 — useful for cross-border routing.
 *   - Very distant pairs (> 5000 km) score near 0.35 — still viable but rank lower.
 *
 * This is a soft signal, not a hard gate. Long-haul pairs remain candidates
 * but rank below geographically proximate ones.
 */
function pairDirectionScore(originIata: string, destIata: string): number {
  const oMeta = AIRPORT_METADATA[originIata];
  const dMeta = AIRPORT_METADATA[destIata];
  if (!oMeta || !dMeta) return 0.5;

  const dist = haversineKm(oMeta.lat, oMeta.lng, dMeta.lat, dMeta.lng);
  // Sigmoid-like decay: pairs separated by ~3000 km score ~0.5
  return 0.35 + 0.60 / (1 + dist / 3000);
}

/**
 * Generates scored airport pairs from origin and destination candidate lists.
 *
 * Pair score formula:
 *   0.40 × origin airport score
 * + 0.40 × destination airport score
 * + 0.20 × directional alignment score
 *
 * Pruning:
 *   - Same-airport self-pairs are excluded.
 *   - Pairs scoring below PAIR_PRUNE_THRESHOLD (0.30) are dropped.
 *   - Returns at most AIRPORT_SELECTION_LIMITS.maxAirportPairs pairs,
 *     sorted by pairScore descending.
 */
function generateAirportPairs(
  origins: AirportCandidate[],
  destinations: AirportCandidate[],
): AirportPair[] {
  const pairs: AirportPair[] = [];

  for (const o of origins) {
    for (const d of destinations) {
      if (o.iata === d.iata) continue;

      const dirScore = pairDirectionScore(o.iata, d.iata);
      const pairScore = 0.40 * o.score + 0.40 * d.score + 0.20 * dirScore;

      if (pairScore >= PAIR_PRUNE_THRESHOLD) {
        pairs.push({ origin: o.iata, destination: d.iata, pairScore });
      }
    }
  }

  return pairs
    .sort((a, b) => b.pairScore - a.pairScore)
    .slice(0, AIRPORT_SELECTION_LIMITS.maxAirportPairs);
}

// ─── Main airport selection entry point ──────────────────────────────────────

/**
 * Selects top airport candidates for both origin and destination countries,
 * generates scored pairs, and returns the AirportSelectionResult.
 *
 * This is the single entry point for the airport selection layer.
 * No provider calls. Deterministic for any given country pair.
 *
 * Output guarantees:
 *   originCandidates.length      ≤ AIRPORT_SELECTION_LIMITS.maxOriginAirports (4)
 *   destinationCandidates.length ≤ AIRPORT_SELECTION_LIMITS.maxDestinationAirports (5)
 *   airportPairs.length          ≤ AIRPORT_SELECTION_LIMITS.maxAirportPairs (12)
 */
export function selectAirports(
  originCountryCode: string,
  destinationCountryCode: string,
): AirportSelectionResult {
  const originCandidates = selectAirportsForCountry(
    originCountryCode,
    AIRPORT_SELECTION_LIMITS.maxOriginAirports,
  );

  const destinationCandidates = selectAirportsForCountry(
    destinationCountryCode,
    AIRPORT_SELECTION_LIMITS.maxDestinationAirports,
  );

  const airportPairs = generateAirportPairs(originCandidates, destinationCandidates);

  return { originCandidates, destinationCandidates, airportPairs };
}

// ─── D. Bounded route expansion ──────────────────────────────────────────────

/**
 * Gate check for adding the next airport to an in-progress route.
 * Returns allowed=false (with reason) as soon as any hard limit is hit.
 *
 * Checks in priority order:
 *   1. Stop count — at most EXPANSION_LIMITS.maxStops intermediate stops.
 *   2. Loop detection — nextAirport must not already appear in visitedAirports.
 *   3. Duration cap — cumulative duration must not exceed the traveler ceiling.
 *   4. Detour factor — (origin→next + next→dest) / (origin→dest direct)
 *                      must not exceed EXPANSION_LIMITS.maxDetourDistanceFactor.
 *
 * @param nextAirport     IATA code of the airport being considered for addition.
 * @param projectedDurationMinutes  Estimated total duration if this airport is added.
 * @param stopCount       Number of intermediate stops on the route so far (0 = first stop).
 * @param state           Immutable snapshot of the current expansion state.
 */
export function checkExpansion(
  nextAirport: string,
  projectedDurationMinutes: number,
  stopCount: number,
  state: ExpansionState,
): ExpansionCheckResult {
  // ── Stop limit ─────────────────────────────────────────────────────────────
  if (stopCount >= EXPANSION_LIMITS.maxStops) {
    return {
      allowed: false,
      reason: `Stop limit reached: ${stopCount} of ${EXPANSION_LIMITS.maxStops} max`,
    };
  }

  // ── Loop detection ─────────────────────────────────────────────────────────
  if (state.visitedAirports.has(nextAirport)) {
    return {
      allowed: false,
      reason: `Loop detected: ${nextAirport} already visited on this route`,
    };
  }

  // ── Duration cap ───────────────────────────────────────────────────────────
  if (projectedDurationMinutes > state.maxTotalDurationMinutes) {
    return {
      allowed: false,
      reason: `Projected duration ${projectedDurationMinutes} min exceeds cap ` +
        `${state.maxTotalDurationMinutes} min`,
    };
  }

  // ── Detour factor ─────────────────────────────────────────────────────────
  const nextMeta = AIRPORT_METADATA[nextAirport];
  if (nextMeta) {
    const directDist = haversineKm(
      state.originLat, state.originLng,
      state.destLat,   state.destLng,
    );
    if (directDist > 0) {
      const viaNext = haversineKm(
        state.originLat, state.originLng,
        nextMeta.lat,    nextMeta.lng,
      ) + haversineKm(
        nextMeta.lat, nextMeta.lng,
        state.destLat, state.destLng,
      );
      const detourFactor = viaNext / directDist;
      if (detourFactor > EXPANSION_LIMITS.maxDetourDistanceFactor) {
        return {
          allowed: false,
          reason: `Detour factor ${detourFactor.toFixed(2)} exceeds limit ` +
            `${EXPANSION_LIMITS.maxDetourDistanceFactor}`,
        };
      }
    }
  }

  return { allowed: true };
}

// ─── E. Dominance pruning ─────────────────────────────────────────────────────

/**
 * Removes dominated routes from a candidate set.
 *
 * Route A dominates route B when ALL of the following hold:
 *   A.totalPrice           ≤ B.totalPrice
 *   A.totalDurationMinutes ≤ B.totalDurationMinutes
 *   A.riskScore            ≤ B.riskScore
 *   A.fragilityScore       ≤ B.fragilityScore
 *   A.stops                ≤ B.stops
 *   AND A is strictly better in at least one of the above dimensions.
 *
 * Exemptions — routes are never pruned relative to each other when:
 *   - They differ in destination airport cluster (different routing option).
 *   - They differ in airport transfer semantics (hasAirportTransfer).
 *
 * Complexity: O(n²) — suitable for bounded sets (≤ AIRPORT_SELECTION_LIMITS.maxAirportPairs
 * or ≤ MAX_FALLBACK_CANDIDATES ≈ 25).
 *
 * The input array is not mutated. Returns a new array containing only the
 * routes that are not dominated by any other route in the set.
 */
export function applyDominancePruning(routes: RouteDimensions[]): RouteDimensions[] {
  const dominated = new Set<string>();

  for (let i = 0; i < routes.length; i++) {
    const a = routes[i];
    if (dominated.has(a.id)) continue;

    for (let j = 0; j < routes.length; j++) {
      if (i === j) continue;
      const b = routes[j];
      if (dominated.has(b.id)) continue;

      // Exemption: skip comparison when routes differ by destination cluster
      // or airport transfer semantics — they represent materially different options.
      if (a.destinationCluster !== b.destinationCluster) continue;
      if (a.hasAirportTransfer !== b.hasAirportTransfer) continue;

      if (dominates(a, b)) dominated.add(b.id);
    }
  }

  return routes.filter(r => !dominated.has(r.id));
}

/**
 * Returns true when route `a` dominates route `b`:
 *   weakly better in all dimensions AND strictly better in at least one.
 */
function dominates(a: RouteDimensions, b: RouteDimensions): boolean {
  const weaklyBetter =
    a.totalPrice           <= b.totalPrice           &&
    a.totalDurationMinutes <= b.totalDurationMinutes &&
    a.riskScore            <= b.riskScore            &&
    a.fragilityScore       <= b.fragilityScore       &&
    a.stops                <= b.stops;

  if (!weaklyBetter) return false;

  return (
    a.totalPrice           < b.totalPrice            ||
    a.totalDurationMinutes < b.totalDurationMinutes  ||
    a.riskScore            < b.riskScore             ||
    a.fragilityScore       < b.fragilityScore        ||
    a.stops                < b.stops
  );
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Haversine great-circle distance between two lat/lng points (kilometres). */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

// Re-export isSameCluster so callers can build RouteDimensions.hasAirportTransfer
// without importing from city-airports directly.
export { isSameCluster, getAirportCluster };
