from __future__ import annotations

import bisect
from datetime import datetime
from typing import Any


class ScheduleIndex:
    """Pre-built, sorted index of flights keyed by origin airport.

    Built once at startup from the schedule graph.  All subsequent
    lookups use binary search — O(log n) per query instead of O(n).
    """

    def __init__(self, flights: list[Any]) -> None:
        # Group flights by origin airport
        grouped: dict[str, list[Any]] = {}
        for flight in flights:
            grouped.setdefault(flight.origin, []).append(flight)

        # Sort each group by departure_time ascending
        self._index: dict[str, list[Any]] = {
            airport: sorted(group, key=lambda f: f.departure_time)
            for airport, group in grouped.items()
        }

        # Parallel list of departure_time values for bisect
        self._keys: dict[str, list[datetime]] = {
            airport: [f.departure_time for f in group]
            for airport, group in self._index.items()
        }

    def get_outgoing_flights(
        self, airport: str, earliest_departure: datetime
    ) -> list[Any]:
        """Return all flights from airport departing at or after earliest_departure."""
        flights = self._index.get(airport)
        if not flights:
            return []

        keys = self._keys[airport]
        # bisect_left finds the insertion point for earliest_departure,
        # which is also the index of the first qualifying flight.
        start = bisect.bisect_left(keys, earliest_departure)
        return flights[start:]
