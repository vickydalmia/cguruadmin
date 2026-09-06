// Shared AI SDK transport adapter. Retry, concurrency, timeouts, budgets and
// translation-output validation deliberately remain in the existing layers;
// each physical SDK call is single-attempt and returns normalized usage only.
import {
  APICallError,
  EmptyResponseBodyError,
  generateText,
  InvalidResponseDataError,
  JSONParseError,
  type JSONValue,
  type LanguageModel,
  NoContentGeneratedError,
} from 'ai';
import { classifyProviderError, TranslationError } from '../errors';
import type {
  ProviderCompletion,
  ProviderRequest,
  TranslationProvider,
} from './types';

function isMalformedResponseError(error: unknown): boolean {
  return (
    EmptyResponseBodyError.isInstance(error) ||
    InvalidResponseDataError.isInstance(error) ||
    JSONParseError.isInstance(error) ||
    NoContentGeneratedError.isInstance(error)
  );
}

export function createAiSdkCompletionProvider(options: {
  name: string;
  model: LanguageModel;
  configuredModel: string;
  temperature?: number;
  providerOptions?: Record<string, Record<string, JSONValue>>;
}): TranslationProvider {
  return {
    name: options.name,
    async complete(request: ProviderRequest): Promise<ProviderCompletion> {
      try {
        const result = await generateText({
          model: options.model,
          system: request.system,
          prompt: request.user,
          maxOutputTokens: request.maxOutputTokens,
          // The translation pipeline owns retries and charges every physical
          // attempt in its ledger. SDK-level retries would bypass both.
          maxRetries: 0,
          abortSignal: request.signal,
          ...(options.temperature === undefined
            ? {}
            : { temperature: options.temperature }),
          ...(options.providerOptions
            ? { providerOptions: options.providerOptions }
            : {}),
        });
        if (!result.text.trim()) {
          throw new TranslationError('TRANSLATION_MALFORMED_OUTPUT', {
            detail: 'provider response carried no text content',
          });
        }
        return {
          text: result.text,
          inputTokens: Number(result.totalUsage.inputTokens ?? 0),
          outputTokens: Number(result.totalUsage.outputTokens ?? 0),
          model: String(result.response.modelId || options.configuredModel),
        };
      } catch (error) {
        if (error instanceof TranslationError) throw error;
        if (isMalformedResponseError(error)) {
          throw new TranslationError('TRANSLATION_MALFORMED_OUTPUT', {
            cause: error,
            detail: 'provider response could not be parsed',
          });
        }
        if (APICallError.isInstance(error)) {
          // Provider-utils wraps invalid JSON/schema bodies in APICallError,
          // preserving the successful HTTP status and parse error as its cause.
          if (
            error.statusCode !== undefined &&
            error.statusCode >= 200 &&
            error.statusCode < 300
          ) {
            throw new TranslationError('TRANSLATION_MALFORMED_OUTPUT', {
              cause: error,
              detail: 'provider response could not be parsed',
            });
          }
          throw classifyProviderError(
            error,
            error.statusCode,
            error.responseBody,
            error.statusCode
              ? `provider request failed with status ${error.statusCode}`
              : 'provider request failed',
          );
        }
        throw classifyProviderError(error);
      }
    },
  };
}
