import { randomUUID } from 'node:crypto';
import { ADS_LLM_LIMITS, type AdsGeneratorJob, type AdsGeneratorResult } from '../constants/ads-generator';

/**
 * In-memory background jobs for ad generation. A generation can take minutes
 * (up to 1 + maxRepairAttempts OpenAI calls), longer than the production proxy
 * timeout, so the POST only starts a job and the page polls it.
 *
 * Memory only, like the rate limiter: a restart loses running and finished
 * jobs, and the page then shows "no longer available, generate again".
 * Each admin has at most one running job; a second submit reattaches to it.
 */

type JobRecord = AdsGeneratorJob & { userId: string; finishedAtMs: number | null };

export class AdsJobStore {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(
    private readonly retentionMs: number = ADS_LLM_LIMITS.jobRetentionMs,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  /** The admin's running job, if any. */
  runningFor(userId: string): AdsGeneratorJob | null {
    for (const job of this.jobs.values()) {
      if (job.userId === userId && job.status === 'running') return view(job);
    }
    return null;
  }

  start(userId: string): AdsGeneratorJob {
    this.prune();
    const job: JobRecord = {
      id: this.newId(),
      userId,
      status: 'running',
      attempt: 0,
      maxAttempts: 1 + ADS_LLM_LIMITS.maxRepairAttempts,
      startedAt: new Date(this.now()).toISOString(),
      finishedAtMs: null,
    };
    this.jobs.set(job.id, job);
    return view(job);
  }

  /** A job that is already finished, e.g. a cache hit. */
  finished(userId: string, result: AdsGeneratorResult): AdsGeneratorJob {
    const job = this.start(userId);
    this.succeed(job.id, result);
    return this.get(job.id, userId)!;
  }

  progress(id: string, attempt: number): void {
    const job = this.jobs.get(id);
    if (job?.status === 'running') job.attempt = attempt;
  }

  succeed(id: string, result: AdsGeneratorResult): void {
    this.finish(id, (job) => { job.status = 'succeeded'; job.result = result; });
  }

  fail(id: string, error: { message: string; problems: string[] }): void {
    this.finish(id, (job) => { job.status = 'failed'; job.error = error; });
  }

  /** Only the admin who started a job may read it; anything else looks missing. */
  get(id: string, userId: string): AdsGeneratorJob | null {
    this.prune();
    const job = this.jobs.get(id);
    return job && job.userId === userId ? view(job) : null;
  }

  private finish(id: string, apply: (job: JobRecord) => void): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return;
    apply(job);
    job.finishedAtMs = this.now();
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.finishedAtMs !== null && job.finishedAtMs <= cutoff) this.jobs.delete(id);
    }
  }
}

function view(job: JobRecord): AdsGeneratorJob {
  const { userId: _userId, finishedAtMs: _finishedAtMs, ...rest } = job;
  return { ...rest };
}
