/**
 * Search-Space Control Layer — deterministic stress coverage
 *
 * Exercises all five components of the search-space control layer:
 *   A. Airport selection bounded output
 *   B. City-airport cluster detection and airport transfer cases
 *   C. Temporal connection constraint validation
 *   D. Bounded route expansion gate
 *   E. Dominance pruning
 *
 * HOW TO RUN
 * ----------
 * From the monorepo root:
 *
 *   pnpm build
 *   pnpm --filter @travel-ai/routing tsx scripts/search-space-control.ts
 *
 * Or after building, from the package directory:
 *
 *   tsx scripts/search-space-control.ts
 *
 * WHAT TO EXPECT
 * --------------
 * Deterministic pass/fail output for all cases.
 * No network I/O. All data is from static tables.
 */

import {
  selectAirports,
  checkExpansion,
  applyDominancePruning,
  AIRPORT_SELECTION_LIMITS,
  EXPANSION_LIMITS,
} from '../src/airport-selection.js';

import {
  isSameCluster,
  getAirportCluster,
  checkTemporalConnection,
  MCT_SAME_AIRPORT,
  MCT_AIRPORT_TRANSFER,
  MAX_LAYOVER_MINUTES,
  CITY_AIRPORT_CLUSTERS,
} from '../src/city-airports.js';

import type { RouteDimensions, ExpansionState } from '../src/airport-selection.js';

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
    failures.push(label);
  }
}

function section(title: string): void {
  console.log('');
  console.log('─'.repeat(60));
  console.log(title);
  console.log('─'.repeat(60));
}

// ─── A. Airport selection: bounded output ─────────────────────────────────────

section('A. Airport Selection — Bounded Output');

// GB → PL: UK airports → Polish airports
const gbPl = selectAirports('GB', 'PL');
assert(
  gbPl.originCandidates.length <= AIRPORT_SELECTION_LIMITS.maxOriginAirports,
  `GB origin candidates ≤ ${AIRPORT_SELECTION_LIMITS.maxOriginAirports} (got ${gbPl.originCandidates.length})`,
);
assert(
  gbPl.destinationCandidates.length <= AIRPORT_SELECTION_LIMITS.maxDestinationAirports,
  `PL destination candidates ≤ ${AIRPORT_SELECTION_LIMITS.maxDestinationAirports} (got ${gbPl.destinationCandidates.length})`,
);
assert(
  gbPl.airportPairs.length <= AIRPORT_SELECTION_LIMITS.maxAirportPairs,
  `GB→PL airport pairs ≤ ${AIRPORT_SELECTION_LIMITS.maxAirportPairs} (got ${gbPl.airportPairs.length})`,
);
assert(
  gbPl.originCandidates.every((c, i, arr) => i === 0 || arr[i - 1].score >= c.score),
  'GB origin candidates are sorted by score descending',
);
assert(
  gbPl.destinationCandidates.every((c, i, arr) => i === 0 || arr[i - 1].score >= c.score),
  'PL destination candidates are sorted by score descending',
);
assert(
  gbPl.airportPairs.every((p, i, arr) => i === 0 || arr[i - 1].pairScore >= p.pairScore),
  'Airport pairs are sorted by pairScore descending',
);
assert(
  gbPl.airportPairs.every(p => p.origin !== p.destination),
  'No self-pairs (origin ≠ destination) in airport pairs',
);

// Large country (US → DE): verify caps hold even when many airports are available
const usDe = selectAirports('US', 'DE');
assert(
  usDe.originCandidates.length <= AIRPORT_SELECTION_LIMITS.maxOriginAirports,
  `US origin candidates ≤ ${AIRPORT_SELECTION_LIMITS.maxOriginAirports} (got ${usDe.originCandidates.length})`,
);
assert(
  usDe.destinationCandidates.length <= AIRPORT_SELECTION_LIMITS.maxDestinationAirports,
  `DE destination candidates ≤ ${AIRPORT_SELECTION_LIMITS.maxDestinationAirports} (got ${usDe.destinationCandidates.length})`,
);
assert(
  usDe.airportPairs.length <= AIRPORT_SELECTION_LIMITS.maxAirportPairs,
  `US→DE airport pairs ≤ ${AIRPORT_SELECTION_LIMITS.maxAirportPairs} (got ${usDe.airportPairs.length})`,
);

// Hubs should rank at the top of large countries
const usTopOrigin = usDe.originCandidates[0];
assert(
  usTopOrigin !== undefined && usTopOrigin.isHub,
  `US top origin candidate is a hub (got ${usTopOrigin?.iata ?? 'none'})`,
);

// Unknown country: returns empty result, does not throw
const unknown = selectAirports('XX', 'YY');
assert(
  unknown.originCandidates.length === 0 &&
  unknown.destinationCandidates.length === 0 &&
  unknown.airportPairs.length === 0,
  'Unknown country codes produce empty result without throwing',
);

// Print the example bounded airport pair output for GB → PL
console.log('');
console.log('  Example: GB → PL airport selection');
console.log(`  Origin candidates (${gbPl.originCandidates.length}):`);
for (const c of gbPl.originCandidates) {
  console.log(`    ${c.iata}  score=${c.score.toFixed(3)}  hub=${c.isHub}  risk=${c.countryRisk.toFixed(2)}`);
}
console.log(`  Destination candidates (${gbPl.destinationCandidates.length}):`);
for (const c of gbPl.destinationCandidates) {
  console.log(`    ${c.iata}  score=${c.score.toFixed(3)}  hub=${c.isHub}  risk=${c.countryRisk.toFixed(2)}`);
}
console.log(`  Airport pairs (${gbPl.airportPairs.length}):`);
for (const p of gbPl.airportPairs) {
  console.log(`    ${p.origin} → ${p.destination}  pairScore=${p.pairScore.toFixed(3)}`);
}

// ─── B. City-airport clusters and airport transfer detection ──────────────────

section('B. City Airport Clusters — Transfer Detection');

// Verify all defined clusters
assert(CITY_AIRPORT_CLUSTERS.has('WAW'), 'Cluster WAW (Warsaw) defined');
assert(CITY_AIRPORT_CLUSTERS.has('MOW'), 'Cluster MOW (Moscow) defined');
assert(CITY_AIRPORT_CLUSTERS.has('LON'), 'Cluster LON (London) defined');
assert(CITY_AIRPORT_CLUSTERS.has('PAR'), 'Cluster PAR (Paris) defined');

// Warsaw cluster: WAW and WMI are in the same cluster
assert(isSameCluster('WAW', 'WMI'), 'WAW ↔ WMI are in the same cluster (Warsaw transfer)');
assert(isSameCluster('WMI', 'WAW'), 'WMI ↔ WAW symmetry holds');
assert(!isSameCluster('WAW', 'WAW'), 'Same airport is not a cluster transfer (WAW ↔ WAW)');

// Moscow cluster: SVO, DME, VKO
assert(isSameCluster('SVO', 'DME'), 'SVO ↔ DME (Moscow: Sheremetyevo ↔ Domodedovo)');
assert(isSameCluster('DME', 'VKO'), 'DME ↔ VKO (Moscow: Domodedovo ↔ Vnukovo)');
assert(isSameCluster('SVO', 'VKO'), 'SVO ↔ VKO (Moscow: Sheremetyevo ↔ Vnukovo)');

// London cluster: LHR, LGW, STN, LTN, LCY
assert(isSameCluster('LHR', 'LGW'), 'LHR ↔ LGW (London: Heathrow ↔ Gatwick)');
assert(isSameCluster('STN', 'LTN'), 'STN ↔ LTN (London: Stansted ↔ Luton)');
assert(isSameCluster('LCY', 'LHR'), 'LCY ↔ LHR (London City ↔ Heathrow)');

// Paris cluster: CDG, ORY
assert(isSameCluster('CDG', 'ORY'), 'CDG ↔ ORY (Paris: Charles de Gaulle ↔ Orly)');

// Cross-cluster: airports in different clusters are NOT the same cluster
assert(!isSameCluster('LHR', 'CDG'), 'LHR ↔ CDG are not in the same cluster (London vs Paris)');
assert(!isSameCluster('SVO', 'WAW'), 'SVO ↔ WAW are not in the same cluster (Moscow vs Warsaw)');

// Non-cluster airports
assert(!isSameCluster('JFK', 'LHR'), 'JFK ↔ LHR are not in any cluster');
assert(getAirportCluster('JFK') === undefined, 'JFK has no cluster (not in any defined metro)');
assert(getAirportCluster('LHR') === 'LON', 'LHR cluster is LON');
assert(getAirportCluster('CDG') === 'PAR', 'CDG cluster is PAR');
assert(getAirportCluster('SVO') === 'MOW', 'SVO cluster is MOW');
assert(getAirportCluster('WAW') === 'WAW', 'WAW cluster is WAW');
assert(getAirportCluster('WMI') === 'WAW', 'WMI cluster is WAW');

// ─── C. Temporal connection constraints ───────────────────────────────────────

section('C. Temporal Connection Constraints');

const BASE_DATE = '2026-03-20';
const ARR = (hhmm: string) => `${BASE_DATE}T${hhmm}:00Z`;

// Valid same-airport connection: 95 min (≥ MCT_SAME_AIRPORT = 90)
const valid90 = checkTemporalConnection(ARR('10:00'), ARR('11:35'), 'LHR', 'LHR');
assert(valid90.valid, `Valid same-airport connection (95 min ≥ MCT ${MCT_SAME_AIRPORT} min)`);
assert(!valid90.isAirportTransfer, 'Same airport: isAirportTransfer=false');
assert(valid90.minimumConnectionTime === MCT_SAME_AIRPORT, `MCT for same airport = ${MCT_SAME_AIRPORT} min`);

// Valid airport transfer: 185 min (≥ MCT_AIRPORT_TRANSFER = 180)
const validTransfer = checkTemporalConnection(ARR('10:00'), ARR('13:05'), 'LHR', 'LGW');
assert(validTransfer.valid, `Valid airport transfer (185 min ≥ MCT ${MCT_AIRPORT_TRANSFER} min)`);
assert(validTransfer.isAirportTransfer, 'LHR→LGW: isAirportTransfer=true');
assert(validTransfer.minimumConnectionTime === MCT_AIRPORT_TRANSFER, `MCT for airport transfer = ${MCT_AIRPORT_TRANSFER} min`);

// Invalid: negative layover (departure before arrival)
const negLayover = checkTemporalConnection(ARR('12:00'), ARR('11:00'), 'JFK', 'JFK');
assert(!negLayover.valid, 'Negative layover: rejected');
assert(negLayover.reason !== undefined && negLayover.reason.includes('Negative'), `Reason mentions "Negative" (got: "${negLayover.reason}")`);

// Invalid: zero layover (departure == arrival)
const zeroLayover = checkTemporalConnection(ARR('10:00'), ARR('10:00'), 'FRA', 'FRA');
assert(!zeroLayover.valid, 'Zero layover: rejected');

// Invalid: too short — same airport, 45 min (below MCT_SAME_AIRPORT = 90)
const tooShortSame = checkTemporalConnection(ARR('10:00'), ARR('10:45'), 'CDG', 'CDG');
assert(!tooShortSame.valid, `Too short same-airport layover (45 min < MCT ${MCT_SAME_AIRPORT} min): rejected`);
assert(tooShortSame.reason !== undefined && tooShortSame.reason.includes('MCT'), `Reason mentions MCT (got: "${tooShortSame.reason}")`);

// Invalid: too short — airport transfer, 90 min (below MCT_AIRPORT_TRANSFER = 180)
const tooShortTransfer = checkTemporalConnection(ARR('10:00'), ARR('11:30'), 'CDG', 'ORY');
assert(!tooShortTransfer.valid, `Too short airport transfer (90 min < MCT ${MCT_AIRPORT_TRANSFER} min): rejected`);
assert(tooShortTransfer.isAirportTransfer, 'CDG→ORY detected as airport transfer');

// Invalid: unrealistic layover > 24 hours
const tooLong = checkTemporalConnection(
  `${BASE_DATE}T10:00:00Z`,
  '2026-03-22T10:01:00Z',   // 48 h + 1 min
  'AMS', 'AMS',
);
assert(!tooLong.valid, `Unrealistic layover (> ${MAX_LAYOVER_MINUTES} min): rejected`);
assert(tooLong.reason !== undefined && tooLong.reason.includes('maximum'), `Reason mentions "maximum" (got: "${tooLong.reason}")`);

// Invalid: malformed arrival timestamp
const badArrival = checkTemporalConnection('not-a-date', ARR('12:00'), 'JFK', 'JFK');
assert(!badArrival.valid, 'Invalid arrival timestamp: rejected');
assert(badArrival.reason !== undefined && badArrival.reason.toLowerCase().includes('invalid'), `Reason mentions "Invalid" (got: "${badArrival.reason}")`);

// Invalid: malformed departure timestamp
const badDeparture = checkTemporalConnection(ARR('10:00'), 'XXXX', 'JFK', 'JFK');
assert(!badDeparture.valid, 'Invalid departure timestamp: rejected');

// Boundary: exactly at MCT_SAME_AIRPORT
const exactMctSame = checkTemporalConnection(ARR('10:00'), ARR('11:30'), 'FRA', 'FRA');
assert(exactMctSame.valid, `Exactly MCT_SAME_AIRPORT (${MCT_SAME_AIRPORT} min): accepted`);

// Boundary: exactly at MCT_AIRPORT_TRANSFER for MOW cluster (SVO→DME)
const exactMctTransfer = checkTemporalConnection(ARR('10:00'), ARR('13:00'), 'SVO', 'DME');
assert(exactMctTransfer.valid, `Exactly MCT_AIRPORT_TRANSFER (${MCT_AIRPORT_TRANSFER} min, MOW cluster): accepted`);
assert(exactMctTransfer.isAirportTransfer, 'SVO→DME detected as airport transfer');

// ─── D. Bounded route expansion ───────────────────────────────────────────────

section('D. Bounded Route Expansion');

// Base state: LHR → JFK, 12 h duration cap
const lhrMeta = { lat: 51.4775, lng: -0.4614 };  // LHR
const jfkMeta = { lat: 40.6413, lng: -73.7781 };  // JFK

const baseState: ExpansionState = {
  visitedAirports:         new Set(['LHR']),
  currentDurationMinutes:  0,
  originLat:               lhrMeta.lat,
  originLng:               lhrMeta.lng,
  destLat:                 jfkMeta.lat,
  destLng:                 jfkMeta.lng,
  maxTotalDurationMinutes: 12 * 60,  // 720 min
};

// Allowed: add CDG as first stop (0 stops so far, forward-aligned, within duration)
const cdgOk = checkExpansion('CDG', 120, 0, baseState);
assert(cdgOk.allowed, 'CDG as first stop: allowed (0 stops, on-route, within duration)');

// Rejected: stop limit reached
const stopLimit = checkExpansion('CDG', 120, EXPANSION_LIMITS.maxStops, baseState);
assert(!stopLimit.allowed, `Stop limit (${EXPANSION_LIMITS.maxStops} stops): expansion rejected`);
assert(stopLimit.reason !== undefined && stopLimit.reason.includes('Stop limit'), `Reason mentions "Stop limit" (got: "${stopLimit.reason}")`);

// Rejected: loop — LHR is already in visitedAirports
const loopCheck = checkExpansion('LHR', 300, 1, baseState);
assert(!loopCheck.allowed, 'Loop detected: LHR already visited, expansion rejected');
assert(loopCheck.reason !== undefined && loopCheck.reason.includes('Loop'), `Reason mentions "Loop" (got: "${loopCheck.reason}")`);

// Rejected: duration exceeded
const durationExceeded = checkExpansion('CDG', 721, 0, baseState);
assert(!durationExceeded.allowed, 'Duration cap exceeded: expansion rejected');
assert(durationExceeded.reason !== undefined && durationExceeded.reason.includes('duration'), `Reason mentions "duration" (got: "${durationExceeded.reason}")`);

// Rejected: excessive detour — SYD (Sydney) is far out of the way for LHR→JFK
const sydState: ExpansionState = {
  ...baseState,
  maxTotalDurationMinutes: 72 * 60,  // allow very long routes to isolate detour check
};
const sydDetour = checkExpansion('SYD', 600, 0, sydState);
assert(!sydDetour.allowed, 'SYD is an excessive detour for LHR→JFK: expansion rejected');
assert(sydDetour.reason !== undefined && sydDetour.reason.includes('Detour'), `Reason mentions "Detour" (got: "${sydDetour.reason}")`);

// Allowed: FRA is a reasonable mid-Atlantic stop for LHR→JFK
const fraOk = checkExpansion('FRA', 300, 0, baseState);
assert(fraOk.allowed, 'FRA as stop for LHR→JFK: allowed (on-route, within caps)');

// No-loop invariant: a route visiting multiple airports cannot revisit any
// Simulate: LHR → FRA → CDG, then attempt to revisit FRA
const multiState: ExpansionState = {
  ...baseState,
  visitedAirports: new Set(['LHR', 'FRA']),
  currentDurationMinutes: 180,
};
const revisitFra = checkExpansion('FRA', 360, 1, multiState);
assert(!revisitFra.allowed, 'No-loop invariant: FRA cannot be revisited after LHR→FRA→...');

// ─── E. Dominance pruning ─────────────────────────────────────────────────────

section('E. Dominance Pruning');

// Route A clearly dominates Route B on all dimensions
const routeA: RouteDimensions = {
  id: 'A',
  totalPrice: 500, totalDurationMinutes: 300,
  riskScore: 0.1, fragilityScore: 0.1, stops: 1,
  hasAirportTransfer: false, destinationCluster: undefined,
};
const routeB: RouteDimensions = {
  id: 'B',
  totalPrice: 800, totalDurationMinutes: 480,
  riskScore: 0.3, fragilityScore: 0.3, stops: 2,
  hasAirportTransfer: false, destinationCluster: undefined,
};
const pruned1 = applyDominancePruning([routeA, routeB]);
assert(pruned1.length === 1 && pruned1[0].id === 'A', 'A dominates B: B pruned, A survives');

// No dominance: routes incomparable (A cheaper, B faster)
const routeC: RouteDimensions = {
  id: 'C',
  totalPrice: 400, totalDurationMinutes: 600,
  riskScore: 0.2, fragilityScore: 0.2, stops: 2,
  hasAirportTransfer: false, destinationCluster: undefined,
};
const routeD: RouteDimensions = {
  id: 'D',
  totalPrice: 700, totalDurationMinutes: 200,
  riskScore: 0.2, fragilityScore: 0.2, stops: 1,
  hasAirportTransfer: false, destinationCluster: undefined,
};
const pruned2 = applyDominancePruning([routeC, routeD]);
assert(pruned2.length === 2, 'C and D are incomparable (C cheaper, D faster): both survive');

// Exemption: routes with different destination clusters are never pruned against each other
const routeE: RouteDimensions = {
  id: 'E',
  totalPrice: 500, totalDurationMinutes: 300,
  riskScore: 0.1, fragilityScore: 0.1, stops: 1,
  hasAirportTransfer: false, destinationCluster: 'LON',
};
const routeF: RouteDimensions = {
  id: 'F',
  totalPrice: 800, totalDurationMinutes: 400,
  riskScore: 0.2, fragilityScore: 0.2, stops: 2,
  hasAirportTransfer: false, destinationCluster: 'PAR',  // different cluster
};
const pruned3 = applyDominancePruning([routeE, routeF]);
assert(pruned3.length === 2, 'Routes E (LON) and F (PAR) exempt: different destination clusters, both survive');

// Exemption: routes with different airport transfer semantics are never pruned
const routeG: RouteDimensions = {
  id: 'G',
  totalPrice: 400, totalDurationMinutes: 300,
  riskScore: 0.1, fragilityScore: 0.1, stops: 1,
  hasAirportTransfer: false, destinationCluster: undefined,
};
const routeH: RouteDimensions = {
  id: 'H',
  totalPrice: 600, totalDurationMinutes: 400,
  riskScore: 0.2, fragilityScore: 0.2, stops: 2,
  hasAirportTransfer: true, destinationCluster: undefined,  // involves airport transfer
};
const pruned4 = applyDominancePruning([routeG, routeH]);
assert(pruned4.length === 2, 'Routes G and H exempt: different airport transfer semantics, both survive');

// Strict dominance: A weakly beats B in all dims but only equal on price — A dominates
const routeI: RouteDimensions = {
  id: 'I',
  totalPrice: 500, totalDurationMinutes: 300,
  riskScore: 0.1, fragilityScore: 0.1, stops: 1,
  hasAirportTransfer: false, destinationCluster: undefined,
};
const routeJ: RouteDimensions = {
  id: 'J',
  totalPrice: 500, totalDurationMinutes: 400,   // same price, longer duration
  riskScore: 0.1, fragilityScore: 0.1, stops: 1,
  hasAirportTransfer: false, destinationCluster: undefined,
};
const pruned5 = applyDominancePruning([routeI, routeJ]);
assert(pruned5.length === 1 && pruned5[0].id === 'I', 'I dominates J (same price but shorter): J pruned');

// Identical routes (all equal): neither dominates the other (strict condition not met)
const routeK: RouteDimensions = {
  id: 'K',
  totalPrice: 500, totalDurationMinutes: 300,
  riskScore: 0.1, fragilityScore: 0.1, stops: 1,
  hasAirportTransfer: false, destinationCluster: undefined,
};
const routeL: RouteDimensions = {
  id: 'L',
  totalPrice: 500, totalDurationMinutes: 300,  // identical
  riskScore: 0.1, fragilityScore: 0.1, stops: 1,
  hasAirportTransfer: false, destinationCluster: undefined,
};
const pruned6 = applyDominancePruning([routeK, routeL]);
assert(pruned6.length === 2, 'Identical routes K and L: neither dominates (strict condition), both survive');

// Multi-route: prune a batch, preserve non-dominated subset
const batch: RouteDimensions[] = [
  { id: 'r1', totalPrice: 300, totalDurationMinutes: 200, riskScore: 0.1, fragilityScore: 0.1, stops: 0, hasAirportTransfer: false, destinationCluster: undefined },
  { id: 'r2', totalPrice: 400, totalDurationMinutes: 300, riskScore: 0.2, fragilityScore: 0.2, stops: 1, hasAirportTransfer: false, destinationCluster: undefined },
  { id: 'r3', totalPrice: 600, totalDurationMinutes: 500, riskScore: 0.3, fragilityScore: 0.3, stops: 2, hasAirportTransfer: false, destinationCluster: undefined },
  { id: 'r4', totalPrice: 350, totalDurationMinutes: 250, riskScore: 0.1, fragilityScore: 0.1, stops: 1, hasAirportTransfer: false, destinationCluster: undefined },
];
// r1 dominates r2 (cheaper, faster, same risk/fragility, fewer stops)
// r1 dominates r3, r4
// r1 is the single non-dominated route
const pruned7 = applyDominancePruning(batch);
assert(pruned7.length === 1 && pruned7[0].id === 'r1', 'Batch: r1 dominates r2/r3/r4, only r1 survives');

// Empty input: no panic
const pruned8 = applyDominancePruning([]);
assert(pruned8.length === 0, 'Empty input: applyDominancePruning returns [] without throwing');

// ─── Final summary ────────────────────────────────────────────────────────────

console.log('');
console.log('═'.repeat(60));
console.log(`Search-Space Control Layer — results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('');
  console.log('Failed assertions:');
  for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log('═'.repeat(60));

if (failed > 0) process.exit(1);
