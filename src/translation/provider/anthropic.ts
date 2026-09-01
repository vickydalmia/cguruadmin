// Native Anthropic Messages through AI SDK. Custom base URLs retain the old
// host-level contract: `/v1` is appended unless the operator already supplied
// it, and the SDK appends `/messages`.
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAiSdkCompletionProvider } from './ai-sdk-completion';
import type { TranslationProvider } from './types';

function messagesBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  const base = baseUrl.replace(/\/+$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

export function createAnthropicProvider(options: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  fetchImpl?: typeof fetch;
}): TranslationProvider {
  const baseURL = messagesBaseUrl(options.baseUrl);
  const anthropic = createAnthropic({
    apiKey: options.apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });
  return createAiSdkCompletionProvider({
    name: 'anthropic',
    model: anthropic.messages(options.model),
    configuredModel: options.model,
    temperature: 0.2,
  });
}
