import * as React from 'react';
import type { GenerationJob } from '../../constants/ai-generation';
import {
  isConflictError,
  isFinalRequestError,
  jobFailure,
  rememberJob,
  rememberedJob,
  type GenerationFailure,
} from './generation-job';

export type GenerationJobApi<TForm, TResult> = {
  generate(form: TForm): Promise<GenerationJob<TResult>>;
  job(id: string): Promise<GenerationJob<TResult>>;
  latest(): Promise<GenerationJob<TResult> | null>;
  /** Stops a finished job being recovered on the next load. */
  dismiss?(id: string): Promise<unknown>;
};

export type GenerationJobSettings = {
  /** sessionStorage key for the running job id (one per feature). */
  storageKey: string;
  pollMs: number;
  /** Maps a failed request to the notice the page shows. */
  toFailure(error: unknown): GenerationFailure;
};

/** Consecutive network failures tolerated before asking the admin to reload. */
const MAX_CONNECTION_RETRIES = 20;
const CONNECTION_LOST: GenerationFailure = {
  message: 'Lost connection to the server. The generation may still finish: reload this page to check.',
  problems: [],
  forbidden: false,
};

/**
 * Starts a generation and follows its background job: the POST returns at
 * once and this hook polls GET /jobs/:id until the job finishes. On load it
 * recovers the admin's running or last job, so a reload or new tab keeps the
 * output. Passing network errors are retried; the job is never dropped for one.
 */
export function useGenerationJob<TForm, TResult>(
  api: GenerationJobApi<TForm, TResult>,
  settings: GenerationJobSettings,
) {
  const { storageKey, pollMs, toFailure } = settings;
  const [job, setJob] = React.useState<GenerationJob<TResult> | null>(null);
  const [failure, setFailure] = React.useState<GenerationFailure | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [reconnecting, setReconnecting] = React.useState(true);
  const [restoredInput, setRestoredInput] = React.useState<unknown>(null);
  const [retry, setRetry] = React.useState(0);
  const pollErrors = React.useRef(0);
  const latestPollMs = React.useRef(pollMs);
  latestPollMs.current = pollMs;

  const settle = React.useCallback((next: GenerationJob<TResult>) => {
    pollErrors.current = 0;
    setJob(next);
    if (next.status === 'running') {
      rememberJob(storageKey, next.id);
      return;
    }
    rememberJob(storageKey, null);
    if (next.status === 'failed') setFailure(jobFailure(next));
  }, [storageKey]);

  // Recover the job this tab was following, else the admin's latest one.
  React.useEffect(() => {
    const id = rememberedJob(storageKey);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = async (tries: number): Promise<void> => {
      try {
        const value = id ? await api.job(id) : await api.latest();
        if (!active) return;
        setReconnecting(false);
        // An old failure from an earlier visit is not news on a fresh load.
        if (!value || (!id && value.status === 'failed')) return;
        setRestoredInput(value.input ?? null);
        settle(value);
      } catch (error) {
        if (!active) return;
        const final = isFinalRequestError(error);
        if (!final && tries < MAX_CONNECTION_RETRIES) {
          timer = setTimeout(() => void attempt(tries + 1), latestPollMs.current);
          return;
        }
        setReconnecting(false);
        if (final && id) rememberJob(storageKey, null);
        if (id) setFailure(final ? toFailure(error) : CONNECTION_LOST);
      }
    };
    void attempt(0);
    return () => { active = false; clearTimeout(timer); };
  }, [api, settle, storageKey, toFailure]);

  const running = job?.status === 'running';
  React.useEffect(() => {
    if (!running || !job) return;
    let active = true;
    const timer = setTimeout(() => {
      api.job(job.id)
        .then((value) => { if (active) settle(value); })
        .catch((error) => {
          if (!active) return;
          if (isFinalRequestError(error)) {
            rememberJob(storageKey, null);
            setJob(null);
            setFailure(toFailure(error));
            return;
          }
          pollErrors.current += 1;
          if (pollErrors.current > MAX_CONNECTION_RETRIES) {
            // The id stays remembered so a reload can still recover the job.
            setJob(null);
            setFailure(CONNECTION_LOST);
            return;
          }
          setRetry((value) => value + 1);
        });
    }, pollMs);
    return () => { active = false; clearTimeout(timer); };
  }, [api, job, running, retry, settle, storageKey, pollMs, toFailure]);

  /** Resolves true once the server accepts. A refused submit keeps the current output. */
  const start = React.useCallback(async (form: TForm): Promise<boolean> => {
    setStarting(true); setFailure(null);
    try {
      settle(await api.generate(form));
      return true;
    } catch (error) {
      setFailure(toFailure(error));
      if (isConflictError(error)) {
        // Show the job that is blocking this submit; the notice stays up.
        const current = await api.latest().catch(() => null);
        if (current?.status === 'running') settle(current);
      }
      return false;
    } finally {
      setStarting(false);
    }
  }, [api, settle, toFailure]);

  /** Clears the finished output here and for later page loads. */
  const reset = React.useCallback(async (): Promise<boolean> => {
    setFailure(null);
    try {
      if (job && api.dismiss) await api.dismiss(job.id);
    } catch (error) {
      setFailure(toFailure(error));
      return false;
    }
    rememberJob(storageKey, null);
    setJob(null);
    return true;
  }, [api, job, storageKey, toFailure]);

  return {
    job,
    failure,
    busy: starting || reconnecting || running,
    result: job?.status === 'succeeded' ? job.result ?? null : null,
    recovering: reconnecting,
    restoredInput,
    start,
    reset,
  };
}
