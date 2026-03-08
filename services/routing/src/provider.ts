import type { Flight } from '@travel-ai/types';

// ─── Provider types ───────────────────────────────────────────────────────────

/**
 * Raw offer returned by a travel provider before mapping into a Route.
 * One offer = one purchasable itinerary (all flights under a single booking).
 */
export interface ProviderOffer {
  flights: Flight[];
  totalPrice: number;
  currency: string;
}

export interface FetchOffersParams {
  origin: string;       // IATA
  destination: string;  // IATA
  date: string;         // YYYY-MM-DD
  passengers: number;
  currency: string;
}

// ─── Adapter interface ────────────────────────────────────────────────────────

/**
 * Contract that every travel provider adapter must implement.
 * The routing engine depends on this interface, not on any concrete provider.
 */
export interface ProviderAdapter {
  fetchOffers(params: FetchOffersParams): Promise<ProviderOffer[]>;
}

// ─── Stub adapter ─────────────────────────────────────────────────────────────

/**
 * No-op adapter used in local development and tests.
 * Always returns an empty offer list — triggers fallback path in the engine.
 */
export class StubProviderAdapter implements ProviderAdapter {
  async fetchOffers(_params: FetchOffersParams): Promise<ProviderOffer[]> {
    return [];
  }
}
