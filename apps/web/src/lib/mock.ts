/**
 * Mock routing search.
 *
 * Returns realistic SearchResult objects without hitting any external API.
 * Modelled after the sample-search.ts MockProviderAdapter output for LHR→JFK,
 * with a generic fallback for other origin/destination pairs.
 */

import type {
  SearchResult,
  Route,
  Flight,
  SearchMode,
  RouteWarning,
  BookingGroup,
} from '@travel-ai/types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let idSeq = 0;
function uid(prefix: string) { return `${prefix}-${++idSeq}`; }

function makeFlight(
  origin: string,
  destination: string,
  depTime: string,
  arrTime: string,
  carrier: string,
  flightNumber: string,
  date: string,
): Flight {
  const dep = `${date}T${depTime}:00Z`;
  const arr = `${date}T${arrTime}:00Z`;
  const depMs = new Date(dep).getTime();
  const arrMs = new Date(arr).getTime();
  return {
    id: uid('fl'),
    origin,
    destination,
    departingAt: dep,
    arrivingAt: arr,
    carrier,
    flightNumber,
    durationMinutes: Math.round((arrMs - depMs) / 60_000),
    cabinClass: 'economy',
  };
}

function warning(
  code: RouteWarning['code'],
  message: string,
  severity: RouteWarning['severity'],
): RouteWarning {
  return { code, message, severity };
}

// ─── LHR→JFK mock routes (matches sample-search.ts MockProviderAdapter) ──────

function makeLhrJfkRoutes(date: string, mode: SearchMode): Route[] {
  // Route 1: Direct LHR→JFK, BA178
  const direct: Route = {
    id: uid('route'),
    flights: [
      makeFlight('LHR', 'JFK', '09:00', '16:55', 'BA', '178', date),
    ],
    totalDurationMinutes: 475,
    totalPrice: 850,
    currency: 'USD',
    actualDepartureDate: date,
    dateDeltaDays: 0,
    source: 'provider',
    bookingMode: 'single_booking',
    budgetBand: 'balanced',
    fragilityLabel: 'low',
    score: mode === 'safest' ? 0.82 : 0.79,
    safeScore: 0.85,
    routeLabel: mode === 'safest' ? 'Safest option' : 'Best overall',
    summary: 'Direct flight on British Airways — reliable and straightforward.',
    warnings: [],
  };

  // Route 2: LHR→CDG→JFK via Paris (hub fallback)
  const cdgLeg1 = makeFlight('LHR', 'CDG', '08:00', '10:05', 'AF', '1581', date);
  const cdgLeg2 = makeFlight('CDG', 'JFK', '11:40', '19:05', 'AF', '006', date);
  const viaCdg: Route = {
    id: uid('route'),
    flights: [cdgLeg1, cdgLeg2],
    totalDurationMinutes: 605,
    totalPrice: 810,
    currency: 'USD',
    actualDepartureDate: date,
    dateDeltaDays: 0,
    source: 'fallback',
    bookingMode: 'separate_tickets',
    bookingGroups: [
      { id: uid('bg'), flightIds: [cdgLeg1.id] } as BookingGroup,
      { id: uid('bg'), flightIds: [cdgLeg2.id] } as BookingGroup,
    ],
    budgetBand: 'balanced',
    fragilityLabel: 'medium',
    score: mode === 'safest' ? 0.64 : 0.74,
    safeScore: 0.65,
    routeLabel: mode === 'safest' ? '' : 'Best value',
    summary: 'Via Paris CDG — competitive price, booked as two separate tickets.',
    warnings: [
      warning('ASSEMBLED_ROUTE',
        'This route is assembled from separate tickets. If the first flight is delayed, the airline is not obligated to rebook you on the second flight.',
        'warn',
      ),
    ],
  };

  // Route 3: LHR→ZRH→JFK via Zurich (hub fallback)
  const zrhLeg1 = makeFlight('LHR', 'ZRH', '07:00', '09:05', 'LX', '315', date);
  const zrhLeg2 = makeFlight('ZRH', 'JFK', '11:00', '19:00', 'LX', '23', date);
  const viaZrh: Route = {
    id: uid('route'),
    flights: [zrhLeg1, zrhLeg2],
    totalDurationMinutes: 720,
    totalPrice: 810,
    currency: 'USD',
    actualDepartureDate: date,
    dateDeltaDays: 0,
    source: 'fallback',
    bookingMode: 'separate_tickets',
    bookingGroups: [
      { id: uid('bg'), flightIds: [zrhLeg1.id] } as BookingGroup,
      { id: uid('bg'), flightIds: [zrhLeg2.id] } as BookingGroup,
    ],
    budgetBand: 'balanced',
    fragilityLabel: 'medium',
    score: mode === 'safest' ? 0.61 : 0.71,
    safeScore: 0.62,
    routeLabel: '',
    summary: 'Via Zurich ZRH — good alternative if CDG option is unavailable.',
    warnings: [
      warning('ASSEMBLED_ROUTE',
        'This route is assembled from separate tickets. If the first flight is delayed, the airline is not obligated to rebook you on the second flight.',
        'warn',
      ),
    ],
  };

  // Route 4: LHR→AMS→JFK via Amsterdam (hub fallback, cheapest)
  const amsLeg1 = makeFlight('LHR', 'AMS', '07:15', '09:25', 'KL', '1023', date);
  const amsLeg2 = makeFlight('AMS', 'JFK', '11:30', '19:20', 'KL', '641', date);
  const viaAms: Route = {
    id: uid('route'),
    flights: [amsLeg1, amsLeg2],
    totalDurationMinutes: 725,
    totalPrice: 765,
    currency: 'USD',
    actualDepartureDate: date,
    dateDeltaDays: 0,
    source: 'fallback',
    bookingMode: 'separate_tickets',
    bookingGroups: [
      { id: uid('bg'), flightIds: [amsLeg1.id] } as BookingGroup,
      { id: uid('bg'), flightIds: [amsLeg2.id] } as BookingGroup,
    ],
    budgetBand: 'cheapest',
    fragilityLabel: 'medium',
    score: mode === 'safest' ? 0.59 : 0.69,
    safeScore: 0.60,
    routeLabel: '',
    summary: 'Via Amsterdam AMS — cheapest available option, assembled from separate tickets.',
    warnings: [
      warning('ASSEMBLED_ROUTE',
        'This route is assembled from separate tickets. If the first flight is delayed, the airline is not obligated to rebook you on the second flight.',
        'warn',
      ),
    ],
  };

  const routes = [direct, viaCdg, viaZrh, viaAms];

  // Re-sort for safest mode (safeScore order)
  if (mode === 'safest') {
    routes.sort((a, b) => b.safeScore - a.safeScore);
  } else {
    routes.sort((a, b) => b.score - a.score);
  }

  return routes;
}

// ─── Generic mock routes for any other origin/destination ─────────────────────

function makeGenericRoutes(origin: string, destination: string, date: string, mode: SearchMode): Route[] {
  // Route A: direct
  const directFlight = makeFlight(origin, destination, '08:00', '14:30', 'AA', '100', date);
  const routeA: Route = {
    id: uid('route'),
    flights: [directFlight],
    totalDurationMinutes: 390,
    totalPrice: 620,
    currency: 'USD',
    actualDepartureDate: date,
    dateDeltaDays: 0,
    source: 'provider',
    bookingMode: 'single_booking',
    budgetBand: 'balanced',
    fragilityLabel: 'low',
    score: 0.77,
    safeScore: 0.80,
    routeLabel: 'Best overall',
    summary: `Direct flight from ${origin} to ${destination} — reliable and straightforward.`,
    warnings: [],
  };

  // Route B: one stop, cheaper
  const hubCode = 'FRA';
  const leg1 = makeFlight(origin, hubCode, '06:00', '10:00', 'LH', '200', date);
  const leg2 = makeFlight(hubCode, destination, '12:00', '17:30', 'LH', '201', date);
  const routeB: Route = {
    id: uid('route'),
    flights: [leg1, leg2],
    totalDurationMinutes: 690,
    totalPrice: 480,
    currency: 'USD',
    actualDepartureDate: date,
    dateDeltaDays: 0,
    source: 'fallback',
    bookingMode: 'separate_tickets',
    bookingGroups: [
      { id: uid('bg'), flightIds: [leg1.id] } as BookingGroup,
      { id: uid('bg'), flightIds: [leg2.id] } as BookingGroup,
    ],
    budgetBand: 'cheapest',
    fragilityLabel: 'medium',
    score: 0.68,
    safeScore: 0.65,
    routeLabel: 'Best value',
    summary: `Via Frankfurt FRA — lower price, booked as separate tickets.`,
    warnings: [
      warning('ASSEMBLED_ROUTE',
        'This route is assembled from separate tickets. Delays on the first flight may cause you to miss the second.',
        'warn',
      ),
    ],
  };

  const routes = [routeA, routeB];

  if (mode === 'safest') {
    routes.sort((a, b) => b.safeScore - a.safeScore);
  } else {
    routes.sort((a, b) => b.score - a.score);
  }

  return routes;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface MockSearchInput {
  origin: string;
  destination: string;
  departureDate: string;
  mode: SearchMode;
}

/**
 * Runs a mock search and returns a SearchResult.
 * Simulates a short network delay.
 * Returns pre-defined routes for LHR→JFK; generic routes for everything else.
 */
export async function mockSearch(input: MockSearchInput): Promise<SearchResult> {
  await new Promise(r => setTimeout(r, 600));

  const { origin, destination, departureDate, mode } = input;
  const isLhrJfk =
    origin.toUpperCase() === 'LHR' && destination.toUpperCase() === 'JFK';

  const routes = isLhrJfk
    ? makeLhrJfkRoutes(departureDate, mode)
    : makeGenericRoutes(origin.toUpperCase(), destination.toUpperCase(), departureDate, mode);

  return {
    params: {
      origin: origin.toUpperCase(),
      destination: destination.toUpperCase(),
      departureDate,
      passengers: 1,
      currency: 'USD',
    },
    routes,
    mode,
    generatedAt: new Date().toISOString(),
  };
}
