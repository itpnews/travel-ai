'use client';

import { useState } from 'react';
import type { Route, SearchResult } from '@travel-ai/types';
import { SearchForm, type SearchInput } from '@/components/SearchForm';
import { RouteCard } from '@/components/RouteCard';
import { SortPills, type SortKey } from '@/components/SortPills';
import { ResultsSummary } from '@/components/ResultsSummary';
import { SkeletonCard } from '@/components/SkeletonCard';
import { DemoNotice } from '@/components/DemoNotice';

// ─── State ────────────────────────────────────────────────────────────────────

type SearchState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; result: SearchResult; refreshedAt: Date; isDemoMode: boolean }
  | { phase: 'error'; message: string };

// ─── Sort ─────────────────────────────────────────────────────────────────────

function sortRoutes(routes: Route[], sort: SortKey): Route[] {
  const copy = [...routes];
  switch (sort) {
    case 'cheapest': return copy.sort((a, b) => a.totalPrice - b.totalPrice);
    case 'fastest':  return copy.sort((a, b) => a.totalDurationMinutes - b.totalDurationMinutes);
    case 'safest':   return copy.sort((a, b) => b.safeScore - a.safeScore);
    case 'best':
    default:         return copy.sort((a, b) => b.score - a.score);
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const [state, setState] = useState<SearchState>({ phase: 'idle' });
  const [sort, setSort]   = useState<SortKey>('best');

  async function handleSearch(input: SearchInput) {
    setState({ phase: 'loading' });

    try {
      const res = await fetch('/api/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(input),
      });

      const isDemoMode = res.headers.get('X-Demo-Mode') === 'true';
      const result: SearchResult = await res.json();

      if (result.errors && result.errors.length > 0 && result.routes.length === 0) {
        setState({ phase: 'error', message: result.errors[0]?.message ?? 'Search failed.' });
        return;
      }

      setSort('best');
      setState({ phase: 'done', result, refreshedAt: new Date(), isDemoMode });
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'An unexpected error occurred.',
      });
    }
  }

  const isDemoMode  = state.phase === 'done' && state.isDemoMode;
  const isLoading   = state.phase === 'loading';

  return (
    <div className="app-shell">

      {/* ── Sticky header ─────────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="header-inner">
          <div className="header-brand">
            <span className="header-logo">✈</span>
            <span className="header-title">Travel AI</span>
          </div>
          <SearchForm onSearch={handleSearch} loading={isLoading} />
        </div>
        {isDemoMode && <DemoNotice />}
      </header>

      {/* ── Page body ─────────────────────────────────────────────────────── */}
      <main className="main">

        {/* Idle */}
        {state.phase === 'idle' && (
          <div className="state-box">
            <div className="state-icon">🗺</div>
            <p className="state-title">Search for a route to get started</p>
            <p className="state-sub">Enter an origin and destination using 3-letter IATA codes (e.g. LHR, JFK, CDG).</p>
          </div>
        )}

        {/* Loading — shimmer skeletons */}
        {isLoading && (
          <div className="results-list">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {/* Error */}
        {state.phase === 'error' && (
          <div className="error-box">
            <strong>Search failed:</strong> {state.message}
          </div>
        )}

        {/* Results */}
        {state.phase === 'done' && (
          <>
            {state.result.routes.length === 0 ? (
              <div className="state-box">
                <div className="state-icon">🔍</div>
                <p className="state-title">No routes found</p>
                <p className="state-sub">
                  No viable routes were found for {state.result.params.origin} → {state.result.params.destination}{' '}
                  on {state.result.params.departureDate}.
                </p>
              </div>
            ) : (
              <>
                <div className="results-controls">
                  <ResultsSummary result={state.result} refreshedAt={state.refreshedAt} />
                  <SortPills active={sort} onChange={setSort} />
                </div>
                <div className="results-list">
                  {sortRoutes(state.result.routes, sort).map((route, i) => (
                    <RouteCard key={route.id} route={route} rank={i + 1} />
                  ))}
                </div>
              </>
            )}
          </>
        )}

      </main>
    </div>
  );
}
