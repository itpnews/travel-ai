# Routing Pipeline

## Route categories

### Provider itinerary (`source: 'provider'`, `bookingMode: 'single_booking'`)

Returned directly by the travel provider (Duffel). All legs are under one PNR. If a flight is disrupted, the carrier is responsible for rebooking all subsequent legs. No `bookingGroups` field.

### Assembled route (`source: 'fallback'`, `bookingMode: 'separate_tickets'`)

Built by the hub-fallback path when the provider returns fewer than `minProviderRoutesBeforeFallback` viable results. Combines independently-sourced legs via intermediate hubs. Each hub segment is a separate booking with no interline protection. `bookingGroups` is always present and contains one entry per separately purchased segment.

## Booking fields on `Route`

| Field | Provider itinerary | Assembled route |
|---|---|---|
| `source` | `'provider'` | `'fallback'` |
| `bookingMode` | `'single_booking'` | `'separate_tickets'` |
| `bookingGroups` | absent | array of `BookingGroup` |

## `ASSEMBLED_ROUTE` warning

Applied to every assembled route during scoring. Always `severity: 'warn'`.

Message: `"This route requires buying separate tickets. If one leg is delayed, the next one may not be protected."`

## Pipeline flow (summary)

```
SearchParams
  │
  ├─► Provider call (Duffel, ±3 day window)
  │     └─ source='provider', bookingMode='single_booking'
  │
  └─► Hub fallback (if provider < minProviderRoutesBeforeFallback)
        └─ source='fallback', bookingMode='separate_tickets'
              └─ ASSEMBLED_ROUTE warning attached at scoring step
```

## Notes

- `totalPrice` is the only price surface at MVP. Per-booking prices within an assembled route are not available from the hub-fallback path and are deferred to v1.
- `BookingGroup.carrier` is optional. It is populated when the carrier for a segment is unambiguous (e.g. single-carrier leg); omitted when mixed or unknown.
