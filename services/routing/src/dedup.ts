import type { Route } from '@travel-ai/types';

/**
 * Returns a deduplicated list of routes, keeping at most one route per unique
 * ordered flight sequence. When two routes share the same sequence, the one
 * with the smaller |dateDeltaDays| is kept; ties favour the first occurrence.
 */
export function deduplicateRoutes(routes: Route[]): Route[] {
  const best = new Map<string, Route>();

  for (const route of routes) {
    const key = route.flights
      .map(f => `${f.carrier}${f.flightNumber}`)
      .join('|');

    const current = best.get(key);
    if (
      current === undefined ||
      Math.abs(route.dateDeltaDays) < Math.abs(current.dateDeltaDays)
    ) {
      best.set(key, route);
    }
  }

  return Array.from(best.values());
}
