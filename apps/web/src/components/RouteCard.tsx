'use client';

import { useState } from 'react';
import type { Route } from '@travel-ai/types';
import { formatDuration } from '@travel-ai/utils';
import { WarningBadge } from './WarningBadge';
import { RouteDetails } from './RouteDetails';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  // Amadeus times are local airport time (no Z); append Z so UTC parsing is consistent
  const d = iso.includes('Z') ? new Date(iso) : new Date(iso + 'Z');
  return d.toLocaleTimeString('en-GB', {
    hour:     '2-digit',
    minute:   '2-digit',
    timeZone: 'UTC',
  });
}

const FRAGILITY_LABELS: Record<string, string> = {
  low:      'Reliable',
  medium:   'Moderate',
  high:     'Risky',
  critical: 'Very risky',
};

const FRAGILITY_DOT: Record<string, string> = {
  low:      '●',
  medium:   '◑',
  high:     '○',
  critical: '○',
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  route: Route;
  rank:  number;
}

export function RouteCard({ route, rank }: Props) {
  const [expanded, setExpanded] = useState(false);

  const { flights } = route;
  const firstFlight = flights[0];
  const lastFlight  = flights[flights.length - 1];

  if (!firstFlight || !lastFlight) return null;

  const stops = flights.length - 1;
  const stopsLabel =
    stops === 0 ? 'Nonstop' :
    stops === 1 ? `1 stop · ${flights[0].destination}` :
    `${stops} stops`;

  const fragilityLabel = FRAGILITY_LABELS[route.fragilityLabel] ?? route.fragilityLabel;
  const fragilityDot   = FRAGILITY_DOT[route.fragilityLabel]   ?? '○';

  return (
    <article className="route-card">

      {/* ── Top row: rank · label · source/booking ─────────────────────────── */}
      <div className="route-card-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
          <span style={{ fontSize: '.68rem', color: 'var(--text-3)', fontWeight: 600 }}>#{rank}</span>
          {route.routeLabel && (
            <span className="route-label-badge">★ {route.routeLabel}</span>
          )}
        </div>
        <span className="route-source-badge">
          {route.source === 'fallback' ? 'assembled' : 'direct'}
          {' · '}
          {route.bookingMode === 'separate_tickets' ? 'sep. tickets' : 'single booking'}
        </span>
      </div>

      {/* ── Dense flight rows: carrier  DEP ── Xh Ym ──► ARR  PRICE ────────── */}
      <div className="route-card-flights">
        {flights.map((flight, i) => (
          <div key={flight.id} className="flight-row">

            {/* Carrier + flight number */}
            <span className="flight-carrier">
              {flight.carrier} {flight.flightNumber}
            </span>

            {/* DEP ── duration ──► ARR */}
            <div className="flight-times">
              <span className="flight-time">{fmtTime(flight.departingAt)}</span>
              <div className="flight-arrow">
                <span className="flight-duration">{formatDuration(flight.durationMinutes)}</span>
                <div className="flight-arrow-line" />
              </div>
              <span className="flight-time">{fmtTime(flight.arrivingAt)}</span>
            </div>

            {/* Price + fragility: only on first row to avoid repetition */}
            {i === 0 && (
              <div className="route-price-block">
                <span className="route-price">
                  {route.currency} {route.totalPrice.toLocaleString()}
                </span>
                <span className={`route-fragility route-fragility-${route.fragilityLabel}`}>
                  {fragilityDot} {fragilityLabel}
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ── IATA dots row: LHR ··· 1 stop (CDG) ··· JFK ────────────────────── */}
      <div className="route-iata-row">
        <span className="route-iata">{firstFlight.origin}</span>
        <span className="route-stops-label">{stopsLabel}</span>
        <span className="route-iata">{lastFlight.destination}</span>
      </div>

      {/* ── Warning badges ───────────────────────────────────────────────────── */}
      {route.warnings.length > 0 && (
        <div className="route-warnings-row">
          {route.warnings.map((w, i) => (
            <WarningBadge key={i} code={w.code} severity={w.severity} />
          ))}
        </div>
      )}

      {/* ── Footer: ranking explanation · expand toggle ──────────────────────── */}
      <div className="route-card-footer">
        <span className="route-summary-text">
          {route.whyRankedHere ?? route.summary}
        </span>
        <button
          className="details-toggle"
          onClick={() => setExpanded(v => !v)}
          aria-expanded={expanded}
          aria-controls={`details-${route.id}`}
        >
          {expanded ? '▲ Hide' : '▶ Details'}
        </button>
      </div>

      {/* ── Expandable details ────────────────────────────────────────────────── */}
      {expanded && (
        <div id={`details-${route.id}`}>
          <RouteDetails route={route} />
        </div>
      )}
    </article>
  );
}
