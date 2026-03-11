/**
 * Connection feasibility tests.
 *
 * Covers:
 *   - safe same-airport connection
 *   - risky short connection (same-airport, between min and risky threshold)
 *   - impossible connection (below min)
 *   - airport-change connection (different airports, same metro)
 *   - overnight but valid layover
 *   - long layover (above max_reasonable)
 *   - checkFeasibility blocking routes with impossible connections
 *   - risky connections propagate to riskyConnectionCount
 *
 * Run: tsx services/routing/src/__tests__/connection-feasibility.test.ts
 */

import assert from 'node:assert/strict';
import { assessConnection, checkFeasibility, DEFAULT_CONNECTION_CONFIG } from '../feasibility.js';
import { generateWarnings } from '../warnings.js';
import type { Flight, Route, TravelerProfile } from '@travel-ai/types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let flightIdSeq = 0;

function makeFlight(
  origin: string,
  destination: string,
  departingAt: string,
  arrivingAt: string,
): Flight {
  return {
    id:              `f${++flightIdSeq}`,
    origin,
    destination,
    departingAt,
    arrivingAt,
    carrier:         'BA',
    flightNumber:    `${flightIdSeq}`,
    durationMinutes: Math.round(
      (new Date(arrivingAt).getTime() - new Date(departingAt).getTime()) / 60_000,
    ),
    cabinClass: 'economy',
  };
}

function makeRoute(flights: Flight[]): Route {
  return {
    id:                   `route-${Math.random().toString(36).slice(2)}`,
    flights,
    totalDurationMinutes: 0,
    totalPrice:           500,
    currency:             'USD',
    actualDepartureDate:  '2026-06-01',
    dateDeltaDays:        0,
    source:               'provider',
    bookingMode:          'single_booking',
    budgetBand:           'balanced',
    fragilityLabel:       'low',
    score:                0,
    safeScore:            0,
    routeLabel:           '',
    summary:              '',
    warnings:             [],
  };
}

const TRAVELER: TravelerProfile = {
  passportCountry:        'GB',
  willingSeparateTickets: true,
  allowAirportTransfers:  true,
};

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

// ─── assessConnection tests ───────────────────────────────────────────────────

console.log('\nassessConnection()');

test('safe same-airport connection (120 min)', () => {
  const inbound  = makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z');
  const outbound = makeFlight('LHR', 'CDG', '2026-06-01T22:00Z', '2026-06-02T00:00Z');
  const result = assessConnection(inbound, outbound);
  assert.equal(result.assessment, 'feasible');
  assert.equal(result.sameAirport, true);
  assert.ok(result.layoverMinutes >= 120);
});

test('risky short connection — same airport, 60 min (≥45, <90)', () => {
  const inbound  = makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z');
  const outbound = makeFlight('LHR', 'CDG', '2026-06-01T21:00Z', '2026-06-01T23:30Z');
  const result = assessConnection(inbound, outbound);
  assert.equal(result.assessment, 'risky');
  assert.ok(result.layoverMinutes >= 45 && result.layoverMinutes < 90);
});

test('impossible connection — same airport, 30 min (<45)', () => {
  const inbound  = makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z');
  const outbound = makeFlight('LHR', 'CDG', '2026-06-01T20:30Z', '2026-06-01T22:00Z');
  const result = assessConnection(inbound, outbound);
  assert.equal(result.assessment, 'impossible');
  assert.ok(result.layoverMinutes < 45);
});

test('airport-change connection — LHR→LGW (same metro), 120 min → risky (<150)', () => {
  // LHR and LGW are both in LON (CITY_AIRPORTS)
  const inbound  = makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T14:00Z');
  const outbound = makeFlight('LGW', 'CDG', '2026-06-01T16:00Z', '2026-06-01T18:00Z');
  const result = assessConnection(inbound, outbound);
  assert.equal(result.sameAirport, false);
  assert.equal(result.airportChange, true);
  assert.equal(result.assessment, 'risky');  // 120 min < airport_change_risky_threshold (150)
});

test('airport-change connection — LHR→LGW, 180 min → feasible (≥150, <1440)', () => {
  const inbound  = makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T14:00Z');
  const outbound = makeFlight('LGW', 'CDG', '2026-06-01T17:00Z', '2026-06-01T19:00Z');
  const result = assessConnection(inbound, outbound);
  assert.equal(result.assessment, 'feasible');
});

test('airport-change connection — LHR→LGW, 60 min → impossible (<90)', () => {
  const inbound  = makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T14:00Z');
  const outbound = makeFlight('LGW', 'CDG', '2026-06-01T15:00Z', '2026-06-01T17:00Z');
  const result = assessConnection(inbound, outbound);
  assert.equal(result.assessment, 'impossible');
});

test('overnight but valid layover — 10 hours (600 min) → feasible', () => {
  const inbound  = makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z');
  const outbound = makeFlight('LHR', 'CDG', '2026-06-02T06:00Z', '2026-06-02T08:00Z');
  const result = assessConnection(inbound, outbound);
  assert.equal(result.assessment, 'feasible');
  assert.ok(result.layoverMinutes >= 600);
});

test('long layover — 26 hours (1560 min) → risky (>max_reasonable=1440)', () => {
  const inbound  = makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z');
  const outbound = makeFlight('LHR', 'CDG', '2026-06-03T06:00Z', '2026-06-03T08:00Z');
  const result = assessConnection(inbound, outbound);
  assert.equal(result.assessment, 'risky');
  assert.ok(result.layoverMinutes > DEFAULT_CONNECTION_CONFIG.max_reasonable_layover_minutes);
});

// ─── checkFeasibility integration tests ──────────────────────────────────────

console.log('\ncheckFeasibility() — connection integration');

test('route with impossible connection is blocked', () => {
  const route = makeRoute([
    makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z'),
    makeFlight('LHR', 'CDG', '2026-06-01T20:20Z', '2026-06-01T22:00Z'), // 20 min — impossible
  ]);
  const result = checkFeasibility(route, TRAVELER, 'best_overall');
  assert.equal(result.status, 'blocked');
  assert.ok(result.violations.some(v => v.constraint === 'IMPOSSIBLE_CONNECTION'));
});

test('route with risky connection is feasible and carries riskyConnectionCount', () => {
  const route = makeRoute([
    makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z'),
    makeFlight('LHR', 'CDG', '2026-06-01T21:00Z', '2026-06-01T23:00Z'), // 60 min — risky
  ]);
  const result = checkFeasibility(route, TRAVELER, 'best_overall');
  assert.equal(result.status, 'feasible');
  assert.equal(result.riskyConnectionCount, 1);
});

test('route with safe connection has riskyConnectionCount = 0', () => {
  const route = makeRoute([
    makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z'),
    makeFlight('LHR', 'CDG', '2026-06-01T22:00Z', '2026-06-02T00:00Z'), // 120 min — feasible
  ]);
  const result = checkFeasibility(route, TRAVELER, 'best_overall');
  assert.equal(result.status, 'feasible');
  assert.equal(result.riskyConnectionCount, 0);
});

test('fallback separate-ticket route with risky connection: feasible with elevated risk signals', () => {
  // Simulates a short-connection assembled route where the traveler accepts separate tickets.
  const route = makeRoute([
    makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z'),
    makeFlight('LHR', 'CDG', '2026-06-01T21:10Z', '2026-06-01T23:00Z'), // 70 min — risky
  ]);
  route.bookingMode  = 'separate_tickets';
  route.source       = 'fallback';
  route.bookingGroups = [
    { id: 'bg1', flightIds: [route.flights[0].id] },
    { id: 'bg2', flightIds: [route.flights[1].id] },
  ];

  const feasibility = checkFeasibility(route, TRAVELER, 'best_overall');
  assert.equal(feasibility.status, 'feasible');
  assert.equal(feasibility.riskyConnectionCount, 1);

  route.warnings = generateWarnings(route);
  assert.ok(route.warnings.some(w => w.code === 'ASSEMBLED_ROUTE'), 'should warn about separate tickets');
  assert.ok(route.warnings.some(w => w.code === 'SHORT_CONNECTION'), 'should warn about tight connection');
});

// ─── generateWarnings tests ───────────────────────────────────────────────────

console.log('\ngenerateWarnings() — connection warnings');

test('SHORT_CONNECTION emitted for risky same-airport connection (60 min)', () => {
  const route = makeRoute([
    makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z'),
    makeFlight('LHR', 'CDG', '2026-06-01T21:00Z', '2026-06-01T23:00Z'),
  ]);
  route.warnings = generateWarnings(route);
  assert.ok(route.warnings.some(w => w.code === 'SHORT_CONNECTION'));
  assert.ok(!route.warnings.some(w => w.code === 'UNREALISTIC_CONNECTION'));
});

test('UNREALISTIC_CONNECTION emitted for impossible same-airport connection (30 min)', () => {
  const route = makeRoute([
    makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z'),
    makeFlight('LHR', 'CDG', '2026-06-01T20:30Z', '2026-06-01T22:00Z'),
  ]);
  route.warnings = generateWarnings(route);
  assert.ok(route.warnings.some(w => w.code === 'UNREALISTIC_CONNECTION'));
});

test('LONG_LAYOVER emitted for 26-hour layover', () => {
  const route = makeRoute([
    makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z'),
    makeFlight('LHR', 'CDG', '2026-06-03T06:00Z', '2026-06-03T08:00Z'),
  ]);
  route.warnings = generateWarnings(route);
  assert.ok(route.warnings.some(w => w.code === 'LONG_LAYOVER'));
});

test('airport-change connection emits AIRPORT_TRANSFER_REQUIRED + SHORT_CONNECTION', () => {
  // LHR → LGW is an airport change (both London); 120 min is risky (<150)
  const route = makeRoute([
    makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T14:00Z'),
    makeFlight('LGW', 'CDG', '2026-06-01T16:00Z', '2026-06-01T18:00Z'),
  ]);
  route.warnings = generateWarnings(route);
  assert.ok(route.warnings.some(w => w.code === 'AIRPORT_TRANSFER_REQUIRED'));
  assert.ok(route.warnings.some(w => w.code === 'SHORT_CONNECTION'));
});

test('safe same-airport connection emits no connection warnings', () => {
  const route = makeRoute([
    makeFlight('JFK', 'LHR', '2026-06-01T08:00Z', '2026-06-01T20:00Z'),
    makeFlight('LHR', 'CDG', '2026-06-01T22:00Z', '2026-06-02T00:00Z'), // 120 min
  ]);
  route.warnings = generateWarnings(route);
  const connectionWarnings = route.warnings.filter(
    w => ['SHORT_CONNECTION', 'LONG_LAYOVER', 'UNREALISTIC_CONNECTION', 'AIRPORT_TRANSFER_REQUIRED'].includes(w.code),
  );
  assert.equal(connectionWarnings.length, 0);
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
