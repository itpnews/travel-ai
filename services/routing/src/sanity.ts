import type { SearchParams, RoutingError } from '@travel-ai/types';
import { AIRPORT_METADATA } from '@travel-ai/types';
import { isValidIata, isValidFutureDate } from '@travel-ai/utils';

/**
 * Validates SearchParams before any provider or fallback call.
 * Returns an array of RoutingErrors; empty means the params are valid.
 */
export function validateSearchParams(params: SearchParams): RoutingError[] {
  const errors: RoutingError[] = [];

  // Origin
  if (!isValidIata(params.origin)) {
    errors.push({ code: 'INVALID_IATA', message: `Origin "${params.origin}" is not a valid IATA code.` });
  } else if (!(params.origin in AIRPORT_METADATA)) {
    errors.push({ code: 'INVALID_AIRPORT', message: `Origin "${params.origin}" is not a recognised airport.` });
  }

  // Destination
  if (!isValidIata(params.destination)) {
    errors.push({ code: 'INVALID_IATA', message: `Destination "${params.destination}" is not a valid IATA code.` });
  } else if (!(params.destination in AIRPORT_METADATA)) {
    errors.push({ code: 'INVALID_AIRPORT', message: `Destination "${params.destination}" is not a recognised airport.` });
  }

  // Date
  if (!isValidFutureDate(params.departureDate)) {
    errors.push({ code: 'INVALID_DATE', message: `Departure date "${params.departureDate}" is in the past or not a valid YYYY-MM-DD date.` });
  }

  return errors;
}
