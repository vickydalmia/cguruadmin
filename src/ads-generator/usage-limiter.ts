import { ADS_LLM_LIMITS } from '../constants/ads-generator';

/**
 * In-memory request limits for paid generation: one in-flight request per
 * admin, a per-user hourly cap and an instance-wide daily cap (UTC day).
 * The caps come from env via readAdsUsageLimits() (./config.ts).
 *
 * Memory only, by decision: nothing is stored in Strapi. A restart resets the
 * counters, so also set a hard monthly budget on the OpenAI project as the
 * real spend backstop.
 */

const HOUR_MS = 60 * 60_000;

export type UsageLimits = {
  maxRequestsPerUserPerHour: number;
  maxRequestsPerDay: number;
};

export class UsageLimiter {
  private readonly userRequests = new Map<string, number[]>();
  private readonly inFlight = new Set<string>();
  private day = '';
  private dayCount = 0;

  constructor(
    private readonly limits: UsageLimits = ADS_LLM_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Reserves a slot or returns why not. Call release() when the request ends. */
  acquire(userId: string): { ok: true } | { ok: false; message: string } {
    const now = this.now();
    this.rollDay(now);
    if (this.inFlight.has(userId)) {
      return { ok: false, message: 'A generation is already running for your account. Wait for it to finish.' };
    }
    if (this.dayCount >= this.limits.maxRequestsPerDay) {
      return { ok: false, message: 'The daily ad-generation limit is reached. Try again tomorrow (UTC).' };
    }
    const recent = (this.userRequests.get(userId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length >= this.limits.maxRequestsPerUserPerHour) {
      return { ok: false, message: `You can generate ${this.limits.maxRequestsPerUserPerHour} times per hour. Try again later.` };
    }
    recent.push(now);
    this.userRequests.set(userId, recent);
    this.dayCount += 1;
    this.inFlight.add(userId);
    return { ok: true };
  }

  release(userId: string): void {
    this.inFlight.delete(userId);
  }

  private rollDay(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dayCount = 0;
    }
  }
}
