# Travel-AI Routing Engine

Experimental disruption-aware flight routing engine inspired by ITA Matrix and Google Flights.

The project explores how to build a resilient flight routing system capable of finding routes even during major disruptions (airspace closures, sanctions, airline suspensions, etc).

---

## Current Status

The system is under active development.

Implemented layers:

- ✔ Search Space Control (Pass 1)
- ✔ Disruption Intelligence Layer (Pass 2)
- 🔧 Graph Routing Core (Pass 3 – in progress)
- ⏳ Connection Pattern Precomputation (Pass 4)
- ⏳ Search Frontier Compression (Pass 5)

---

## Key Features (Planned)

- Disruption-aware routing
- Geo-policy evaluation
- Corridor heuristics
- Overland continuation logic
- Multi-criteria routing (price / duration / survivability)
- Graph-based flight routing
- Deterministic routing engine

---

## Repository Structure
services/routing/
src/
airport-selection.ts
city-airports.ts
geo-policy.ts
corridor-heuristics.ts
overland-continuation.ts
explanation-engine.ts
schedule-index.ts
flight-graph.ts
connection-patterns.ts
search-frontier.ts


---

## Running locally

pnpm install
pnpm build
pnpm –filter @travel-ai/routing sample-search


Debug mode:

TRAVEL_AI_DEBUG=1 pnpm –filter @travel-ai/routing sample-search

---

## Goals of the project

This project investigates how to design a routing system capable of:

- surviving large-scale airline disruptions
- routing around geopolitical constraints
- exploring millions of route combinations efficiently
- remaining deterministic and explainable

---

## Inspiration

- Google Flights
- ITA Matrix
- airline schedule planning systems
- evacuation / disruption routing systems

---

## License

MIT

