/**
 * Minimal end-to-end harness for the routing engine.
 *
 * Uses a MockProviderAdapter (no network I/O) to exercise the full pipeline
 * with a realistic LHR → JFK search, including hub-based fallback routing.
 *
 * HOW TO RUN
 * ----------
 * From the monorepo root (first time, or after package changes):
 *
 *   pnpm build                              # compile workspace packages
 *   pnpm --filter @travel-ai/routing sample-search
 *
 * Subsequent runs (workspace packages unchanged):
 *
 *   pnpm --filter @travel-ai/routing sample-search
 *
 * WHAT TO EXPECT
 * --------------
 * The mock adapter provides:
 *   - 1 direct offer: LHR → JFK (BA178, $850)
 *   - Leg offers for hub routes via CDG, ZRH, and AMS
 *   - Empty results for SIN/DXB/DOH (those hub routes exceed the traveler's 24h limit)
 *
 * Provider dedup leaves 1 provider route → fallback triggers → 3 hub routes assembled.
 * Final result: 4 routes (1 provider + 3 fallback), scored and ranked.
 *
 * Two runtime sanity checks run after the result is produced:
 *   #1 Route ordering: routes must be sorted by score descending.
 *   #2 Airport loops: no route may visit the same airport more than once.
 */

import { search }                                                from '../src/engine.js';
import type { SearchRequest, SearchResult }                      from '@travel-ai/types';
import type { ProviderAdapter, FetchOffersParams, ProviderOffer } from '../src/provider.js';

// ─── Mock adapter ─────────────────────────────────────────────────────────────
//
// Schedule-based: returns exactly one realistic offer for known route pairs,
// and an empty array for anything else. Connection times are chosen so that
// the hub layovers satisfy isValidConnection's 45-minute minimum.
//
// The engine's scheduler, cache, date-window expansion, dedup, and fallback
// logic are all exercised normally — only the provider I/O is replaced.

class MockProviderAdapter implements ProviderAdapter {
  /**
   * Fixed schedule for the LHR → JFK sample route and its hub legs.
   * Hubs with long transit times (SIN, DXB, DOH) are intentionally omitted:
   * those routes would fail the traveler's maxTotalDurationHours=24 constraint,
   * demonstrating the feasibility filter in action.
   */
  private static readonly SCHEDULE: Record<
    string,
    { dep: string; arr: string; dur: number; carrier: string; fn: string; price: number }
  > = {
    // ── Direct route ─────────────────────────────────────────────────────────
    'LHR-JFK': { dep: '09:00', arr: '16:55', dur: 475, carrier: 'BA', fn: '178',  price: 850 },

    // ── Hub: CDG  (ranked #1 by inter-regional boost for europe→north_america) ─
    'LHR-CDG': { dep: '08:00', arr: '10:05', dur: 65,  carrier: 'AF', fn: '1581', price: 130 },
    'CDG-JFK': { dep: '11:40', arr: '19:05', dur: 445, carrier: 'AF', fn: '006',  price: 680 },

    // ── Hub: ZRH  (ranked #3 by stability score) ──────────────────────────────
    'LHR-ZRH': { dep: '07:00', arr: '09:05', dur: 65,  carrier: 'LX', fn: '315',  price: 165 },
    'ZRH-JFK': { dep: '11:00', arr: '19:00', dur: 480, carrier: 'LX', fn: '23',   price: 645 },

    // ── Hub: AMS  (ranked #4 by stability score, added in fallback phase 2) ───
    'LHR-AMS': { dep: '07:15', arr: '09:25', dur: 70,  carrier: 'KL', fn: '1023', price: 150 },
    'AMS-JFK': { dep: '11:30', arr: '19:20', dur: 470, carrier: 'KL', fn: '641',  price: 615 },
  };

  async fetchOffers(params: FetchOffersParams): Promise<ProviderOffer[]> {
    const key = `${params.origin}-${params.destination}`;
    const s   = MockProviderAdapter.SCHEDULE[key];
    if (!s) return []; // unknown route — fallback hub leg returns empty

    const d = params.date; // YYYY-MM-DD
    return [
      {
        flights: [
          {
            id:              `${s.carrier}${s.fn}-${d}`,
            origin:          params.origin,
            destination:     params.destination,
            departingAt:     `${d}T${s.dep}:00Z`,
            arrivingAt:      `${d}T${s.arr}:00Z`,
            carrier:         s.carrier,
            flightNumber:    s.fn,
            durationMinutes: s.dur,
            cabinClass:      'economy',
          },
        ],
        totalPrice: s.price,
        currency:   params.currency,
      },
    ];
  }
}

// ─── Sample request ───────────────────────────────────────────────────────────
//
// GB passport, $2000 budget, 24h duration limit (routes via SIN/DXB exceed this),
// separate tickets allowed (fallback routes require them).

const SAMPLE_REQUEST: SearchRequest = {
  params: {
    origin:        'LHR',
    destination:   'JFK',
    departureDate: '2026-03-20', // 11 days from 2026-03-09 — within ±3-day window
    passengers:    1,
    currency:      'USD',
  },
  traveler: {
    passportCountry:        'GB',
    blockedCountries:       [],
    maxBudget:              2000,
    maxTotalDurationHours:  24,
    willingSeparateTickets: true,
    allowAirportTransfers:  false, // no ground transfers; detects separate-airport connections
  },
  mode: 'best_overall',
};

// ─── Output formatter ─────────────────────────────────────────────────────────

function printResult(result: SearchResult): void {
  const hr = '─'.repeat(60);
  console.log(hr);
  console.log('SearchResult');
  console.log(hr);
  console.log(`mode:        ${result.mode}`);
  console.log(`generatedAt: ${result.generatedAt}`);
  console.log(`routes:      ${result.routes.length}`);

  if (result.errors && result.errors.length > 0) {
    console.log(`errors:      ${result.errors.map(e => `${e.code}`).join(', ')}`);
  }

  console.log('');

  for (const [i, route] of result.routes.entries()) {
    const legs = route.flights.map(f => `${f.origin}→${f.destination}`).join(' + ');
    const hrs  = Math.floor(route.totalDurationMinutes / 60);
    const mins = route.totalDurationMinutes % 60;

    console.log(`[${i + 1}] ${legs}`);
    console.log(`    source:    ${route.source} (${route.bookingMode})`);
    console.log(`    price:     ${route.currency} ${route.totalPrice}  band: ${route.budgetBand}`);
    console.log(`    duration:  ${hrs}h ${mins}m`);
    console.log(`    fragility: ${route.fragilityLabel}  score: ${route.score.toFixed(3)}`);
    console.log(`    label:     "${route.routeLabel || ''}"`);
    console.log(`    summary:   ${route.summary}`);

    if (route.warnings.length > 0) {
      for (const w of route.warnings) {
        console.log(`    ⚠ ${w.code} (${w.severity}): ${w.message}`);
      }
    }

    if (route.bookingGroups && route.bookingGroups.length > 0) {
      for (const bg of route.bookingGroups) {
        console.log(`    booking:   ${bg.id} flights=[${bg.flightIds.join(', ')}]`);
      }
    }

    console.log('');
  }
}

// ─── Sanity checks ────────────────────────────────────────────────────────────
//
// These checks run after the result is produced. They print warnings if
// invariants are violated, but do not throw — execution continues regardless.

function runSanityChecks(result: SearchResult): void {
  let passed = 0;
  let failed = 0;

  // ── Check #1: route ordering ─────────────────────────────────────────────────
  // Routes must be sorted by score descending (engine invariant).
  let orderingOk = true;
  for (let i = 0; i < result.routes.length - 1; i++) {
    const a = result.routes[i];
    const b = result.routes[i + 1];
    if (a.score < b.score) {
      console.warn(
        `⚠ Route ordering error: route ${i + 1} score ${a.score.toFixed(3)} < ` +
        `route ${i + 2} score ${b.score.toFixed(3)}`,
      );
      orderingOk = false;
      failed++;
    }
  }
  if (orderingOk) {
    console.log(`  ✓ Route ordering: ${result.routes.length} routes sorted correctly by score`);
    passed++;
  }

  // ── Check #2: airport loop protection ────────────────────────────────────────
  // No route may visit the same airport more than once. The sequence is:
  // all flight origins + the final flight's destination. This matches the
  // loop detection in assembleFallbackRoute (which only flags true routing
  // loops — same-airport layovers appear as the same IATA code in both
  // [flight.origin] and [prevFlight.destination], but the sequence includes
  // each origin once and then the final destination).
  let loopsFound = 0;
  for (const route of result.routes) {
    const sequence: string[] = route.flights.map(f => f.origin);
    const lastFlight = route.flights[route.flights.length - 1];
    if (lastFlight) sequence.push(lastFlight.destination);

    const unique = new Set(sequence);
    if (unique.size < sequence.length) {
      const repeated = sequence.filter((a, idx) => sequence.indexOf(a) !== idx);
      console.warn(
        `⚠ Route loop detected in ${route.id}: airport(s) [${[...new Set(repeated)].join(', ')}] ` +
        `appear more than once in the route sequence`,
      );
      loopsFound++;
      failed++;
    }
  }
  if (loopsFound === 0) {
    console.log(`  ✓ Airport loops: no loops detected across ${result.routes.length} routes`);
    passed++;
  }

  console.log(`\nSanity checks: ${passed} passed, ${failed} failed`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const adapter = new MockProviderAdapter();
  const { params, mode } = SAMPLE_REQUEST;

  console.log('Travel AI — routing engine sample search');
  console.log('─'.repeat(60));
  console.log(`Route:   ${params.origin} → ${params.destination}`);
  console.log(`Date:    ${params.departureDate}  (±3-day flex window)`);
  console.log(`Mode:    ${mode}`);
  console.log(`Adapter: MockProviderAdapter  (schedule-based, no network I/O)`);
  console.log('');

  const result = await search(SAMPLE_REQUEST, adapter);
  printResult(result);

  console.log('─'.repeat(60));
  console.log('Sanity checks');
  console.log('─'.repeat(60));
  runSanityChecks(result);
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
