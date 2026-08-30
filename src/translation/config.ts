// Translation ENV CONFIG. Server-side only — none of these values may ever
// reach the admin bundle or a public response. The subsystem is inert unless
// BOTH the site opts in (site-configuration.translationEnabled +
// translationLocales) AND this env config is complete; a half-configured
// state logs loudly at bootstrap and stays off.

export type TranslationProviderKind = 'openai-compatible' | 'anthropic';

export type TranslationConfig = {
  provider: TranslationProviderKind;
  apiKey: string;
  /**
   * Chat-completions base URL for the openai-compatible provider (e.g.
   * https://api.openai.com/v1, https://openrouter.ai/api/v1, or any
   * OpenAI-compatible gateway). Ignored by the anthropic provider unless set,
   * where it overrides https://api.anthropic.com.
   */
  baseUrl: string;
  model: string;
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

  if (provider !== 'openai-compatible' && provider !== 'anthropic') return null;
  if (!apiKey || !model) return null;
  // openai-compatible has no sane default host — the whole point is that the
  // deployment names its vendor. Anthropic has exactly one.
  if (provider === 'openai-compatible' && !baseUrl) return null;

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
  if (provider !== 'openai-compatible' && provider !== 'anthropic') {
    return `TRANSLATION_PROVIDER must be "openai-compatible" or "anthropic", got "${provider}"`;
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
