// Translation ENV CONFIG. Server-side only — none of these values may ever
// reach the admin bundle or a public response. The subsystem is inert unless
// BOTH the site opts in (site-configuration.translationEnabled +
// translationLocales) AND this env config is complete; a half-configured
// state logs loudly at bootstrap and stays off.

export type TranslationProviderKind =
  | 'openai'
  | 'openai-compatible'
  | 'anthropic';

export const TRANSLATION_REASONING_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type TranslationReasoningEffort =
  (typeof TRANSLATION_REASONING_EFFORTS)[number];

export type TranslationConfig = {
  provider: TranslationProviderKind;
  apiKey: string;
  /**
   * API prefix. Required for openai-compatible (e.g.
   * https://openrouter.ai/api/v1), optional for the official OpenAI and
   * Anthropic providers, where their official API endpoints are the defaults.
   */
  baseUrl: string;
  model: string;
  /** Official OpenAI Responses reasoning level; ignored by other providers. */
  reasoningEffort: TranslationReasoningEffort;
  concurrency: number;
  timeoutMs: number;
  maxAttempts: number;
  /** Per-call output ceiling handed to the provider. */
  maxOutputTokens: number;
  /**
   * Soft cap on total source characters per LLM call; an entry with more
   * translatable text is split into several calls.
   */
  chunkChars: number;
  /**
   * Hard daily spend stop in USD, reserved transactionally in the physical
   * provider-attempt ledger. 0 disables the cap.
   */
  dailyBudgetUsd: number;
  /** USD per million input/output tokens for the configured model. */
  inputCostPerMTok: number;
  outputCostPerMTok: number;
};

function intFromEnv(name: string, fallback: number, minimum = 1): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function floatFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isTranslationProviderKind(
  value: string,
): value is TranslationProviderKind {
  return (
    value === 'openai' ||
    value === 'openai-compatible' ||
    value === 'anthropic'
  );
}

function reasoningEffortFromEnv(): TranslationReasoningEffort | null {
  const value =
    String(process.env.TRANSLATION_REASONING_EFFORT ?? '').trim() || 'none';
  return (TRANSLATION_REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as TranslationReasoningEffort)
    : null;
}

/**
 * Parse the env block. Returns null when the required trio (provider kind,
 * API key, model) is incomplete — the caller decides whether that is an
 * error (site opted in) or the normal inert state (India/USA).
 */
export function translationConfigFromEnv(): TranslationConfig | null {
  const provider = String(process.env.TRANSLATION_PROVIDER ?? '').trim();
  const apiKey = String(process.env.TRANSLATION_API_KEY ?? '').trim();
  const model = String(process.env.TRANSLATION_MODEL ?? '').trim();
  const baseUrl = String(process.env.TRANSLATION_BASE_URL ?? '').trim();

  if (!isTranslationProviderKind(provider)) return null;
  if (!apiKey || !model) return null;
  // openai-compatible has no sane default host — the whole point is that the
  // deployment names its vendor. Official OpenAI and Anthropic have defaults.
  if (provider === 'openai-compatible' && !baseUrl) return null;
  const reasoningEffort = reasoningEffortFromEnv();
  if (provider === 'openai' && !reasoningEffort) return null;

  const dailyBudgetUsd = floatFromEnv('TRANSLATION_DAILY_BUDGET_USD', 0);
  const inputCostPerMTok = floatFromEnv('TRANSLATION_INPUT_COST_PER_MTOK', 0);
  const outputCostPerMTok = floatFromEnv('TRANSLATION_OUTPUT_COST_PER_MTOK', 0);
  // A non-zero cap with missing rates looks safe while actually accounting
  // every call as free. Refuse that configuration instead.
  if (
    dailyBudgetUsd > 0 &&
    (inputCostPerMTok <= 0 || outputCostPerMTok <= 0)
  ) {
    return null;
  }

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    reasoningEffort: reasoningEffort ?? 'none',
    concurrency: intFromEnv('TRANSLATION_CONCURRENCY', 2),
    timeoutMs: intFromEnv('TRANSLATION_TIMEOUT_MS', 120_000, 1_000),
    maxAttempts: intFromEnv('TRANSLATION_MAX_ATTEMPTS', 3),
    maxOutputTokens: intFromEnv('TRANSLATION_MAX_OUTPUT_TOKENS', 8_192, 256),
    chunkChars: intFromEnv('TRANSLATION_CHUNK_CHARS', 12_000, 500),
    dailyBudgetUsd,
    inputCostPerMTok,
    outputCostPerMTok,
  };
}

/** Why the env block does not parse, for the bootstrap log line. */
export function translationConfigProblem(): string | null {
  const provider = String(process.env.TRANSLATION_PROVIDER ?? '').trim();
  if (!provider) return 'TRANSLATION_PROVIDER is not set';
  if (!isTranslationProviderKind(provider)) {
    return `TRANSLATION_PROVIDER must be "openai", "openai-compatible", or "anthropic", got "${provider}"`;
  }
  if (!String(process.env.TRANSLATION_API_KEY ?? '').trim()) {
    return 'TRANSLATION_API_KEY is not set';
  }
  if (!String(process.env.TRANSLATION_MODEL ?? '').trim()) {
    return 'TRANSLATION_MODEL is not set';
  }
  if (
    provider === 'openai-compatible' &&
    !String(process.env.TRANSLATION_BASE_URL ?? '').trim()
  ) {
    return 'TRANSLATION_BASE_URL is required for the openai-compatible provider';
  }
  if (provider === 'openai' && !reasoningEffortFromEnv()) {
    return `TRANSLATION_REASONING_EFFORT must be one of ${TRANSLATION_REASONING_EFFORTS.join(
      ', ',
    )}`;
  }
  const dailyBudgetUsd = floatFromEnv('TRANSLATION_DAILY_BUDGET_USD', 0);
  if (dailyBudgetUsd > 0) {
    if (floatFromEnv('TRANSLATION_INPUT_COST_PER_MTOK', 0) <= 0) {
      return 'TRANSLATION_INPUT_COST_PER_MTOK must be positive when a daily budget is enabled';
    }
    if (floatFromEnv('TRANSLATION_OUTPUT_COST_PER_MTOK', 0) <= 0) {
      return 'TRANSLATION_OUTPUT_COST_PER_MTOK must be positive when a daily budget is enabled';
    }
  }
  return null;
}
