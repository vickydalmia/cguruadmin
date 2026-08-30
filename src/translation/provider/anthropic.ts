// The native Anthropic Messages transport. Kept SDK-free like the
// OpenAI-compatible sibling; TRANSLATION_BASE_URL may override the default
// host for proxies/gateways.
import { classifyProviderError, TranslationError } from '../errors';
import type { ProviderCompletion, ProviderRequest, TranslationProvider } from './types';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';

type AnthropicMessagesResponse = {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export function createAnthropicProvider(options: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  fetchImpl?: typeof fetch;
}): TranslationProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const endpoint = `${base}/v1/messages`;

  return {
    name: 'anthropic',
    async complete(request: ProviderRequest): Promise<ProviderCompletion> {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          signal: request.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': options.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: options.model,
            max_tokens: request.maxOutputTokens,
            temperature: 0.2,
            system: request.system,
            messages: [{ role: 'user', content: request.user }],
          }),
        });
      } catch (error) {
        throw classifyProviderError(error);
      }

      const bodyText = await response.text().catch(() => '');
      if (!response.ok) {
        throw classifyProviderError(
          new Error(`v1/messages returned ${response.status}`),
          response.status,
          bodyText,
        );
      }

      let parsed: AnthropicMessagesResponse;
      try {
        parsed = JSON.parse(bodyText);
      } catch (error) {
        throw new TranslationError('TRANSLATION_MALFORMED_OUTPUT', {
          cause: error,
          detail: 'provider response was not JSON',
        });
      }
      const text = (parsed.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      if (!text.trim()) {
        throw new TranslationError('TRANSLATION_MALFORMED_OUTPUT', {
          detail: 'provider response carried no text content',
        });
      }
      return {
        text,
        inputTokens: Number(parsed.usage?.input_tokens ?? 0),
        outputTokens: Number(parsed.usage?.output_tokens ?? 0),
        model: String(parsed.model ?? options.model),
      };
    },
  };
}
