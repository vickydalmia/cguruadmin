import { randomUUID } from 'node:crypto';
import type { GenerationJob } from '../constants/ai-generation';

/**
 * In-memory background jobs for paid generation. A generation can take
 * minutes, longer than the production proxy timeout, so the POST only starts
 * a job and the page polls it.
 *
 * Memory only, like the rate limiter: a restart loses running and finished
 * jobs, and the page then shows "no longer available, generate again".
 * Each admin has at most one running job per store (one store per feature);
 * the same request reattaches to it, and a different one is refused.
 */

type JobRecord<TResult> = GenerationJob<TResult> & { userId: string; finishedAtMs: number | null; requestKey?: string; dismissed?: boolean };

/** What was asked for: the key tells a retry from a different brief. */
export type JobRequest = { requestKey?: string; input?: unknown };

export type JobStoreOptions = {
  /** How long a finished job (and its result) stays readable. */
  retentionMs: number;
  /** OpenAI calls one job may make; shown as "call n of max". */
  maxAttempts: number;
  now?: () => number;
  newId?: () => string;
};

export class JobStore<TResult> {
  private readonly jobs = new Map<string, JobRecord<TResult>>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: JobStoreOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
  }

  /** The admin's running job, if any. */
  runningFor(userId: string): GenerationJob<TResult> | null {
    for (const job of this.jobs.values()) {
      if (job.userId === userId && job.status === 'running') return view(job);
    }
    return null;
  }

  /** True when the job was started for exactly this request. */
  isSameRequest(id: string, requestKey: string): boolean {
    return this.jobs.get(id)?.requestKey === requestKey;
  }

  /** The admin's running job, else their most recently started one. */
  latestFor(userId: string): GenerationJob<TResult> | null {
    this.prune();
    const running = this.runningFor(userId);
    if (running) return running;
    let latest: JobRecord<TResult> | null = null;
    for (const job of this.jobs.values()) if (job.userId === userId) latest = job;
    // A dismissed latest job means "start fresh": older runs must not come back.
    return latest && !latest.dismissed ? view(latest) : null;
  }

  start(userId: string, request: JobRequest = {}): GenerationJob<TResult> {
    this.prune();
    const job: JobRecord<TResult> = {
      id: this.newId(),
      userId,
      status: 'running',
      attempt: 0,
      maxAttempts: this.options.maxAttempts,
      startedAt: new Date(this.now()).toISOString(),
      finishedAtMs: null,
      ...(request.requestKey === undefined ? {} : { requestKey: request.requestKey }),
      ...(request.input === undefined ? {} : { input: request.input }),
    };
    this.jobs.set(job.id, job);
    return view(job);
  }

  /** A job that is already finished, e.g. a cache hit. */
  finished(userId: string, result: TResult, request: JobRequest = {}): GenerationJob<TResult> {
    const job = this.start(userId, request);
    this.succeed(job.id, result);
    return this.get(job.id, userId)!;
  }

  progress(id: string, attempt: number): void {
    const job = this.jobs.get(id);
    if (job?.status === 'running') job.attempt = attempt;
  }

  /** Publishes partial output while the job is still running. */
  update(id: string, result: TResult): void {
    const job = this.jobs.get(id);
    if (job?.status === 'running') job.result = result;
  }

  succeed(id: string, result: TResult): void {
    this.finish(id, (job) => { job.status = 'succeeded'; job.result = result; });
  }

  fail(id: string, error: { message: string; problems: string[] }): void {
    this.finish(id, (job) => { job.status = 'failed'; job.error = error; });
  }

  /** Stops a finished job being recovered on load. False if it is missing or running. */
  dismiss(id: string, userId: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.userId !== userId || job.status === 'running') return false;
    job.dismissed = true;
    return true;
  }

  /** Only the admin who started a job may read it; anything else looks missing. */
  get(id: string, userId: string): GenerationJob<TResult> | null {
    this.prune();
    const job = this.jobs.get(id);
    return job && job.userId === userId ? view(job) : null;
  }

  private finish(id: string, apply: (job: JobRecord<TResult>) => void): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return;
    apply(job);
    job.finishedAtMs = this.now();
  }

  private prune(): void {
    const cutoff = this.now() - this.options.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.finishedAtMs !== null && job.finishedAtMs <= cutoff) this.jobs.delete(id);
    }
  }
}

function view<TResult>(job: JobRecord<TResult>): GenerationJob<TResult> {
  const { userId: _userId, finishedAtMs: _finishedAtMs, requestKey: _requestKey, dismissed: _dismissed, ...rest } = job;
  return { ...rest };
}
