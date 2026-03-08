import type { SearchParams, RoutingError } from '@travel-ai/types';
import { ROUTING_CONSTRAINTS } from '@travel-ai/types';
import { getDateWindow } from '@travel-ai/utils';

export interface DateWindowResult {
  /** YYYY-MM-DD dates to query, sorted ascending, past dates excluded. */
  dates: string[];
  /** Set when the entire ±flexDateWindowDays window falls in the past. */
  error?: RoutingError;
}

/**
 * Expands SearchParams.departureDate into the query date window defined by
 * ROUTING_CONSTRAINTS.flexDateWindowDays. Past dates are excluded.
 * Returns EMPTY_DATE_WINDOW if no future dates remain in the window.
 */
export function buildDateWindow(params: SearchParams): DateWindowResult {
  const dates = getDateWindow(params.departureDate, ROUTING_CONSTRAINTS.flexDateWindowDays);

  if (dates.length === 0) {
    return {
      dates: [],
      error: {
        code: 'EMPTY_DATE_WINDOW',
        message: `No future dates in the ±${ROUTING_CONSTRAINTS.flexDateWindowDays}-day window around ${params.departureDate}.`,
      },
    };
  }

  return { dates };
}
