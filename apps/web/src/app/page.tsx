'use client';

import { useState } from 'react';
import type { Route } from '@travel-ai/types';
import { SearchForm, type SearchInput } from '@/components/SearchForm';
import { RouteCard } from '@/components/RouteCard';
import { SortPills, type SortKey } from '@/components/SortPills';
import { ResultsSummary } from '@/components/ResultsSummary';
import { SkeletonCard } from '@/components/SkeletonCard';
import { DemoNotice } from '@/components/DemoNotice';
import { DateStrip } from '@/components/DateStrip';
import type { FlexSearchResult } from '@/lib/flex-search';

// ─── State ────────────────────────────────────────────────────────────────────

type SearchState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'done'; result: FlexSearchResult; refreshedAt: Date; isDemoMode: boolean }
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
  const [state, setState]             = useState<SearchState>({ phase: 'idle' });
  const [sort, setSort]               = useState<SortKey>('best');
  const [selectedDate, setSelectedDate] = useState<string>('');

  async function handleSearch(input: SearchInput) {
    setState({ phase: 'loading' });

    try {
      const res = await fetch('/api/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(input),
      });

      const isDemoMode = res.headers.get('X-Demo-Mode') === 'true';
      const result: FlexSearchResult = await res.json();

      // Top-level validation errors (no dateOptions at all)
      if (result.errors && result.errors.length > 0 && result.dateOptions.length === 0) {
        setState({ phase: 'error', message: result.errors[0]?.message ?? 'Search failed.' });
        return;
      }

      setSort('best');
      setSelectedDate(result.selectedDate);
      setState({ phase: 'done', result, refreshedAt: new Date(), isDemoMode });
    } catch (err) {
      setState({
        phase: 'error',
        message: err instanceof Error ? err.message : 'An unexpected error occurred.',
      });
    }
  }

  function handleDateSelect(date: string) {
    setSelectedDate(date);
    setSort('best');
  }

  const isDemoMode = state.phase === 'done' && state.isDemoMode;
  const isLoading  = state.phase === 'loading';

  // Current date's SearchResult (switches client-side on date strip click)
  const currentResult =
    state.phase === 'done' ? state.result.resultsByDate[selectedDate] : null;
  const currentRoutes = currentResult?.routes ?? [];

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
            {/* Date strip — always visible when results are loaded */}
            <DateStrip
              options={state.result.dateOptions}
              selectedDate={selectedDate}
              onSelect={handleDateSelect}
            />

            {/* No routes for selected date */}
            {currentRoutes.length === 0 ? (
              <div className="state-box">
                <div className="state-icon">🔍</div>
                <p className="state-title">No flights on this date</p>
                <p className="state-sub">
                  No routes found for {currentResult?.params.origin ?? '?'} → {currentResult?.params.destination ?? '?'} on {selectedDate}.
                  Try a nearby date above.
                </p>
              </div>
            ) : (
              <>
                <div className="results-controls">
                  {currentResult && (
                    <ResultsSummary result={currentResult} refreshedAt={state.refreshedAt} />
                  )}
                  <SortPills active={sort} onChange={setSort} />
                </div>
                <div className="results-list">
                  {sortRoutes(currentRoutes, sort).map((route, i) => (
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
