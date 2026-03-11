/**
 * Normalizes Amadeus FlightOffer responses into the app's internal SearchResult shape.
 *
 * This module is intentionally self-contained: it does not import from any
 * service (routing engine) to avoid cross-boundary coupling. Fragility, warnings,
 * scoring, and labeling are derived using simplified structural rules that mirror
 * the semantics of the full engine without requiring a TravelerProfile or the
 * routing pipeline.
 */

import type {
  SearchResult,
  SearchParams,
  SearchMode,
  Route,
  Flight,
  CabinClass,
  FragilityLabel,
  BudgetBand,
  RouteWarning,
} from '@travel-ai/types';
import type { AmadeusSearchResponse, AmadeusFlightOffer, AmadeusSegment } from './amadeus';

// ─── ISO 8601 duration parser ─────────────────────────────────────────────────

/**
 * Converts an ISO 8601 duration string (e.g. "PT7H55M") to minutes.
 * Returns 0 for empty or unrecognised strings.
 */
export function parseIsoDuration(str: string): number {
  if (!str) return 0;
  const match = str.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return 0;
  const hours   = parseInt(match[1] ?? '0', 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  return hours * 60 + minutes;
}

// ─── Cabin class mapping ──────────────────────────────────────────────────────

const CABIN_MAP: Record<string, CabinClass> = {
  ECONOMY:         'economy',
  PREMIUM_ECONOMY: 'premium_economy',
  BUSINESS:        'business',
  FIRST:           'first',
};

function normalizeCabin(raw: string | undefined): CabinClass {
  return CABIN_MAP[(raw ?? '').toUpperCase()] ?? 'economy';
}

// ─── Segment → Flight mapping ─────────────────────────────────────────────────

function segmentToFlight(
  segment:  AmadeusSegment,
  cabinRaw: string | undefined,
): Flight {
  // Deterministic ID: carrier + flight number + departure datetime digits
  const id = `${segment.carrierCode}${segment.number}@${segment.departure.at.replace(/[^0-9]/g, '')}`;

  return {
    id,
    origin:          segment.departure.iataCode,
    destination:     segment.arrival.iataCode,
    departingAt:     segment.departure.at,   // local airport time; no Z suffix
    arrivingAt:      segment.arrival.at,
    carrier:         segment.carrierCode,
    flightNumber:    segment.number,
    durationMinutes: parseIsoDuration(segment.duration),
    cabinClass:      normalizeCabin(cabinRaw),
  };
}

// ─── Fragility derivation ─────────────────────────────────────────────────────

/**
 * Structural fragility for provider-supplied offers.
 * Uses segment count and minimum layover time as the two key signals.
 * Aligns with label semantics of the full engine without importing service code.
 */
function deriveFragility(flights: Flight[]): FragilityLabel {
  if (flights.length === 1) return 'low';
  if (flights.length >= 3) return 'high';

  // 2-segment route: classify by minimum layover
  let minLayover = Infinity;
  for (let i = 0; i < flights.length - 1; i++) {
    const layover =
      (new Date(flights[i + 1].departingAt).getTime() - new Date(flights[i].arrivingAt).getTime())
      / 60_000;
    if (layover < minLayover) minLayover = layover;
  }

  if (minLayover < 90) return 'high';
  return 'medium';
}

// ─── Warnings derivation ──────────────────────────────────────────────────────

function deriveWarnings(flights: Flight[], totalDurationMinutes: number): RouteWarning[] {
  const warnings: RouteWarning[] = [];

  if (flights.length > 3) {
    warnings.push({
      code:     'MANY_SEGMENTS',
      message:  `This route has ${flights.length} flight segments. Each connection increases missed-connection risk.`,
      severity: 'warn',
    });
  }

  for (let i = 0; i < flights.length - 1; i++) {
    const layover =
      (new Date(flights[i + 1].departingAt).getTime() - new Date(flights[i].arrivingAt).getTime())
      / 60_000;

    if (layover < 90) {
      warnings.push({
        code:     'SHORT_CONNECTION',
        message:  `Only ${Math.round(layover)} min to connect at ${flights[i].destination}. Missed flight risk is elevated.`,
        severity: 'warn',
      });
    }
  }

  if (totalDurationMinutes > 1200) {
    warnings.push({
      code:     'LONG_TRAVEL_TIME',
      message:  'Total travel time exceeds 20 hours.',
      severity: 'info',
    });
  }

  return warnings;
}

// ─── Budget band derivation ───────────────────────────────────────────────────

/** Ratios mirror ROUTING_CONSTRAINTS budget band thresholds. */
function deriveBudgetBand(price: number, minPrice: number): BudgetBand {
  const ratio = minPrice > 0 ? price / minPrice : 1;
  if (ratio <= 1.05) return 'cheapest';
  if (ratio <= 1.25) return 'balanced';
  if (ratio <= 1.50) return 'flexible';
  return 'over';
}

// ─── Score derivation ─────────────────────────────────────────────────────────

interface ScoreInput {
  price:           number;
  durationMinutes: number;
  fragilityLabel:  FragilityLabel;
}

const FRAGILITY_PENALTY: Record<FragilityLabel, number> = {
  low:      0,
  medium:   0.15,
  high:     0.35,
  critical: 0.55,
};

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Simplified 3-factor scoring mirroring MODE_WEIGHTS from score.ts.
 * safeScore always uses safest weights regardless of active mode
 * (same convention as the engine — used only for label assignment).
 */
function deriveScores(
  offers: ScoreInput[],
  mode:   SearchMode,
): Array<{ score: number; safeScore: number }> {
  if (offers.length === 0) return [];

  const prices    = offers.map(o => o.price);
  const durations = offers.map(o => o.durationMinutes);
  const minPrice  = Math.min(...prices);
  const maxPrice  = Math.max(...prices);
  const minDur    = Math.min(...durations);
  const maxDur    = Math.max(...durations);

  return offers.map(o => {
    const priceG = maxPrice === minPrice ? 1 : 1 - (o.price - minPrice) / (maxPrice - minPrice);
    const durG   = maxDur   === minDur   ? 1 : 1 - (o.durationMinutes - minDur) / (maxDur - minDur);
    const fragG  = 1 - FRAGILITY_PENALTY[o.fragilityLabel];

    let score: number;
    switch (mode) {
      case 'best_value':    score = 0.45 * priceG + 0.15 * durG + 0.40 * fragG; break;
      case 'fastest_home':  score = 0.15 * priceG + 0.45 * durG + 0.40 * fragG; break;
      case 'safest':        score = 0.10 * priceG + 0.10 * durG + 0.80 * fragG; break;
      default:              score = 0.35 * priceG + 0.35 * durG + 0.30 * fragG;
    }

    const safeScore = 0.20 * priceG + 0.20 * durG + 0.60 * fragG;
    return { score: clamp(score), safeScore: clamp(safeScore) };
  });
}

// ─── Label assignment ─────────────────────────────────────────────────────────

/**
 * Mirrors assignRouteLabels() from services/routing/src/score.ts.
 * Priority: Best overall → Best value → Safest option → Fastest option.
 * One label per route; first winner cannot be re-labeled.
 */
function assignLabels(routes: Route[]): void {
  for (const r of routes) r.routeLabel = '';

  const byScore    = [...routes].sort((a, b) => b.score              - a.score);
  const byPrice    = [...routes].sort((a, b) => a.totalPrice         - b.totalPrice);
  const bySafe     = [...routes].sort((a, b) => b.safeScore          - a.safeScore);
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

// ─── Summary builder ──────────────────────────────────────────────────────────

/** Mirrors buildSummary() from services/routing/src/score.ts. */
function buildSummary(route: Route, mode: SearchMode): string {
  const stops   = route.flights.length - 1;
  const stopStr = stops === 0 ? 'Nonstop' : `${stops} stop${stops > 1 ? 's' : ''}`;

  switch (mode) {
    case 'safest':
      return `${stopStr} · reliability: ${route.fragilityLabel}.`;
    case 'best_value':
      return `${stopStr} · ${route.currency} ${route.totalPrice.toLocaleString()}.`;
    case 'fastest_home': {
      const h = Math.round(route.totalDurationMinutes / 60);
      return `${stopStr} · ${h}h total.`;
    }
    default:
      return `${stopStr} · departing ${route.actualDepartureDate}.`;
  }
}

// ─── Offer shell builder ──────────────────────────────────────────────────────

interface OfferShell {
  offerId:              string;
  flights:              Flight[];
  totalPrice:           number;
  currency:             string;
  totalDurationMinutes: number;
}

function buildOfferShell(offer: AmadeusFlightOffer): OfferShell | null {
  // One-way searches always have exactly one itinerary
  const itinerary = offer.itineraries[0];
  if (!itinerary || itinerary.segments.length === 0) return null;

  const fareDetails = offer.travelerPricings?.[0]?.fareDetailsBySegment ?? [];
  const flights = itinerary.segments.map((seg, i) =>
    segmentToFlight(seg, fareDetails[i]?.cabin),
  );

  const rawPrice = parseFloat(offer.price.grandTotal ?? offer.price.total);
  if (!isFinite(rawPrice) || rawPrice <= 0) return null;

  return {
    offerId:              offer.id,
    flights,
    totalPrice:           rawPrice,
    currency:             offer.price.currency,
    totalDurationMinutes: parseIsoDuration(itinerary.duration),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Converts an Amadeus FlightOffers response into the app's internal SearchResult.
 *
 * All ranking signals (fragility, warnings, score, labels) are derived from the
 * structural properties of each offer; no TravelerProfile or routing engine is needed.
 */
export function normalizeAmadeusResponse(
  response: AmadeusSearchResponse,
  params:   SearchParams,
  mode:     SearchMode,
): SearchResult {
  const generatedAt = new Date().toISOString();

  if (!response.data || response.data.length === 0) {
    return { params, routes: [], mode, generatedAt };
  }

  // Build offer shells
  const shells: OfferShell[] = [];
  for (const offer of response.data) {
    const shell = buildOfferShell(offer);
    if (shell) shells.push(shell);
  }

  if (shells.length === 0) {
    return { params, routes: [], mode, generatedAt };
  }

  const minPrice = Math.min(...shells.map(s => s.totalPrice));

  // Derive per-offer structural signals
  const fragilityLabels = shells.map(s => deriveFragility(s.flights));
  const scoreInputs     = shells.map((s, i) => ({
    price:           s.totalPrice,
    durationMinutes: s.totalDurationMinutes,
    fragilityLabel:  fragilityLabels[i],
  }));
  const scores = deriveScores(scoreInputs, mode);

  // Assemble Route objects
  const routes: Route[] = shells.map((s, i): Route => ({
    id:                   s.offerId,
    flights:              s.flights,
    totalDurationMinutes: s.totalDurationMinutes,
    totalPrice:           s.totalPrice,
    currency:             s.currency,
    actualDepartureDate:  params.departureDate,
    dateDeltaDays:        0,
    source:               'provider',
    bookingMode:          'single_booking',
    budgetBand:           deriveBudgetBand(s.totalPrice, minPrice),
    fragilityLabel:       fragilityLabels[i],
    score:                scores[i].score,
    safeScore:            scores[i].safeScore,
    routeLabel:           '',   // filled by assignLabels
    summary:              '',   // filled below
    warnings:             deriveWarnings(s.flights, s.totalDurationMinutes),
  }));

  assignLabels(routes);
  for (const r of routes) r.summary = buildSummary(r, mode);

  // Sort by score descending (engine convention)
  routes.sort((a, b) => b.score - a.score);

  return { params, routes, mode, generatedAt };
}
