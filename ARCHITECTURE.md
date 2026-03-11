# System Architecture

The routing engine is built in layered stages.

## Layer 1 — Search Space Control

Limits the routing search space.

Modules:

- airport-selection.ts
- city-airports.ts
- dominance pruning

## Layer 2 — Disruption Intelligence

Adds geopolitical awareness.

Modules:

- geo-policy.ts
- corridor-heuristics.ts
- overland-continuation.ts
- explanation-engine.ts

## Layer 3 — Graph Routing Core (in progress)

Introduces graph-based routing.

Modules:

- schedule-index.ts
- flight-graph.ts
- label-setting routing

## Layer 4 — Connection Pattern Precomputation (planned)

Modules:

- connection-patterns.ts

## Layer 5 — Search Frontier Compression (planned)

Modules:

- search-frontier.ts
