// Provider FACTORY + the shared call discipline: process-wide concurrency
// slots, per-attempt timeout, and classified exponential-backoff retries.
// Vendors stay dumb transports; every behavior an operator can observe
// (retry counts, slot limits, timeouts) is identical across vendors.
import type { TranslationConfig } from '../config';
import { classifyProviderError, TranslationError } from '../errors';
import type { ProviderCompletion, TranslationProvider } from './types';

export type CompletionAttemptContext = {
  attempt: number;
  system: string;
  user: string;
  maxOutputTokens: number;
};

export type CompletionAttemptHooks = {
  /** Reserve budget immediately before a physical provider request. */
  beforeAttempt?(context: CompletionAttemptContext): Promise<unknown>;
  /** Settle that reservation for both successful and uncertain attempts. */
  afterAttempt?(
    context: CompletionAttemptContext & {
      reservation: unknown;
      completion?: ProviderCompletion;
      error?: TranslationError;
    },
  ): Promise<void>;
};

export function createTranslationProvider(
  config: TranslationConfig,
  fetchImpl?: typeof fetch,
): TranslationProvider {
  // SDK packages are intentionally lazy: sites with translation disabled do
  // not pay their startup/memory cost, and an enabled site loads one vendor,
  // not all three. Provider construction happens once when the dispatcher starts.
  if (config.provider === 'anthropic') {
    const { createAnthropicProvider } = require('./anthropic') as typeof import(
      './anthropic'
    );
    return createAnthropicProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || undefined,
      model: config.model,
      fetchImpl,
    });
  }
  if (config.provider === 'openai') {
    const { createOpenAiProvider } = require('./openai') as typeof import(
      './openai'
    );
    return createOpenAiProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || undefined,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      fetchImpl,
    });
  }
  const { createOpenAiCompatibleProvider } = require(
    './openai-compatible'
  ) as typeof import('./openai-compatible');
  return createOpenAiCompatibleProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    fetchImpl,
  });
}

// Process-wide slots, clone of withFalSlot (src/utils/deal-image-fal.ts):
// the ceiling applies across every concurrent job the dispatcher runs.
let activeRequests = 0;
let waiters: Array<() => void> = [];
let configuredConcurrency = 2;

export function configureTranslationConcurrency(limit: number): void {
  configuredConcurrency = Math.min(2, Math.max(1, limit));
}

async function withTranslationSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeRequests >= configuredConcurrency) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  } else {
    activeRequests += 1;
  }
  try {
    return await operation();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else activeRequests -= 1;
  }
}

/** Test hook: drop queued waiters so suites can't leak across cases. */
export function resetTranslationSlotsForTest(): void {
  activeRequests = 0;
  waiters = [];
}

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * One logical completion: slot → timeout → classified retries. Non-retryable
 * classifications (NOT_CONFIGURED, REJECTED) surface immediately; transient
 * malformed envelopes and transport failures back off 250ms → 4s, capped by
 * maxAttempts.
 */
export async function completeWithRetry(
  provider: TranslationProvider,
  config: Pick<TranslationConfig, 'timeoutMs' | 'maxAttempts' | 'maxOutputTokens'>,
  prompt: { system: string; user: string },
  hooks?: CompletionAttemptHooks,
): Promise<ProviderCompletion> {
  let lastError: TranslationError | null = null;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    const context: CompletionAttemptContext = {
      attempt,
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: config.maxOutputTokens,
    };
    let reservation: unknown;
    let completion: ProviderCompletion;
    try {
      completion = await withTranslationSlot(async () => {
        reservation = await hooks?.beforeAttempt?.(context);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
          return await provider.complete({
            system: prompt.system,
            user: prompt.user,
            maxOutputTokens: config.maxOutputTokens,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch (error) {
      lastError =
        error instanceof TranslationError ? error : classifyProviderError(error);
      if (reservation !== undefined) {
        await hooks?.afterAttempt?.({
          ...context,
          reservation,
          error: lastError,
        });
      }
      if (
        !lastError.retryable ||
        lastError.code === 'TRANSLATION_BUDGET_EXCEEDED' ||
        attempt === config.maxAttempts
      ) {
        throw lastError;
      }
      await wait(Math.min(4_000, 250 * 2 ** (attempt - 1)));
      continue;
    }
    // Ledger failures surface to the job without repeating a provider call
    // whose output and billing may already exist.
    await hooks?.afterAttempt?.({ ...context, reservation, completion });
    return completion;
  }
  throw lastError ?? new TranslationError('TRANSLATION_UNAVAILABLE');
}
