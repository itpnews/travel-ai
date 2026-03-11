/**
 * Post-normalization enrichment layer.
 *
 * Takes the Route[] from normalizeAmadeusResponse() and adds:
 *   - layover analysis (minLayoverMinutes, connectionQuality per route)
 *   - airport transfer detection (requiresAirportTransfer)
 *   - refined fragility (using richer layover thresholds and transfer penalty)
 *   - enriched warnings (TIGHT_CONNECTION, RISKY_ITINERARY, AIRPORT_TRANSFER_REQUIRED)
 *   - re-derived scores + labels (since fragility may have changed)
 *   - whyRankedHere explanation for each route
 *
 * This module is intentionally self-contained and server-side only.
 * It does not import from the routing engine or any external service.
 */

import type {
  Route,
  Flight,
  FragilityLabel,
  ConnectionQuality,
  RouteWarning,
  RouteWarningCode,
  SearchMode,
} from '@travel-ai/types';

// ─── Layover thresholds ───────────────────────────────────────────────────────

/** < 45 min — almost certainly unmakeable */
const IMPOSSIBLE_MINS = 45;
/** < 90 min — elevated miss risk */
const RISKY_MINS = 90;
/** < 180 min — feasible but limited delay buffer */
const TIGHT_MINS = 180;

// ─── Connection quality helpers ───────────────────────────────────────────────

/**
 * Layover minutes between two consecutive flights.
 * Amadeus returns local airport times without Z; appending Z lets Date.getTime() treat
 * them as UTC, which is consistent across consecutive legs at the same timezone.
 */
function layoverMins(prev: Flight, next: Flight): number {
  const arr = prev.arrivingAt.includes('Z') ? prev.arrivingAt : prev.arrivingAt + 'Z';
  const dep = next.departingAt.includes('Z') ? next.departingAt : next.departingAt + 'Z';
  return (new Date(dep).getTime() - new Date(arr).getTime()) / 60_000;
}

function classifyLayover(mins: number): ConnectionQuality {
  if (mins < IMPOSSIBLE_MINS) return 'impossible';
  if (mins < RISKY_MINS)      return 'risky';
  if (mins < TIGHT_MINS)      return 'tight';
  return 'safe';
}

const QUALITY_RANK: Record<ConnectionQuality, number> = {
  safe: 0, tight: 1, risky: 2, impossible: 3,
};

function worstQuality(qs: ConnectionQuality[]): ConnectionQuality {
  return qs.reduce((worst, q) =>
    QUALITY_RANK[q] > QUALITY_RANK[worst] ? q : worst, 'safe' as ConnectionQuality,
  );
}

// ─── Fragility refinement ─────────────────────────────────────────────────────

const FRAGILITY_UP: Record<FragilityLabel, FragilityLabel> = {
  low: 'medium', medium: 'high', high: 'critical', critical: 'critical',
};

function refineFragility(
  flights:              Flight[],
  worstConn:            ConnectionQuality | undefined,
  requiresTransfer:     boolean,
): FragilityLabel {
  let f: FragilityLabel;

  if (flights.length === 1) {
    f = 'low';
  } else if (flights.length >= 3) {
    f = 'high';
  } else {
    // 2-segment route: use connection quality as primary signal
    switch (worstConn) {
      case 'safe':      f = 'medium';   break;
      case 'tight':     f = 'high';     break;
      case 'risky':     f = 'high';     break;
      case 'impossible':f = 'critical'; break;
      default:          f = 'medium';
    }
  }

  // Airport transfer is an additional structural risk — bump one level
  if (requiresTransfer && f !== 'critical') {
    f = FRAGILITY_UP[f];
  }

  return f;
}

// ─── Warning enrichment ───────────────────────────────────────────────────────

/**
 * Replaces the rough SHORT_CONNECTION warnings from normalize with finer-grained
 * ones keyed to the new thresholds, and adds AIRPORT_TRANSFER_REQUIRED.
 * Non-connection warnings (MANY_SEGMENTS, LONG_TRAVEL_TIME) are preserved.
 */
function buildEnrichedWarnings(
  flights:          Flight[],
  layovers:         number[],          // one entry per consecutive pair
  requiresTransfer: boolean,
  existing:         RouteWarning[],
): RouteWarning[] {
  // Keep non-connection structural warnings unchanged
  const keep = existing.filter(w => w.code !== 'SHORT_CONNECTION');
  const result: RouteWarning[] = [...keep];
  const added = new Set<RouteWarningCode>(keep.map(w => w.code));

  for (let i = 0; i < layovers.length; i++) {
    const mins = layovers[i];
    const at   = flights[i].destination;
    const q    = classifyLayover(mins);

    if (q === 'impossible' && !added.has('RISKY_ITINERARY')) {
      result.push({
        code:     'RISKY_ITINERARY',
        message:  `Only ${Math.round(mins)} min to connect at ${at} — this is extremely tight and likely not bookable.`,
        severity: 'critical',
      });
      added.add('RISKY_ITINERARY');
    } else if (q === 'risky' && !added.has('SHORT_CONNECTION')) {
      result.push({
        code:     'SHORT_CONNECTION',
        message:  `Only ${Math.round(mins)} min to connect at ${at}. Missed-flight risk is elevated.`,
        severity: 'warn',
      });
      added.add('SHORT_CONNECTION');
    } else if (q === 'tight' && !added.has('TIGHT_CONNECTION')) {
      result.push({
        code:     'TIGHT_CONNECTION',
        message:  `${Math.round(mins)} min layover at ${at} — manageable, but limited buffer for delays.`,
        severity: 'warn',
      });
      added.add('TIGHT_CONNECTION');
    }
  }

  if (requiresTransfer && !added.has('AIRPORT_TRANSFER_REQUIRED')) {
    result.push({
      code:     'AIRPORT_TRANSFER_REQUIRED',
      message:  'This route requires a ground transfer between airports. Allow at least 90 extra minutes.',
      severity: 'warn',
    });
  }

  return result;
}

// ─── Re-scoring ───────────────────────────────────────────────────────────────

/**
 * Mirrors MODE_WEIGHTS from score.ts.
 * Called after fragility refinement to keep scores consistent with the updated labels.
 */
const FRAGILITY_PENALTY: Record<FragilityLabel, number> = {
  low: 0, medium: 0.15, high: 0.35, critical: 0.55,
};

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function recomputeScores(routes: Route[], mode: SearchMode): void {
  if (routes.length === 0) return;

  const prices = routes.map(r => r.totalPrice);
  const durs   = routes.map(r => r.totalDurationMinutes);
  const minP   = Math.min(...prices), maxP = Math.max(...prices);
  const minD   = Math.min(...durs),   maxD = Math.max(...durs);

  for (const r of routes) {
    const pG = maxP === minP ? 1 : 1 - (r.totalPrice - minP)             / (maxP - minP);
    const dG = maxD === minD ? 1 : 1 - (r.totalDurationMinutes - minD)   / (maxD - minD);
    const fG = 1 - FRAGILITY_PENALTY[r.fragilityLabel];

    let s: number;
    switch (mode) {
      case 'best_value':    s = 0.45 * pG + 0.15 * dG + 0.40 * fG; break;
      case 'fastest_home':  s = 0.15 * pG + 0.45 * dG + 0.40 * fG; break;
      case 'safest':        s = 0.10 * pG + 0.10 * dG + 0.80 * fG; break;
      default:              s = 0.35 * pG + 0.35 * dG + 0.30 * fG;
    }

    r.score     = clamp(s);
    r.safeScore = clamp(0.20 * pG + 0.20 * dG + 0.60 * fG);
  }
}

// ─── Label re-assignment ──────────────────────────────────────────────────────

/** Mirrors assignRouteLabels() from services/routing/src/score.ts. */
function reassignLabels(routes: Route[]): void {
  for (const r of routes) r.routeLabel = '';

  const byScore    = [...routes].sort((a, b) => b.score               - a.score);
  const byPrice    = [...routes].sort((a, b) => a.totalPrice          - b.totalPrice);
  const bySafe     = [...routes].sort((a, b) => b.safeScore           - a.safeScore);
  const byDuration = [...routes].sort((a, b) => a.totalDurationMinutes - b.totalDurationMinutes);

  const labeled = new Set<string>();
  const targets: [Route[], string][] = [
    [byScore,    'Best overall'],
    [byPrice,    'Best value'],
    [bySafe,     'Safest option'],
    [byDuration, 'Fastest option'],
  ];

  for (const [sorted, label] of targets) {
    const top = sorted[0];
    if (top && !labeled.has(top.id)) {
      top.routeLabel = label;
      labeled.add(top.id);
    }
  }
}

// ─── Ranking explanation ──────────────────────────────────────────────────────

function buildWhyRankedHere(route: Route): string {
  const stops  = route.flights.length - 1;
  const connAt = stops === 1 ? ` at ${route.flights[0].destination}` : '';
  const q      = route.connectionQuality;

  if (route.routeLabel === 'Best overall') {
    return 'Best overall balance of price, duration, and connection reliability.';
  }
  if (route.routeLabel === 'Best value') {
    return `Cheapest available option at ${route.currency} ${route.totalPrice.toLocaleString()}.`;
  }
  if (route.routeLabel === 'Safest option') {
    if (stops === 0) return 'Lowest disruption risk — direct nonstop flight.';
    return `Lowest disruption risk with a ${q === 'safe' ? 'comfortable' : 'manageable'} connection${connAt}.`;
  }
  if (route.routeLabel === 'Fastest option') {
    const h = Math.floor(route.totalDurationMinutes / 60);
    const m = route.totalDurationMinutes % 60;
    return `Fastest available — ${h}h${m > 0 ? ` ${m}m` : ''} total travel time.`;
  }

  // Unlabeled routes: explain the trade-off based on structural properties
  if (stops === 0) return 'Direct nonstop — no connection risk.';
  if (route.requiresAirportTransfer) return `Requires airport transfer${connAt} — allow extra ground time.`;
  if (q === 'impossible') return `Very tight connection${connAt} — high missed-flight risk.`;
  if (q === 'risky')      return `Short connection${connAt} leaves limited time for delays.`;
  if (q === 'tight')      return `Moderate value, but tighter connections increase disruption risk.`;
  return `Comfortable layover${connAt} with good buffer for delays.`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enriches a set of normalized routes with connection analysis, refined fragility,
 * enriched warnings, re-derived scores, and ranking explanations.
 *
 * Mutates routes in place and returns the same array, re-sorted by score.
 */
export function enrichRoutes(routes: Route[], mode: SearchMode): Route[] {
  if (routes.length === 0) return routes;

  // ── Phase 1: Per-route connection analysis ─────────────────────────────────
  for (const route of routes) {
    const { flights } = route;

    if (flights.length <= 1) {
      // Nonstop — no connection fields
      route.connectionQuality     = undefined;
      route.minLayoverMinutes     = undefined;
      route.requiresAirportTransfer = false;
      route.warnings = buildEnrichedWarnings(flights, [], false, route.warnings);
      route.fragilityLabel = 'low';
      continue;
    }

    // Compute per-connection layover times
    const layovers: number[] = [];
    for (let i = 0; i < flights.length - 1; i++) {
      layovers.push(layoverMins(flights[i], flights[i + 1]));
    }

    const qualities        = layovers.map(classifyLayover);
    const connQuality      = worstQuality(qualities);
    const minLayover       = Math.min(...layovers);
    const requiresTransfer = flights.some((f, i) =>
      i > 0 && flights[i - 1].destination !== f.origin,
    );

    route.connectionQuality       = connQuality;
    route.minLayoverMinutes       = Math.round(minLayover);
    route.requiresAirportTransfer = requiresTransfer;
    route.fragilityLabel          = refineFragility(flights, connQuality, requiresTransfer);
    route.warnings                = buildEnrichedWarnings(flights, layovers, requiresTransfer, route.warnings);
  }

  // ── Phase 2: Re-derive scores (fragility may have changed) ─────────────────
  recomputeScores(routes, mode);

  // ── Phase 3: Re-sort by score ──────────────────────────────────────────────
  routes.sort((a, b) => b.score - a.score);

  // ── Phase 4: Re-assign labels and generate explanations ───────────────────
  reassignLabels(routes);
  for (const route of routes) {
    route.whyRankedHere = buildWhyRankedHere(route);
  }

  return routes;
}
