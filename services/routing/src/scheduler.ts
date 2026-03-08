import pLimit from 'p-limit';
import { ROUTING_CONSTRAINTS } from '@travel-ai/types';

/**
 * Manages the provider call budget and concurrency for a single search request.
 *
 * One ProviderScheduler instance is created per search. It tracks how many
 * provider calls have been issued and gates further calls once
 * maxProviderCallsPerSearch is reached. Concurrency is capped by
 * parallelProviderRequests via p-limit.
 *
 * Budget is counted at scheduling time (not completion time), so a call slot
 * is consumed as soon as schedule() is accepted.
 */
export class ProviderScheduler {
  private callsUsed = 0;
  private readonly maxCalls: number;
  private readonly limiter: ReturnType<typeof pLimit>;

  constructor(
    maxCalls = ROUTING_CONSTRAINTS.maxProviderCallsPerSearch,
    parallelism = ROUTING_CONSTRAINTS.parallelProviderRequests,
  ) {
    this.maxCalls = maxCalls;
    this.limiter = pLimit(parallelism);
  }

  /** How many provider calls can still be scheduled before the budget runs out. */
  budgetRemaining(): number {
    return this.maxCalls - this.callsUsed;
  }

  /**
   * Schedules fn to run under the concurrency limiter.
   *
   * Returns null immediately — without calling fn — if the budget is exhausted.
   * Otherwise consumes one budget unit and returns the result of fn once it
   * completes (which may be after queued calls ahead of it finish).
   */
  async schedule<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.callsUsed >= this.maxCalls) {
      return null;
    }
    this.callsUsed++;
    return this.limiter(fn);
  }
}
