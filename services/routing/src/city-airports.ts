// ─── City Airport Clusters — Search-Space Control Layer ───────────────────────
//
// Metro-area airport clusters used by the search-space control layer to:
//   - detect inter-airport ground transfers within the same metro area
//   - apply the correct minimum connection time (MCT) per connection type
//   - generate transfer warnings when two legs cross cluster boundaries
//
// This module is intentionally separate from CITY_AIRPORTS in @travel-ai/types,
// which serves the feasibility layer. Keeping them decoupled allows each layer
// to evolve its cluster definitions independently.

// ─── Minimum connection times (minutes) ──────────────────────────────────────

/** Minimum layover when both legs use the same airport IATA code. */
export const MCT_SAME_AIRPORT = 90;

/**
 * Minimum layover when successive legs arrive at and depart from different
 * airports in the same metro cluster. Covers deplaning, ground transfer,
 * and security re-entry.
 */
export const MCT_AIRPORT_TRANSFER = 180;

/** Maximum realistic layover. Beyond this the connection is not valid. */
export const MAX_LAYOVER_MINUTES = 24 * 60;

// ─── Cluster definitions ──────────────────────────────────────────────────────

/**
 * Maps a metro city code to the set of IATA airport codes that serve it.
 *
 * Covered metros:
 *   WAW — Warsaw    (WAW = Chopin, WMI = Modlin)
 *   MOW — Moscow    (SVO = Sheremetyevo, DME = Domodedovo, VKO = Vnukovo)
 *   LON — London    (LHR, LGW, STN, LTN, LCY)
 *   PAR — Paris     (CDG = Charles de Gaulle, ORY = Orly)
 */
export const CITY_AIRPORT_CLUSTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['WAW', new Set(['WAW', 'WMI'])],
  ['MOW', new Set(['SVO', 'DME', 'VKO'])],
  ['LON', new Set(['LHR', 'LGW', 'STN', 'LTN', 'LCY'])],
  ['PAR', new Set(['CDG', 'ORY'])],
]);

// ─── Reverse lookup (computed once at load time) ──────────────────────────────

/** IATA code → metro city code. Built once from CITY_AIRPORT_CLUSTERS. */
const AIRPORT_TO_CLUSTER: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const [city, airports] of CITY_AIRPORT_CLUSTERS) {
    for (const iata of airports) map.set(iata, city);
  }
  return map;
})();

// ─── Public helpers ───────────────────────────────────────────────────────────

/**
 * Returns the metro city code for an airport, or undefined if it does not
 * belong to any known cluster.
 */
export function getAirportCluster(iata: string): string | undefined {
  return AIRPORT_TO_CLUSTER.get(iata);
}

/**
 * Returns true when airports `a` and `b` are different IATA codes that belong
 * to the same metro cluster — indicating an airport transfer is required.
 *
 * Same-airport connections (identical IATA codes) return false — they are
 * regular layovers, not ground transfers.
 */
export function isSameCluster(a: string, b: string): boolean {
  if (a === b) return false;
  const ca = AIRPORT_TO_CLUSTER.get(a);
  const cb = AIRPORT_TO_CLUSTER.get(b);
  return ca !== undefined && ca === cb;
}

// ─── Temporal connection check ────────────────────────────────────────────────

/**
 * Result of a temporal feasibility check for a single connection.
 *
 * valid = false when any of the following are detected:
 *   - Invalid (NaN) timestamps
 *   - Negative or zero layover (departure ≤ arrival)
 *   - Layover below MCT (too short to make the connection)
 *   - Layover above MAX_LAYOVER_MINUTES (unrealistic connection)
 */
export interface TemporalCheckResult {
  valid: boolean;
  reason?: string;
  layoverMinutes?: number;
  isAirportTransfer: boolean;
  minimumConnectionTime: number;
}

/**
 * Checks whether a connection between two legs is temporally feasible.
 *
 * A connection is valid only when:
 *   arrival_time + minimum_connection_time <= departure_time
 *
 * MCT depends on the connection type:
 *   same airport  (arrivalAirport === departureAirport):             90 min
 *   airport transfer (different airports in the same metro cluster): 180 min
 *
 * Rejection conditions (in priority order):
 *   1. Invalid timestamp — NaN after Date.parse
 *   2. Negative layover — departure is not strictly after arrival
 *   3. Layover below MCT — too short to make the connection
 *   4. Layover above MAX_LAYOVER_MINUTES — unrealistic (more than 24 hours)
 *
 * Pure function — no I/O, no side effects.
 */
export function checkTemporalConnection(
  arrivalIso: string,
  departureIso: string,
  arrivalAirport: string,
  departureAirport: string,
): TemporalCheckResult {
  const isAirportTransfer = isSameCluster(arrivalAirport, departureAirport);
  const mct = isAirportTransfer ? MCT_AIRPORT_TRANSFER : MCT_SAME_AIRPORT;

  const arrivalMs   = new Date(arrivalIso).getTime();
  const departureMs = new Date(departureIso).getTime();

  if (isNaN(arrivalMs)) {
    return {
      valid: false,
      reason: `Invalid arrival timestamp: "${arrivalIso}"`,
      isAirportTransfer,
      minimumConnectionTime: mct,
    };
  }

  if (isNaN(departureMs)) {
    return {
      valid: false,
      reason: `Invalid departure timestamp: "${departureIso}"`,
      isAirportTransfer,
      minimumConnectionTime: mct,
    };
  }

  if (departureMs <= arrivalMs) {
    const layoverMinutes = (departureMs - arrivalMs) / 60_000;
    return {
      valid: false,
      reason: `Negative layover: departure is ${Math.abs(Math.round(layoverMinutes))} min before arrival`,
      layoverMinutes,
      isAirportTransfer,
      minimumConnectionTime: mct,
    };
  }

  const layoverMinutes = (departureMs - arrivalMs) / 60_000;

  if (layoverMinutes < mct) {
    return {
      valid: false,
      reason: `Layover ${Math.round(layoverMinutes)} min is below MCT ${mct} min` +
        ` (${isAirportTransfer ? 'airport transfer' : 'same airport'})`,
      layoverMinutes,
      isAirportTransfer,
      minimumConnectionTime: mct,
    };
  }

  if (layoverMinutes > MAX_LAYOVER_MINUTES) {
    return {
      valid: false,
      reason: `Layover ${Math.round(layoverMinutes)} min exceeds maximum ${MAX_LAYOVER_MINUTES} min`,
      layoverMinutes,
      isAirportTransfer,
      minimumConnectionTime: mct,
    };
  }

  return {
    valid: true,
    layoverMinutes,
    isAirportTransfer,
    minimumConnectionTime: mct,
  };
}
