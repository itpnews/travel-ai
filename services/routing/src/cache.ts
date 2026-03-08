import { ROUTING_CONSTRAINTS } from '@travel-ai/types';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;  // ms epoch
}

/**
 * In-memory TTL cache keyed by string.
 * TTL is read once at construction from ROUTING_CONSTRAINTS.cacheTTLSeconds.
 * Expired entries are evicted lazily on get().
 */
export class RouteCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlSeconds = ROUTING_CONSTRAINTS.cacheTTLSeconds) {
    this.ttlMs = ttlSeconds * 1000;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Builds a deterministic cache key for a provider offer request.
 * Format: "<ORIGIN>:<DESTINATION>:<YYYY-MM-DD>:<passengers>"
 */
export function makeCacheKey(
  origin: string,
  destination: string,
  date: string,
  passengers: number,
): string {
  return `${origin}:${destination}:${date}:${passengers}`;
}
