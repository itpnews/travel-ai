import type {
  Route,
  SearchMode,
  TravelerProfile,
  FeasibilityViolation,
  RouteRiskResult,
} from '@travel-ai/types';
import type { FragilityResult } from './fragility.js';

// ─── Scoring Candidate ────────────────────────────────────────────────────────

/**
 * Internal intermediate type used during the scoring stage.
 * Carries a route plus its pre-computed fragility, risk, and soft violations.
 * Never persisted or returned to callers.
 */
export interface ScoringCandidate {
  route: Route;
  fragility: FragilityResult;
  risk: RouteRiskResult;
  /** Soft violations from checkFeasibility (hard violations are already filtered out). */
  softViolations: FeasibilityViolation[];
}

// ─── Scoring Context ──────────────────────────────────────────────────────────

/**
 * Aggregate price and duration statistics computed from all candidates that
 * survived feasibility filtering. Built once and passed to every scoreRoute call.
 *
 * minDuration / maxDuration are used only for the relative component of the
 * hybrid duration model. They do not anchor the absolute component, which uses
 * a fixed ceiling derived from the system hard cap.
 */
export interface ScoringContext {
  /** 10th-percentile price in the surviving candidate set */
  p10Price: number;
  /** 90th-percentile price in the surviving candidate set */
  p90Price: number;
  minDuration: number;
  maxDuration: number;
}

export function buildScoringContext(candidates: ScoringCandidate[]): ScoringContext {
  if (candidates.length === 0) {
    return { p10Price: 0, p90Price: 0, minDuration: 0, maxDuration: 0 };
  }

  const prices = candidates.map(c => c.route.totalPrice).sort((a, b) => a - b);
  const durations = candidates.map(c => c.route.totalDurationMinutes);

  return {
    p10Price:    percentile(prices, 0.10),
    p90Price:    percentile(prices, 0.90),
    minDuration: Math.min(...durations),
    maxDuration: Math.max(...durations),
  };
}

// ─── Mode Weights ─────────────────────────────────────────────────────────────

interface ModeWeights {
  price:     number;
  duration:  number;
  fragility: number;
  risk:      number;
  segments:  number;
  dateDelta: number;
}

/**
 * Per-mode scoring weight vectors. All weights in each vector sum to 1.0.
 *
 * best_overall:       Balanced across all factors. No dominant concern.
 *
 * safest:             Structural fragility (0.30) and geopolitical risk (0.25)
 *                     dominate. Segment complexity is a separate factor (0.15).
 *                     Price barely influences rank (0.10).
 *
 * best_value:         Price dominates (0.45). Duration secondary (0.15).
 *                     Structural risk is a minor tiebreaker.
 *
 * fastest_home:       Duration dominates (0.45). Price secondary (0.15).
 *                     Structural risk is a minor tiebreaker.
 *
 * urgent_get_me_home: Date proximity is important (0.25) but not dominant —
 *                     routes close to the requested date rank higher, but a
 *                     structurally bad route departing today will lose to a
 *                     realistic route departing tomorrow. Geopolitical risk
 *                     (0.20) and fragility (0.15) remain meaningful so the
 *                     mode does not surface dangerously unreliable paths.
 *                     Duration (0.20) keeps the journey time in play. Segments
 *                     (0.10) provide explicit complexity pressure. Intentionally
 *                     distinct from safest: temporal reachability matters, but
 *                     route realism is not sacrificed for it.
 */
const MODE_WEIGHTS: Record<SearchMode, ModeWeights> = {
  best_overall: {
    price:     0.25,
    duration:  0.20,
    fragility: 0.20,
    risk:      0.15,
    segments:  0.10,
    dateDelta: 0.10,
  },
  safest: {
    price:     0.10,
    duration:  0.10,
    fragility: 0.30,
    risk:      0.25,
    segments:  0.15,
    dateDelta: 0.10,
  },
  best_value: {
    price:     0.45,
    duration:  0.15,
    fragility: 0.15,
    risk:      0.10,
    segments:  0.10,
    dateDelta: 0.05,
  },
  fastest_home: {
    price:     0.15,
    duration:  0.45,
    fragility: 0.15,
    risk:      0.10,
    segments:  0.10,
    dateDelta: 0.05,
  },
  urgent_get_me_home: {
    price:     0.10,
    duration:  0.20,
    fragility: 0.15,
    risk:      0.20,
    segments:  0.10,
    dateDelta: 0.25,
  },
};

// ─── Assembled-route penalty (explicit, mode-aware) ───────────────────────────

/**
 * Point deduction applied to assembled (separate-ticket) routes after the
 * weighted factor sum.
 *
 * This penalty is SEPARATE from fragility.breakdown.separateTickets, which
 * models structural risk. This penalty models each mode's policy intolerance
 * of booking protection gaps as an explicit, named deduction.
 *
 * safest:             Maximum penalty — booking protection is a first-order
 *                     concern; assembled routes are actively undesirable.
 *
 * best_overall /      Moderate penalty — assembled routes are viable but
 * best_value /        structurally inferior to interlined options.
 * fastest_home:
 *
 * urgent_get_me_home: Reduced penalty — reachability and immediacy outweigh
 *                     booking protection. Separate tickets are tolerated but
 *                     still penalized relative to interlined routes.
 */
const ASSEMBLED_PENALTY: Record<SearchMode, number> = {
  safest:             0.20,
  best_overall:       0.10,
  best_value:         0.08,
  fastest_home:       0.08,
  urgent_get_me_home: 0.05,
};

// ─── Segment goodness table ───────────────────────────────────────────────────

/**
 * Goodness score by flight count (index = number of flights, 0..4).
 * Segment complexity is a SEPARATE scoring factor from fragility.
 * Direct flights (1 segment) score best; each stop sharply degrades the score.
 *
 * Index 0 is unused (routes always have ≥ 1 flight); included for safe indexing.
 */
const SEGMENT_GOODNESS: number[] = [0, 1.00, 0.75, 0.40, 0.15];

// ─── Soft violation penalties ─────────────────────────────────────────────────

/**
 * Additional point deduction per soft feasibility violation.
 * Only applied to 'restricted' routes in urgent_get_me_home, where
 * relaxedFeasibility = true allows these routes to survive filtering.
 * The violation is NOT ignored — it propagates here as a scoring penalty.
 */
const SOFT_VIOLATION_PENALTY: Partial<Record<string, number>> = {
  SEPARATE_TICKETS_NOT_ALLOWED: 0.15,
  AIRPORT_TRANSFER_NOT_ALLOWED: 0.10,
};

// ─── Score route ──────────────────────────────────────────────────────────────

/**
 * Computes mode-weighted score and structural safeScore for a single candidate.
 *
 * route.score
 *   The real engine ranking score for the active mode.
 *   This is the ONLY value the engine uses to sort routes.
 *   It reflects the mode's intent: value, speed, safety, or reachability.
 *
 * route.safeScore
 *   A helper score computed under safest weights regardless of the active mode.
 *   It does NOT influence sort order. It exists only so that the temporary
 *   presentation helper (assignRouteLabels) can identify the structurally
 *   safest route in the result set for the "Safest option" label.
 *   When the presentation layer is refactored out of this module, safeScore
 *   should be removed or moved with it.
 *
 * Both values are clamped to 0..1 after all penalties are applied.
 */
export function scoreRoute(
  candidate: ScoringCandidate,
  mode: SearchMode,
  ctx: ScoringContext,
  traveler: TravelerProfile,
): { score: number; safeScore: number } {
  const { route, fragility, risk, softViolations } = candidate;
  const w = MODE_WEIGHTS[mode];

  // ── Individual factor goodness values (0..1, 1 = best) ──────────────────────
  // Each factor is wrapped in finite() so a NaN from a sub-computation cannot
  // corrupt the weighted sum. dateDeltaGoodness is additionally clamped to [0,1]
  // because |dateDeltaDays| > 3 would otherwise produce a negative value.
  const priceGoodness     = finite(computePriceScore(route.totalPrice, ctx, traveler), 0);
  const durationGoodness  = finite(computeDurationScore(route.totalDurationMinutes, ctx), 0);
  const fragilityGoodness = finite(1 - fragility.fragilityScore, 0);
  const riskGoodness      = finite(1 - risk.riskScore, 0);
  const segmentCount      = Math.min(Math.max(route.flights.length, 1), 4);
  const segmentGoodness   = SEGMENT_GOODNESS[segmentCount] ?? 0.15;
  const dateDeltaGoodness = clamp(1 - Math.abs(route.dateDeltaDays) / 3, 0, 1);

  // ── Weighted sum ─────────────────────────────────────────────────────────────
  const weighted =
    w.price     * priceGoodness     +
    w.duration  * durationGoodness  +
    w.fragility * fragilityGoodness +
    w.risk      * riskGoodness      +
    w.segments  * segmentGoodness   +
    w.dateDelta * dateDeltaGoodness;

  // ── Assembled-route penalty (explicit, mode-aware, separate from fragility) ──
  const assembledPenalty = route.bookingMode === 'separate_tickets'
    ? ASSEMBLED_PENALTY[mode]
    : 0;

  // ── Soft feasibility violation penalty ───────────────────────────────────────
  // Only present on 'restricted' routes (urgent_get_me_home with relaxedFeasibility).
  // Violations are NOT ignored — they reduce the score proportionally.
  let softPenalty = 0;
  for (const v of softViolations) {
    softPenalty += SOFT_VIOLATION_PENALTY[v.constraint] ?? 0.05;
  }

  const score = clamp(weighted - assembledPenalty - softPenalty, 0, 1);

  // ── safeScore (always uses safest weights; used only for labeling) ────────────
  const sw = MODE_WEIGHTS.safest;
  const safeWeighted =
    sw.price     * priceGoodness     +
    sw.duration  * durationGoodness  +
    sw.fragility * fragilityGoodness +
    sw.risk      * riskGoodness      +
    sw.segments  * segmentGoodness   +
    sw.dateDelta * dateDeltaGoodness;

  const safeScore = clamp(
    safeWeighted
      - (route.bookingMode === 'separate_tickets' ? ASSEMBLED_PENALTY.safest : 0)
      - softPenalty,
    0,
    1,
  );

  return { score, safeScore };
}

// ─── Price score ──────────────────────────────────────────────────────────────

/**
 * Computes price goodness (0..1, 1 = cheapest/best).
 *
 * Without maxBudget — bounded relative model:
 *   Uses the p10/p90 range of the surviving candidate set as the reference band.
 *   Routes at or below p10 score 1.0; routes at or above p90 score 0.0.
 *   Outliers above p90 are clamped to 0.0 and do NOT proportionally compress
 *   the scores of routes within the normal price range. This prevents a single
 *   expensive outlier from making mid-range routes appear artificially cheap.
 *
 * With maxBudget — hybrid model:
 *   60% weight: relative position within the p10/p90 band (same as above).
 *   40% weight: absolute budget pressure = price / maxBudget.
 *   A route that is inexpensive relative to alternatives but still near the
 *   traveler's ceiling is penalized — it reflects real cost pain even if the
 *   route looks "cheap" relative to other options in the result set.
 *   Budget-exceeding routes are already removed by hard feasibility filtering,
 *   so budgetPressure is always ≤ 1.0 at this stage.
 */
function computePriceScore(
  price: number,
  ctx: ScoringContext,
  traveler: TravelerProfile,
): number {
  const spread = ctx.p90Price - ctx.p10Price;

  // Relative position within p10..p90 band (0 = at/below p10, 1 = at/above p90)
  const relativePos = spread === 0
    ? 0.5
    : clamp((price - ctx.p10Price) / spread, 0, 1);

  if (traveler.maxBudget !== undefined && traveler.maxBudget > 0) {
    const budgetPressure = clamp(price / traveler.maxBudget, 0, 1);
    const hybridBadness = 0.6 * relativePos + 0.4 * budgetPressure;
    return 1 - hybridBadness;
  }

  return 1 - relativePos;
}

// ─── Duration score ───────────────────────────────────────────────────────────

/**
 * Absolute duration ceiling used to anchor the duration score independently of
 * the surviving result set. Matches ROUTING_CONSTRAINTS.maxTotalDurationHours
 * (72h), the system hard cap — routes cannot exceed this value after feasibility
 * filtering, so absolutePressure is always ≤ 1.0 at this stage.
 */
const DURATION_CEILING_MINUTES = 72 * 60; // 4320 min

/**
 * Computes duration goodness (0..1, 1 = fastest/best).
 *
 * Hybrid model — 50% absolute pressure, 50% relative position:
 *
 *   Absolute pressure = durationMinutes / DURATION_CEILING_MINUTES
 *     Anchors scores to real journey cost. A 48h route is always penalized
 *     for being a 48h journey, regardless of how bad the alternatives are.
 *     Without this component, a route that is "only slightly faster than
 *     other very long routes" would score far too well.
 *
 *   Relative position = (durationMinutes − minDuration) / (maxDuration − minDuration)
 *     Preserves useful differentiation within the surviving set. When routes
 *     are clustered in a narrow duration band, the relative component ensures
 *     the genuinely faster option still ranks higher.
 *
 * Combined:
 *   durationGoodness = 1 − (0.5 × absolutePressure + 0.5 × relativePos)
 *
 * Effect on pathological cases:
 *   All routes long (48h–72h): best route scores ≤ 0.33, not 1.0.
 *   All routes short (2h–4h):  best route scores ≥ 0.97, reflecting its
 *     genuine quality rather than just beating a bad field.
 *   Single route at 72h:       scores 0.25 (absolute=1.0, relative=0.5 → 0.75 bad).
 */
function computeDurationScore(durationMinutes: number, ctx: ScoringContext): number {
  const absolutePressure = clamp(durationMinutes / DURATION_CEILING_MINUTES, 0, 1);

  const spread = ctx.maxDuration - ctx.minDuration;
  const relativePos = spread === 0
    ? 0.5
    : clamp((durationMinutes - ctx.minDuration) / spread, 0, 1);

  return 1 - (0.5 * absolutePressure + 0.5 * relativePos);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  // Guard NaN/Infinity: Math.max/min propagate NaN silently.
  if (!isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Returns `value` if it is a finite number, otherwise `fallback`.
 * Applied to every scoring factor before the weighted sum to prevent
 * NaN from a single factor corrupting the entire score.
 */
function finite(value: number, fallback: number): number {
  return isFinite(value) ? value : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── Temporary presentation helpers ──────────────────────────────────────────
//
// assignRouteLabels and buildSummary are TEMPORARY presentation-layer helpers
// living here for convenience during early development. They:
//   - do not influence route.score, sort order, or any ranking logic
//   - depend on route.safeScore, which itself exists only to support labeling
//   - should be extracted to a dedicated presentation module (e.g.
//     services/routing/src/presentation.ts or an app-layer adapter) before
//     this scoring module is considered stable
//
// Nothing in the engine pipeline should depend on the output of these helpers
// for correctness. They are called last, after sorting, as a decoration step.

/**
 * Assigns route labels based on relative rank across scoring dimensions.
 *
 * Labels (first match per route wins, in priority order):
 *   "Best overall"   — highest route.score for the active mode
 *   "Best value"     — lowest totalPrice
 *   "Safest option"  — highest route.safeScore (structural safety helper)
 *   "Fastest option" — shortest totalDurationMinutes
 *
 * TEMPORARY presentation helper. Does not affect core scoring or sort order.
 * Must be called after scoreRoute has populated route.score and route.safeScore.
 */
export function assignRouteLabels(
  candidates: ScoringCandidate[],
  _mode: SearchMode,
): void {
  if (candidates.length === 0) return;

  for (const c of candidates) c.route.routeLabel = '';

  const byScore    = [...candidates].sort((a, b) => b.route.score              - a.route.score);
  const byPrice    = [...candidates].sort((a, b) => a.route.totalPrice         - b.route.totalPrice);
  const bySafe     = [...candidates].sort((a, b) => b.route.safeScore          - a.route.safeScore);
  const byDuration = [...candidates].sort((a, b) => a.route.totalDurationMinutes - b.route.totalDurationMinutes);

  const labeled = new Set<string>();
  const labelTargets: [ScoringCandidate[], string][] = [
    [byScore,    'Best overall'],
    [byPrice,    'Best value'],
    [bySafe,     'Safest option'],
    [byDuration, 'Fastest option'],
  ];

  for (const [sorted, label] of labelTargets) {
    const top = sorted[0];
    if (top && !labeled.has(top.route.id)) {
      top.route.routeLabel = label;
      labeled.add(top.route.id);
    }
  }
}

/**
 * Generates a one-sentence plain-language summary for a route.
 * TEMPORARY presentation helper. Does not affect scoring or sort order.
 * Should move to the presentation layer alongside assignRouteLabels.
 */
export function buildSummary(route: Route, mode: SearchMode): string {
  const stops = route.flights.length - 1;
  const stopStr = stops === 0 ? 'nonstop' : `${stops} stop${stops > 1 ? 's' : ''}`;
  const assembled = route.bookingMode === 'separate_tickets';
  const assembledNote = assembled ? ', separate tickets required' : '';

  switch (mode) {
    case 'urgent_get_me_home': {
      const days = Math.abs(route.dateDeltaDays);
      const when = days === 0
        ? 'today'
        : `${days} day${days > 1 ? 's' : ''} ${route.dateDeltaDays > 0 ? 'later' : 'earlier'}`;
      return `${stopStr} path home departing ${when}${assembledNote}.`;
    }
    case 'safest':
      return `${stopStr} route with ${assembled
        ? 'separate-ticket booking (no interline protection)'
        : 'full interline protection'}.`;
    case 'best_value':
      return `${route.currency} ${route.totalPrice.toLocaleString()} ${stopStr} route${assembledNote}.`;
    case 'fastest_home': {
      const hours = Math.round(route.totalDurationMinutes / 60);
      return `${hours}-hour ${stopStr} route${assembledNote}.`;
    }
    default:
      return `${stopStr} route departing ${route.actualDepartureDate}${assembledNote}.`;
  }
}
