'use client';

import type { Route, Flight } from '@travel-ai/types';
import { formatDuration } from '@travel-ai/utils';
import { WarningBadge } from './WarningBadge';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  const d = iso.includes('Z') ? new Date(iso) : new Date(iso + 'Z');
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
}

function fmtDateShort(iso: string): string {
  const d = iso.includes('Z') ? new Date(iso) : new Date(iso + 'Z');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function layoverMins(prev: Flight, next: Flight): number {
  return (new Date(next.departingAt).getTime() - new Date(prev.arrivingAt).getTime()) / 60_000;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props { route: Route }

export function RouteDetails({ route }: Props) {
  const { flights } = route;

  return (
    <div className="route-details">

      {/* ── Itinerary timeline ───────────────────────────────────────────────── */}
      <section>
        <p className="details-section-heading">Itinerary</p>
        <ol className="flight-timeline">
          {flights.map((flight, i) => {
            const prev   = flights[i - 1];
            const layover = prev ? layoverMins(prev, flight) : null;

            return (
              <li key={flight.id}>
                {/* Layover connector */}
                {layover !== null && (() => {
                  const isTransfer  = prev.destination !== flight.origin;
                  const quality     =
                    layover < 45  ? 'impossible' :
                    layover < 90  ? 'risky'      :
                    layover < 180 ? 'tight'      : 'safe';
                  const qualityNote =
                    quality === 'impossible' ? ' · ⛔ cannot make connection' :
                    quality === 'risky'      ? ' · ⚠ risky connection'       :
                    quality === 'tight'      ? ' · ⚠ tight connection'       : '';
                  return (
                    <div className="timeline-layover">
                      <div className="timeline-layover-line" />
                      <p className="timeline-layover-info">
                        {Math.round(layover)} min layover at {prev.destination}
                        {qualityNote}
                        {isTransfer && ' · ✈ airport transfer required'}
                      </p>
                    </div>
                  );
                })()}

                {/* Departure point */}
                <div className="timeline-point">
                  <div className={`timeline-dot${i > 0 && i < flights.length ? ' timeline-dot-mid' : ''}`} />
                  <div className="timeline-info">
                    <span className="timeline-iata">{flight.origin}</span>{' '}
                    <span className="timeline-datetime">
                      {fmtTime(flight.departingAt)} · {fmtDateShort(flight.departingAt)}
                    </span>
                  </div>
                </div>

                {/* Segment line */}
                <div className="timeline-segment">
                  <div className="timeline-segment-line" />
                  <div className="timeline-segment-info">
                    <span className="timeline-segment-label">
                      {flight.carrier} {flight.flightNumber}
                    </span>
                    {' · '}
                    <span className="capitalize">{flight.cabinClass.replace('_', ' ')}</span>
                    {' · '}
                    {formatDuration(flight.durationMinutes)}
                  </div>
                </div>

                {/* Arrival point (last flight only) */}
                {i === flights.length - 1 && (
                  <div className="timeline-point">
                    <div className="timeline-dot" />
                    <div className="timeline-info">
                      <span className="timeline-iata">{flight.destination}</span>{' '}
                      <span className="timeline-datetime">
                        {fmtTime(flight.arrivingAt)} · {fmtDateShort(flight.arrivingAt)}
                      </span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </section>

      {/* ── Booking info ─────────────────────────────────────────────────────── */}
      <section>
        <p className="details-section-heading">Booking</p>
        <dl className="booking-dl">
          <div className="booking-dl-row">
            <dt>Source</dt>
            <dd>{route.source === 'provider' ? 'Direct provider' : 'Assembled (hub fallback)'}</dd>
          </div>
          <div className="booking-dl-row">
            <dt>Booking type</dt>
            <dd>{route.bookingMode === 'single_booking' ? 'Single booking' : 'Separate tickets'}</dd>
          </div>
          <div className="booking-dl-row">
            <dt>Departure date</dt>
            <dd>
              {route.actualDepartureDate}
              {route.dateDeltaDays !== 0 && (
                <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>
                  {' '}({route.dateDeltaDays > 0 ? '+' : ''}{route.dateDeltaDays}d from requested)
                </span>
              )}
            </dd>
          </div>
          <div className="booking-dl-row">
            <dt>Budget band</dt>
            <dd className="capitalize">{route.budgetBand}</dd>
          </div>
        </dl>

        {route.bookingGroups && route.bookingGroups.length > 0 && (
          <div style={{ marginTop: '.6rem' }}>
            <p className="details-section-heading" style={{ marginBottom: '.35rem' }}>Booking groups</p>
            {route.bookingGroups.map((bg, i) => (
              <div key={bg.id} style={{ fontSize: '.8rem', color: 'var(--text-2)', marginBottom: '.2rem' }}>
                <strong>Booking {i + 1}:</strong>{' '}
                {bg.flightIds.map(fid => {
                  const f = route.flights.find(fl => fl.id === fid);
                  return f ? `${f.origin}→${f.destination} (${f.carrier}${f.flightNumber})` : fid;
                }).join(', ')}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Warnings ─────────────────────────────────────────────────────────── */}
      {route.warnings.length > 0 && (
        <section>
          <p className="details-section-heading">Warnings</p>
          <div className="details-warnings">
            {route.warnings.map((w, i) => (
              <div key={i} className="details-warning-item">
                <WarningBadge code={w.code} severity={w.severity} />
                <p className="details-warning-msg">{w.message}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
