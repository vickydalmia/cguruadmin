// OpenAI-compatible Chat Completions through AI SDK. This remains the generic
// route for OpenRouter, Groq, DeepSeek, Gemini-compatible and private gateways;
// official OpenAI Responses uses the separate `openai` provider.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAiSdkCompletionProvider } from './ai-sdk-completion';
import type { TranslationProvider } from './types';

export function createOpenAiCompatibleProvider(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}): TranslationProvider {
  const provider = createOpenAICompatible({
    name: 'translation-openai-compatible',
    apiKey: options.apiKey,
    baseURL: options.baseUrl.replace(/\/+$/, ''),
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });
  return createAiSdkCompletionProvider({
    name: 'openai-compatible',
    model: provider.chatModel(options.model),
    configuredModel: options.model,
    // Deterministic-ish output: translation wants faithfulness, not creative
    // variance between retries. Official reasoning models intentionally omit it.
    temperature: 0.2,
  });
}
