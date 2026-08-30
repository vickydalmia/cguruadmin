export type ProviderCompletion = {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
};

export type ProviderRequest = {
  system: string;
  user: string;
  maxOutputTokens: number;
  signal: AbortSignal;
};

/**
 * One LLM vendor behind one method. Implementations are dumb transports:
 * no retries, no concurrency limits, no JSON parsing — that all lives one
 * layer up so every vendor gets identical behavior.
 */
export type TranslationProvider = {
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderCompletion>;
};
