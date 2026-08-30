// The OpenAI-compatible chat-completions transport. One configurable base
// URL covers OpenAI, OpenRouter, Groq, DeepSeek, Gemini's OpenAI-compat
// endpoint, and any self-hosted gateway — which is what makes the subsystem
// provider-agnostic without an SDK dependency per vendor.
import { classifyProviderError, TranslationError } from '../errors';
import type { ProviderCompletion, ProviderRequest, TranslationProvider } from './types';

type OpenAiChatResponse = {
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export function createOpenAiCompatibleProvider(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
}): TranslationProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    name: 'openai-compatible',
    async complete(request: ProviderRequest): Promise<ProviderCompletion> {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          signal: request.signal,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: request.maxOutputTokens,
            // Deterministic-ish output: translation wants faithfulness, not
            // creative variance between retries.
            temperature: 0.2,
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.user },
            ],
          }),
        });
      } catch (error) {
        throw classifyProviderError(error);
      }

      const bodyText = await response.text().catch(() => '');
      if (!response.ok) {
        throw classifyProviderError(
          new Error(`chat/completions returned ${response.status}`),
          response.status,
          bodyText,
        );
      }

      let parsed: OpenAiChatResponse;
      try {
        parsed = JSON.parse(bodyText);
      } catch (error) {
        throw new TranslationError('TRANSLATION_MALFORMED_OUTPUT', {
          cause: error,
          detail: 'provider response was not JSON',
        });
      }
      const text = parsed.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) {
        throw new TranslationError('TRANSLATION_MALFORMED_OUTPUT', {
          detail: 'provider response carried no message content',
        });
      }
      return {
        text,
        inputTokens: Number(parsed.usage?.prompt_tokens ?? 0),
        outputTokens: Number(parsed.usage?.completion_tokens ?? 0),
        model: String(parsed.model ?? options.model),
      };
    },
  };
}
