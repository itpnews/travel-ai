from __future__ import annotations

import heapq
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from engine.schedule_index import ScheduleIndex


@dataclass
class RoutingQuery:
    origin_airport: str
    destination_airport: str
    departure_time: datetime
    max_connections: int
    max_trip_time: float  # minutes


@dataclass
class Route:
    flights: list[Any]
    total_time: float  # minutes
    total_price: float
    connection_count: int


@dataclass(order=True)
class Label:
    """Lightweight search label for the priority queue.

    Ordered by total_price so the heap always surfaces the cheapest
    partial path first.  All mutable path state is non-comparable.
    """

    total_price: float
    total_time: float                                        # minutes from origin departure
    airport: str               = field(compare=False)
    arrival_time: datetime     = field(compare=False, default=None)  # type: ignore[assignment]
    flights: tuple[Any, ...]   = field(compare=False, default=())    # immutable — no copy on expand
    connections: int           = field(compare=False, default=0)


class RoutingEngine:
    def __init__(
        self,
        schedule_graph: Any,
        routing_config: dict[str, Any],
        schedule_index: ScheduleIndex | None = None,
    ) -> None:
        self.graph = schedule_graph
        self.config = routing_config
        # Index is built once at startup; fall back to None (graph stub) if absent.
        self._index = schedule_index

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def find_routes(self, query: RoutingQuery) -> list[Route]:
        candidate_routes: list[Route] = []

        # Per-airport Pareto frontier: airport -> list of non-dominated labels
        best_labels: dict[str, list[Label]] = {}

        pq: list[Label] = []
        initial = Label(
            total_price=0.0,
            total_time=0.0,
            airport=query.origin_airport,
            arrival_time=query.departure_time,
            flights=(),
            connections=0,
        )
        heapq.heappush(pq, initial)

        while pq:
            label = heapq.heappop(pq)

            # Dominance check before processing
            if self.is_dominated(label, best_labels.get(label.airport, [])):
                continue
            self._add_to_frontier(label, best_labels)

            if label.airport == query.destination_airport and label.flights:
                candidate_routes.append(
                    Route(
                        flights=list(label.flights),
                        total_time=label.total_time,
                        total_price=label.total_price,
                        connection_count=label.connections,
                    )
                )
                continue

            for new_label in self._expand_label(label, query):
                heapq.heappush(pq, new_label)

        return candidate_routes

    # ------------------------------------------------------------------
    # Dominance
    # ------------------------------------------------------------------

    @staticmethod
    def is_dominated(new: Label, existing: list[Label]) -> bool:
        """Return True if any label in existing dominates new.

        Label A dominates label B when:
          A.arrival_time  <= B.arrival_time
          A.total_price   <= B.total_price
          A.connections   <= B.connections
        with at least one strictly better dimension.
        """
        for e in existing:
            if (
                e.arrival_time <= new.arrival_time
                and e.total_price <= new.total_price
                and e.connections <= new.connections
                and (
                    e.arrival_time < new.arrival_time
                    or e.total_price < new.total_price
                    or e.connections < new.connections
                )
            ):
                return True
        return False

    @staticmethod
    def _add_to_frontier(new: Label, best_labels: dict[str, list[Label]]) -> None:
        """Add new to the airport's Pareto frontier, removing any labels it dominates."""
        airport = new.airport
        current = best_labels.get(airport, [])
        # Evict labels that new strictly dominates
        surviving = [
            e for e in current
            if not (
                new.arrival_time <= e.arrival_time
                and new.total_price <= e.total_price
                and new.connections <= e.connections
                and (
                    new.arrival_time < e.arrival_time
                    or new.total_price < e.total_price
                    or new.connections < e.connections
                )
            )
        ]
        surviving.append(new)
        best_labels[airport] = surviving

    # ------------------------------------------------------------------
    # Expansion
    # ------------------------------------------------------------------

    def _expand_label(self, label: Label, query: RoutingQuery) -> list[Label]:
        """Expand label into one new Label per reachable outgoing flight.

        Applies:
        - minimum connection time gate
        - max_connections constraint
        - max_trip_time constraint
        """
        if label.connections >= query.max_connections and label.flights:
            return []

        min_connect_minutes: float = self.config.get("min_connection_minutes", 30)
        earliest_departure: datetime = label.arrival_time + timedelta(
            minutes=min_connect_minutes if label.flights else 0
        )

        outgoing = self._get_outgoing_flights(label.airport, earliest_departure)

        expanded: list[Label] = []
        for flight in outgoing:
            flight_duration: float = self._flight_duration_minutes(flight)
            new_total_time = label.total_time + self._wait_minutes(
                label.arrival_time, flight
            ) + flight_duration

            if new_total_time > query.max_trip_time:
                continue

            new_label = Label(
                total_price=label.total_price + self._flight_price(flight),
                total_time=new_total_time,
                airport=self._flight_destination(flight),
                arrival_time=self._flight_arrival_time(flight),
                flights=label.flights + (flight,),
                connections=label.connections + (1 if label.flights else 0),
            )
            expanded.append(new_label)

        return expanded

    # ------------------------------------------------------------------
    # Graph accessors (wired to schedule_graph once its API is confirmed)
    # ------------------------------------------------------------------

    def _get_outgoing_flights(self, airport: str, after: datetime) -> list[Any]:
        """Return flights departing from airport at or after `after`.

        Uses the pre-built ScheduleIndex when available (O(log n) binary
        search); falls back to the raw graph stub otherwise.
        """
        if self._index is not None:
            return self._index.get_outgoing_flights(airport, after)
        # TODO: delegate to self.graph  e.g. self.graph.outgoing(airport, after)
        return []

    # ------------------------------------------------------------------
    # Flight attribute accessors — single place to adapt to graph schema
    # ------------------------------------------------------------------

    def _flight_destination(self, flight: Any) -> str:
        return flight.destination

    def _flight_arrival_time(self, flight: Any) -> datetime:
        return flight.arrival_time

    def _flight_price(self, flight: Any) -> float:
        return flight.price

    def _flight_duration_minutes(self, flight: Any) -> float:
        delta: timedelta = flight.arrival_time - flight.departure_time
        return delta.total_seconds() / 60

    def _wait_minutes(self, current_arrival: datetime, flight: Any) -> float:
        delta: timedelta = flight.departure_time - current_arrival
        return max(0.0, delta.total_seconds() / 60)
