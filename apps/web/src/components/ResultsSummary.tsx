'use client';

import type { SearchResult } from '@travel-ai/types';

interface Props {
  result:      SearchResult;
  refreshedAt: Date;
}

export function ResultsSummary({ result, refreshedAt }: Props) {
  const { routes, params } = result;

  const fromPrice = routes.length > 0
    ? Math.min(...routes.map(r => r.totalPrice))
    : null;

  const refreshedStr = refreshedAt.toLocaleTimeString('en-GB', {
    hour:   '2-digit',
    minute: '2-digit',
  });

  return (
    <p className="results-summary">
      <strong>{routes.length} result{routes.length !== 1 ? 's' : ''}</strong>
      {' · '}
      {params.origin} → {params.destination}
      {' · '}
      {params.departureDate}
      {fromPrice !== null && (
        <>
          {' · from '}
          <strong>
            {params.currency} {fromPrice.toLocaleString()}
          </strong>
        </>
      )}
      {' '}
      <span className="results-refresh">· refreshed {refreshedStr}</span>
    </p>
  );
}
