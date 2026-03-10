/**
 * Lightweight opt-in debug trace for the routing engine pipeline.
 *
 * Enable by setting TRAVEL_AI_DEBUG=1 before running:
 *
 *   TRAVEL_AI_DEBUG=1 pnpm --filter @travel-ai/routing sample-search
 *
 * When disabled (default), all methods are no-ops — zero meaningful runtime cost.
 * Trace output is written to stderr to keep it separate from structured results
 * on stdout.
 *
 * Uses Date.now() for millisecond-precision step timing — sufficient for
 * pipeline-level profiling (provider I/O, scoring, fallback assembly).
 */

const DEBUG: boolean = process.env['TRAVEL_AI_DEBUG'] === '1';

interface TraceEvent {
  step:       string;
  durationMs: number;
  meta?:      Record<string, unknown>;
}

export class EngineTrace {
  private readonly events: TraceEvent[] = [];
  private stepStart = 0;

  /**
   * Mark the start of a pipeline step. Call before the step's main work begins.
   * No-op when TRAVEL_AI_DEBUG is not set.
   */
  begin(step: string): void {
    if (!DEBUG) return;
    this.stepStart = Date.now();
    process.stderr.write(`[trace] → ${step}\n`);
  }

  /**
   * Mark the end of a pipeline step and record timing + optional metadata.
   * Call immediately after the step's main work completes.
   * No-op when TRAVEL_AI_DEBUG is not set.
   */
  end(step: string, meta?: Record<string, unknown>): void {
    if (!DEBUG) return;
    const durationMs = Date.now() - this.stepStart;
    this.events.push({ step, durationMs, meta });
    const metaStr = meta ? ' ' + JSON.stringify(meta) : '';
    process.stderr.write(`[trace] ✓ ${step} (${durationMs}ms)${metaStr}\n`);
  }

  /**
   * Print a summary table of all recorded steps to stderr.
   * Call once at the end of the pipeline (after ranking, before return).
   * No-op when TRAVEL_AI_DEBUG is not set.
   */
  summary(): void {
    if (!DEBUG) return;
    process.stderr.write('[trace] ─── pipeline summary ───\n');
    for (const e of this.events) {
      const metaStr = e.meta ? ' ' + JSON.stringify(e.meta) : '';
      process.stderr.write(
        `[trace]   ${e.step.padEnd(25)} ${String(e.durationMs).padStart(4)}ms${metaStr}\n`,
      );
    }
  }
}
