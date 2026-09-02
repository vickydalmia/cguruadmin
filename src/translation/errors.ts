// Translation ERROR MODEL: one typed error for everything the pipeline can
// throw, with the provider-error classification the dispatcher's retry and
// backoff decisions key on. Modeled on the fal.ai template
// (src/utils/deal-image-fal.ts / deal-image-errors.ts) — the other paid
// external API in this codebase.

export type TranslationErrorCode =
  | 'TRANSLATION_NOT_CONFIGURED'
  | 'TRANSLATION_CREDITS_EXHAUSTED'
  | 'TRANSLATION_RATE_LIMITED'
  | 'TRANSLATION_TIMED_OUT'
  | 'TRANSLATION_REJECTED'
  | 'TRANSLATION_MALFORMED_OUTPUT'
  | 'TRANSLATION_QUALITY_GATE_FAILED'
  | 'TRANSLATION_WRITE_REJECTED'
  | 'TRANSLATION_BUDGET_EXCEEDED'
  | 'TRANSLATION_LEASE_LOST'
  | 'TRANSLATION_UNAVAILABLE';

const RETRYABLE: Record<TranslationErrorCode, boolean> = {
  TRANSLATION_NOT_CONFIGURED: false,
  // Retryable across DAYS, not attempts: the dispatcher backs the job off
  // rather than burning attempts while the account stays empty.
  TRANSLATION_CREDITS_EXHAUSTED: true,
  TRANSLATION_RATE_LIMITED: true,
  TRANSLATION_TIMED_OUT: true,
  // The provider judged the request itself invalid — retrying the identical
  // request cannot succeed.
  TRANSLATION_REJECTED: false,
  // Transport envelopes can be transiently malformed or empty. A response
  // with usable text gets the stricter corrective writer/editor path later.
  TRANSLATION_MALFORMED_OUTPUT: true,
  // Never publish a partial or structurally unsafe locale. A completely new
  // writer/editor attempt can succeed, so let the durable queue retry with
  // backoff without waiting for a human language reviewer.
  TRANSLATION_QUALITY_GATE_FAILED: true,
  // The provider already returned billable output, but the locale row was
  // rejected by a deterministic validation/integrity rule. Repeating the same
  // paid call cannot repair the database or content contract.
  TRANSLATION_WRITE_REJECTED: false,
  TRANSLATION_BUDGET_EXCEEDED: true,
  TRANSLATION_LEASE_LOST: true,
  TRANSLATION_UNAVAILABLE: true,
};

export class TranslationError extends Error {
  readonly code: TranslationErrorCode;
  readonly retryable: boolean;
  readonly providerStatus?: number;

  constructor(
    code: TranslationErrorCode,
    options?: { cause?: unknown; detail?: string; providerStatus?: number },
  ) {
    super(options?.detail ? `${code}: ${options.detail}` : code);
    // Assigned manually: the compile target predates the ES2022 Error cause
    // constructor option.
    if (options?.cause !== undefined) {
      (this as any).cause = options.cause;
    }
    this.name = 'TranslationError';
    this.code = code;
    this.retryable = RETRYABLE[code];
    this.providerStatus = options?.providerStatus;
  }
}

/**
 * Map a raw provider/network failure onto the typed model. Status wins over
 * message sniffing; the message patterns mirror classifyFalError so both
 * paid integrations read the same way.
 */
export function classifyProviderError(
  error: unknown,
  status?: number,
  bodyText?: string,
  safeDetail?: string,
): TranslationError {
  if (error instanceof TranslationError) return error;
  const message = [
    error instanceof Error ? error.message : String(error ?? ''),
    bodyText ?? '',
  ]
    .join(' ')
    .toLowerCase();
  // Response bodies are useful for recognizing quota errors, but must not be
  // copied into durable outbox errors or logs: a provider/gateway can echo
  // request content. Callers can supply a deliberately non-sensitive detail.
  const options = {
    cause: error,
    providerStatus: status,
    detail: safeDetail,
  };

  if (
    status === 402 ||
    /insufficient|credit|balance|quota|billing|payment|exhausted|funds/.test(message)
  ) {
    return new TranslationError('TRANSLATION_CREDITS_EXHAUSTED', options);
  }
  if (status === 401 || status === 403) {
    return new TranslationError('TRANSLATION_NOT_CONFIGURED', options);
  }
  if (status === 429 || /rate.?limit|too many requests|overloaded/.test(message)) {
    return new TranslationError('TRANSLATION_RATE_LIMITED', options);
  }
  if (
    (error instanceof Error && error.name === 'AbortError') ||
    /abort|timed?\s*out|timeout/.test(message)
  ) {
    return new TranslationError('TRANSLATION_TIMED_OUT', options);
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return new TranslationError('TRANSLATION_REJECTED', options);
  }
  return new TranslationError('TRANSLATION_UNAVAILABLE', options);
}
