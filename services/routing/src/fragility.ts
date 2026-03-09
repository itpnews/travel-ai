import type { Route, RouteWarning, FragilityLabel } from '@travel-ai/types';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FragilityBreakdown {
  /** Penalty for the number of flight segments in the route. */
  segments: number;
  /** Penalty for the absence of interline protection (separate-ticket bookings). */
  separateTickets: number;
  /** Penalty for tight or unrealistic layover times across all connections. */
  connections: number;
  /** Penalty for connections that require a physical airport transfer. */
  transfers: number;
  /** Penalty for extended layovers that increase disruption propagation risk. */
  overnight: number;
  /** Penalty for operating across multiple carriers and/or alliances. */
  complexity: number;
}

export interface FragilityResult {
  /** Additive sum of all breakdown penalties, clamped to 0..1. */
  fragilityScore: number;
  fragilityLabel: FragilityLabel;
  fragilityBreakdown: FragilityBreakdown;
}

// ─── Alliance data ────────────────────────────────────────────────────────────
// Used only to distinguish same-alliance vs cross-alliance complexity.
// Coverage: major current members of each of the three global alliances.

type Alliance = 'star' | 'oneworld' | 'skyteam';

const AIRLINE_ALLIANCE: Readonly<Record<string, Alliance>> = {
  // Star Alliance
  UA: 'star', LH: 'star', LX: 'star', OS: 'star', SN: 'star',
  TG: 'star', NH: 'star', NZ: 'star', SK: 'star', CA: 'star',
  AI: 'star', ET: 'star', MS: 'star', OZ: 'star', SQ: 'star',
  AC: 'star', BR: 'star', JP: 'star', ZH: 'star', SA: 'star',
  // Oneworld
  AA: 'oneworld', BA: 'oneworld', QF: 'oneworld', CX: 'oneworld',
  JL: 'oneworld', IB: 'oneworld', AY: 'oneworld', MH: 'oneworld',
  RJ: 'oneworld', LA: 'oneworld', AT: 'oneworld', S7: 'oneworld',
  AS: 'oneworld',
  // SkyTeam
  DL: 'skyteam', AF: 'skyteam', KL: 'skyteam', MU: 'skyteam',
  KE: 'skyteam', CZ: 'skyteam', CI: 'skyteam', GA: 'skyteam',
  AM: 'skyteam', AZ: 'skyteam', OK: 'skyteam', RO: 'skyteam',
  VN: 'skyteam', SV: 'skyteam',
};

// ─── Thresholds ───────────────────────────────────────────────────────────────

/**
 * Same-airport layover below this (minutes) is structurally unrealistic.
 * Mirrors the threshold in warnings.ts for consistency.
 */
const UNREALISTIC_SAME_AIRPORT_MINUTES = 45;

/**
 * Same-airport layover below this is "tight" — not unrealistic, but increases
 * missed-connection risk meaningfully.
 */
const TIGHT_SAME_AIRPORT_MINUTES = 90;

/**
 * Airport-transfer (different airports, same city) layover below this is
 * unrealistic — not enough time to exit, transfer, and re-check.
 * Mirrors the threshold in warnings.ts.
 */
const UNREALISTIC_TRANSFER_MINUTES = 90;

/**
 * Airport-transfer layover below this is "tight" — physically possible but risky.
 */
const TIGHT_TRANSFER_MINUTES = 150;

/**
 * Layovers above this are treated as extended (overnight or deliberate stopover).
 * Extended layovers increase disruption propagation risk on the outbound leg.
 */
const EXTENDED_LAYOVER_MINUTES = 480;   // 8 hours

// ─── Factor weights ───────────────────────────────────────────────────────────

/** Base structural penalty by segment count. Index = number of flights (max 4). */
const SEGMENT_PENALTY = [0.00, 0.00, 0.08, 0.16, 0.22] as const;

/** Per-connection penalties for same-airport timing. */
const UNREALISTIC_CONNECTION_PENALTY = 0.22;
const TIGHT_CONNECTION_PENALTY       = 0.08;
const CONNECTION_PENALTY_CAP         = 0.35;

/** Per-transfer penalty for airport transfers (structural, timing-independent). */
const TRANSFER_PENALTY     = 0.10;
const TRANSFER_PENALTY_CAP = 0.18;

/** Per-occurrence penalty for extended layovers. */
const EXTENDED_LAYOVER_PENALTY     = 0.08;
const EXTENDED_LAYOVER_PENALTY_CAP = 0.12;

// ─── Label thresholds ─────────────────────────────────────────────────────────

const LABEL_THRESHOLDS: ReadonlyArray<[number, FragilityLabel]> = [
  [0.75, 'critical'],
  [0.50, 'high'],
  [0.25, 'medium'],
  [0.00, 'low'],
];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Computes a structural fragility score for a route.
 *
 * Fragility measures how likely a route is to fall apart due to its own
 * structural properties — segment count, booking protection gaps, tight
 * connections, required airport transfers, and carrier complexity.
 *
 * It does NOT incorporate geopolitical or country-level disruption risk;
 * that is the domain of HIGH_DISRUPTION_RISK in warnings.ts.
 *
 * Pure function — no side effects, no I/O.
 *
 * @param route    The route to evaluate.
 * @param warnings Already-computed warnings for this route. Used to detect
 *                 airport transfer requirements without re-importing CITY_AIRPORTS.
 */
export function computeFragility(
  route: Route,
  warnings: RouteWarning[],
): FragilityResult {

  // ── segments ────────────────────────────────────────────────────────────────
  // More flights = more opportunities for disruption to cascade.
  const segmentCount = Math.min(route.flights.length, 4);
  const segments = SEGMENT_PENALTY[segmentCount];

  // ── separateTickets ──────────────────────────────────────────────────────────
  // Separate bookings have no interline protection: a delay on one ticket
  // does not trigger rebooking on the next. Penalty scales with booking group
  // count. At MVP (depth-1 fallback), assembled routes have at most 2 booking
  // groups. The formula is extensible to larger assembled routes as fallback
  // depth increases in future releases.
  let separateTickets = 0;
  if (route.bookingMode === 'separate_tickets') {
    const groupCount = route.bookingGroups?.length ?? 2;
    separateTickets = Math.min(0.18 + (groupCount - 2) * 0.05, 0.30);
  }

  // ── connections ─────────────────────────────────────────────────────────────
  // Evaluated per consecutive flight pair. Transfer classification is owned by
  // upstream routing (warnings.ts). For different-airport connections, we only
  // apply transfer thresholds when an AIRPORT_TRANSFER_REQUIRED warning confirms
  // the pair — we do not independently infer transfers from airport mismatches.
  const transferWarnings = warnings.filter(
    w => w.code === 'AIRPORT_TRANSFER_REQUIRED',
  );

  let connectionRaw = 0;
  for (let i = 0; i < route.flights.length - 1; i++) {
    const inbound  = route.flights[i];
    const outbound = route.flights[i + 1];

    const layoverMinutes =
      (new Date(outbound.departingAt).getTime() -
       new Date(inbound.arrivingAt).getTime()) / 60_000;

    if (inbound.destination === outbound.origin) {
      // Same airport — apply same-airport thresholds directly.
      if (layoverMinutes < UNREALISTIC_SAME_AIRPORT_MINUTES) {
        connectionRaw += UNREALISTIC_CONNECTION_PENALTY;
      } else if (layoverMinutes < TIGHT_SAME_AIRPORT_MINUTES) {
        connectionRaw += TIGHT_CONNECTION_PENALTY;
      }
    } else {
      // Different airports. Only apply transfer thresholds when upstream routing
      // has classified this pair as an airport transfer.
      const isConfirmedTransfer = transferWarnings.some(
        w =>
          w.message.includes(inbound.destination) &&
          w.message.includes(outbound.origin),
      );
      if (isConfirmedTransfer) {
        if (layoverMinutes < UNREALISTIC_TRANSFER_MINUTES) {
          connectionRaw += UNREALISTIC_CONNECTION_PENALTY;
        } else if (layoverMinutes < TIGHT_TRANSFER_MINUTES) {
          connectionRaw += TIGHT_CONNECTION_PENALTY;
        }
      }
    }
  }
  const connections = Math.min(connectionRaw, CONNECTION_PENALTY_CAP);

  // ── transfers ────────────────────────────────────────────────────────────────
  // Airport transfers add baseline structural risk beyond timing alone:
  // security re-entry, check-in cutoffs, and ground transport failure modes.
  // Penalty is independent of layover duration (timing is already in connections).
  const transfers = Math.min(
    transferWarnings.length * TRANSFER_PENALTY,
    TRANSFER_PENALTY_CAP,
  );

  // ── overnight ────────────────────────────────────────────────────────────────
  // Extended layovers (> 8h) are proxies for overnight stops. They increase
  // disruption propagation risk: a delay on day N may unwind a connection on
  // day N+1 with no real-time rebooking path for assembled routes.
  let overnightRaw = 0;
  for (let i = 0; i < route.flights.length - 1; i++) {
    const inbound  = route.flights[i];
    const outbound = route.flights[i + 1];
    const layoverMinutes =
      (new Date(outbound.departingAt).getTime() -
       new Date(inbound.arrivingAt).getTime()) / 60_000;

    if (layoverMinutes > EXTENDED_LAYOVER_MINUTES) {
      overnightRaw += EXTENDED_LAYOVER_PENALTY;
    }
  }
  const overnight = Math.min(overnightRaw, EXTENDED_LAYOVER_PENALTY_CAP);

  // ── complexity ───────────────────────────────────────────────────────────────
  // Multi-carrier routes are harder to recover: rebooking is less automatic,
  // interline baggage agreements may not apply, and responsibility is disputed.
  // Same-alliance carriers provide more protection than cross-alliance pairs.
  const carriers = new Set(route.flights.map(f => f.carrier));
  let complexity: number;

  if (carriers.size === 1) {
    complexity = 0.00;
  } else if (carriers.size === 2) {
    const [c1, c2] = [...carriers];
    const a1 = AIRLINE_ALLIANCE[c1];
    const a2 = AIRLINE_ALLIANCE[c2];
    complexity = (a1 && a2 && a1 === a2) ? 0.03 : 0.07;
  } else {
    // 3+ distinct carriers: coordination across recovery is impractical.
    complexity = 0.12;
  }

  // ── total ─────────────────────────────────────────────────────────────────────
  const rawScore =
    segments + separateTickets + connections + transfers + overnight + complexity;
  const fragilityScore = Math.min(rawScore, 1.0);

  return {
    fragilityScore,
    fragilityLabel: scoreToLabel(fragilityScore),
    fragilityBreakdown: {
      segments,
      separateTickets,
      connections,
      transfers,
      overnight,
      complexity,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function scoreToLabel(score: number): FragilityLabel {
  for (const [threshold, label] of LABEL_THRESHOLDS) {
    if (score >= threshold) return label;
  }
  return 'low';
}
