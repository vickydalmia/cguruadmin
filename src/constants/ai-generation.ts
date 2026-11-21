/**
 * Shared contract for paid OpenAI features that run as background jobs
 * (such as Settings → Ads Generator). Imported by the
 * server and the admin panel, so it must stay free of server-only imports.
 *
 * The POST that starts a generation answers at once with a running job and
 * the page polls GET /jobs/:id, so no proxy timeout can cut a long call.
 * `attempt` counts OpenAI calls made so far, up to `maxAttempts`.
 */
export type GenerationJob<TResult> = {
  id: string;
  status: 'running' | 'succeeded' | 'failed';
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  /** True when the submit reattached to a job that was already running. */
  reattached?: boolean;
  /** The submitted form, returned to its owner so a reload can refill the page. */
  input?: unknown;
  result?: TResult;
  error?: { message: string; problems: string[] };
};
