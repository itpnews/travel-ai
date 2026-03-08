// ─── Geo ──────────────────────────────────────────────────────────────────────

const EARTH_RADIUS_KM = 6371;

/** Haversine great-circle distance between two lat/lng points in kilometres. */
export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Date Window ──────────────────────────────────────────────────────────────

/**
 * Returns an array of YYYY-MM-DD strings centered on `date` with ±`days` range.
 * Dates in the past (before today) are excluded.
 * @param date  Center date in "YYYY-MM-DD" format.
 * @param days  Number of days either side (e.g. 3 → 7 dates total).
 */
export function getDateWindow(date: string, days: number): string[] {
  const center = new Date(date + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const result: string[] = [];
  for (let delta = -days; delta <= days; delta++) {
    const d = new Date(center);
    d.setUTCDate(d.getUTCDate() + delta);
    if (d >= today) {
      result.push(d.toISOString().slice(0, 10));
    }
  }
  return result;
}

// ─── Duration ─────────────────────────────────────────────────────────────────

/** Formats a duration in minutes as "Xh Ym" (e.g. 550 → "9h 10m"). */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ─── Math ─────────────────────────────────────────────────────────────────────

/** Clamps `val` to the inclusive range [min, max]. */
export function clamp(val: number, min: number, max: number): number {
  return Math.min(Math.max(val, min), max);
}

// ─── IATA Validation ──────────────────────────────────────────────────────────

/** Returns true if `code` is exactly 3 uppercase ASCII letters. */
export function isValidIata(code: string): boolean {
  return /^[A-Z]{3}$/.test(code);
}

// ─── Date Validation ──────────────────────────────────────────────────────────

/** Returns true if `date` is a valid YYYY-MM-DD string that is not in the past. */
export function isValidFutureDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(date + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return d >= today;
}
