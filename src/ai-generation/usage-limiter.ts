/**
 * In-memory request limits for paid generation: one in-flight request per
 * admin, a per-user hourly cap and an instance-wide daily cap (UTC day).
 * Each feature owns one limiter with caps read from its own env vars.
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
    private readonly limits: UsageLimits,
    private readonly now: () => number = Date.now,
    /** Names the work in messages, e.g. "ad-generation". */
    private readonly label = 'ad-generation',
  ) {}

  /**
   * Reserves a slot for `count` generations, all or none, or returns why not.
   * Call release() when the request ends.
   */
  acquire(userId: string, count = 1): { ok: true } | { ok: false; message: string } {
    const now = this.now();
    this.rollDay(now);
    if (this.inFlight.has(userId)) {
      return { ok: false, message: 'A generation is already running for your account. Wait for it to finish.' };
    }
    if (this.dayCount + count > this.limits.maxRequestsPerDay) {
      const left = Math.max(0, this.limits.maxRequestsPerDay - this.dayCount);
      const detail = count > 1 ? ` ${left} left today; this run needs ${count}.` : '';
      return { ok: false, message: `The daily ${this.label} limit is reached.${detail} Try again tomorrow (UTC).` };
    }
    const recent = (this.userRequests.get(userId) ?? []).filter((at) => now - at < HOUR_MS);
    if (recent.length + count > this.limits.maxRequestsPerUserPerHour) {
      const left = Math.max(0, this.limits.maxRequestsPerUserPerHour - recent.length);
      const detail = count > 1 ? ` ${left} left; this run needs ${count}.` : '';
      return { ok: false, message: `You can generate ${this.limits.maxRequestsPerUserPerHour} times per hour.${detail} Try again later.` };
    }
    for (let i = 0; i < count; i += 1) recent.push(now);
    this.userRequests.set(userId, recent);
    this.dayCount += count;
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
