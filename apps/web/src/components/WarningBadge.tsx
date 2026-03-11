'use client';

import type { RouteWarningCode } from '@travel-ai/types';

const WARNING_LABELS: Partial<Record<RouteWarningCode, string>> = {
  ASSEMBLED_ROUTE:          'Separate tickets',
  SHORT_CONNECTION:         'Short connection',
  TIGHT_CONNECTION:         'Tight connection',
  RISKY_ITINERARY:          'Risky itinerary',
  LONG_LAYOVER:             'Long layover',
  UNREALISTIC_CONNECTION:   'Impossible connection',
  AIRPORT_TRANSFER_REQUIRED:'Airport transfer',
  HIGH_DISRUPTION_RISK:     'Disruption risk',
  LONG_TRAVEL_TIME:         'Long travel time',
  BUDGET_OVERRUN:           'Over budget',
  MANY_SEGMENTS:            'Many segments',
  ALTERNATE_DATE:           'Alternate date',
};

interface Props {
  code: RouteWarningCode;
  severity: 'info' | 'warn' | 'critical';
}

export function WarningBadge({ code, severity }: Props) {
  const label = WARNING_LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase();
  return (
    <span className={`warning-badge warning-badge-${severity}`}>
      {severity === 'critical' ? '⛔' : severity === 'warn' ? '⚠' : 'ℹ'} {label}
    </span>
  );
}
