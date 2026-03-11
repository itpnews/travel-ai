![Status](https://img.shields.io/badge/status-experimental-orange)
![Language](https://img.shields.io/badge/language-typescript-blue)
![License](https://img.shields.io/badge/license-MIT-green)

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

### Web demo (`apps/web`)

A Next.js UI for searching and viewing ranked routes, with live Amadeus flight data support.

#### Setup

```bash
pnpm install
pnpm --filter @travel-ai/types build    # compile shared types (required once)
pnpm --filter @travel-ai/utils build    # compile shared utilities (required once)
```

#### Optional: live Amadeus data

Without credentials the app runs in **demo mode** (mock data, clearly labelled).

To enable live Amadeus flight offers:

1. Create a free account at [developers.amadeus.com](https://developers.amadeus.com/)
2. Create an app and copy the test credentials
3. Copy the example env file and fill in your credentials:

```bash
cp apps/web/.env.local.example apps/web/.env.local
# then edit apps/web/.env.local with your AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET
```

#### Run

```bash
pnpm --filter @travel-ai/web dev       # start dev server at http://localhost:3000
```

**Try it:** enter `LHR` → `JFK` (or any IATA pair) with any future date. Sort results by Best / Cheapest / Fastest / Lowest risk. Click **▶ Details** on any card for the full flight timeline.

---

### Routing engine sample search (CLI)

```bash
pnpm install
pnpm build
pnpm --filter @travel-ai/routing sample-search
```

Debug mode:

```bash
TRAVEL_AI_DEBUG=1 pnpm --filter @travel-ai/routing sample-search
```

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


