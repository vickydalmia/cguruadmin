import type { GenerationJob } from '../../constants/ai-generation';

/**
 * React-free helpers for paid generation pages: reading a server failure, and remembering the running job id
 * so a page reload can reconnect to it.
 */

export type GenerationFailure = { message: string; problems: string[]; forbidden: boolean };

/** Server errors are `{ error, problems? }`; a 403 gets the permission hint. */
export function generationFailure(error: unknown, forbiddenMessage: string): GenerationFailure {
  const value = error as { status?: number; message?: string; response?: { status?: number; data?: any } };
  const status = value?.response?.status ?? value?.status;
  const data = value?.response?.data;
  const message = typeof data?.error === 'string'
    ? data.error
    : data?.error?.message ?? value?.message ?? 'The request failed. Try again.';
  return {
    message: status === 403 ? forbiddenMessage : message,
    problems: Array.isArray(data?.problems) ? data.problems.map(String) : [],
    forbidden: status === 403,
  };
}

/** 401, 403 and 404 will not change on retry; anything else may be a passing network error. */
export function isFinalRequestError(error: unknown): boolean {
  const value = error as { status?: number; response?: { status?: number } };
  const status = value?.response?.status ?? value?.status;
  return status === 401 || status === 403 || status === 404;
}

export function isConflictError(error: unknown): boolean {
  const value = error as { status?: number; response?: { status?: number } };
  return (value?.response?.status ?? value?.status) === 409;
}

/** A failed job carries the same `{ message, problems }` the page already shows. */
export function jobFailure(job: GenerationJob<unknown>, fallback = 'Generation failed. Try again.'): GenerationFailure {
  return {
    message: job.error?.message ?? fallback,
    problems: job.error?.problems ?? [],
    forbidden: false,
  };
}

/**
 * The running job's id survives a page reload in this tab. sessionStorage can
 * be unavailable; that only loses the reconnect, never the job.
 */
export function rememberJob(key: string, id: string | null): void {
  try {
    if (id) window.sessionStorage.setItem(key, id);
    else window.sessionStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing to remember.
  }
}

export function rememberedJob(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}
