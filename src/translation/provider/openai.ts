// Official OpenAI Responses adapter. Reasoning-capable models such as
// gpt-5.6-luna receive Responses-native options and never Chat Completions
// parameters such as temperature or max_tokens.
import {
  createOpenAI,
  type OpenAILanguageModelResponsesOptions,
} from '@ai-sdk/openai';
import type { TranslationReasoningEffort } from '../config';
import { createAiSdkCompletionProvider } from './ai-sdk-completion';
import type { TranslationProvider } from './types';

export function createOpenAiProvider(options: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  reasoningEffort: TranslationReasoningEffort;
  fetchImpl?: typeof fetch;
}): TranslationProvider {
  const openai = createOpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl ? { baseURL: options.baseUrl.replace(/\/+$/, '') } : {}),
    ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
  });
  const responseOptions = {
    reasoningEffort: options.reasoningEffort,
    store: false,
    systemMessageMode: 'developer',
    // Ensure an unrecognized future reasoning model is still sent the
    // Responses reasoning controls instead of relying on SDK model tables.
    forceReasoning: true,
  } satisfies OpenAILanguageModelResponsesOptions;

  return createAiSdkCompletionProvider({
    name: 'openai',
    model: openai.responses(options.model),
    configuredModel: options.model,
    providerOptions: { openai: responseOptions },
  });
}
