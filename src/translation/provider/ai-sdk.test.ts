import { describe, expect, it, vi } from 'vitest';
import { TranslationError } from '../errors';
import { createAnthropicProvider } from './anthropic';
import { createOpenAiProvider } from './openai';
import { createOpenAiCompatibleProvider } from './openai-compatible';

const request = () => ({
  system: 'Translate faithfully.',
  user: '{"title":"Hello"}',
  maxOutputTokens: 321,
  signal: new AbortController().signal,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AI SDK translation providers', () => {
  it('uses OpenAI Responses and sends Luna reasoning controls', async () => {
    let endpoint = '';
    let payload: any;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      endpoint = String(input);
      payload = JSON.parse(String(init?.body));
      return jsonResponse({
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        status: 'completed',
        model: 'gpt-5.6-luna-2026-08-01',
        output: [
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: '{"title":"مرحبا"}',
                annotations: [],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 12,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 20,
        },
      });
    }) as typeof fetch;
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      baseUrl: 'https://openai.example/v1/',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      fetchImpl,
    });

    await expect(provider.complete(request())).resolves.toEqual({
      text: '{"title":"مرحبا"}',
      inputTokens: 12,
      outputTokens: 8,
      model: 'gpt-5.6-luna-2026-08-01',
    });
    expect(endpoint).toBe('https://openai.example/v1/responses');
    expect(payload).toMatchObject({
      model: 'gpt-5.6-luna',
      max_output_tokens: 321,
      reasoning: { effort: 'low' },
      store: false,
    });
    expect(payload).not.toHaveProperty('temperature');
    expect(payload).not.toHaveProperty('max_tokens');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('uses native Anthropic Messages and preserves host-level base URLs', async () => {
    let endpoint = '';
    let payload: any;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      endpoint = String(input);
      payload = JSON.parse(String(init?.body));
      return jsonResponse({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20260901',
        content: [{ type: 'text', text: '{"title":"مرحبا"}' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 7 },
      });
    }) as typeof fetch;
    const provider = createAnthropicProvider({
      apiKey: 'test-key',
      baseUrl: 'https://anthropic.example/',
      model: 'claude-sonnet-4-5',
      fetchImpl,
    });

    await expect(provider.complete(request())).resolves.toMatchObject({
      text: '{"title":"مرحبا"}',
      inputTokens: 10,
      outputTokens: 7,
      model: 'claude-sonnet-4-5-20260901',
    });
    expect(endpoint).toBe('https://anthropic.example/v1/messages');
    expect(payload).toMatchObject({
      model: 'claude-sonnet-4-5',
      max_tokens: 321,
      temperature: 0.2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps generic OpenAI-compatible models on Chat Completions', async () => {
    let endpoint = '';
    let payload: any;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      endpoint = String(input);
      payload = JSON.parse(String(init?.body));
      return jsonResponse({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        created: 1,
        model: 'vendor-model-v2',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '{"title":"مرحبا"}' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15 },
      });
    }) as typeof fetch;
    const provider = createOpenAiCompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://gateway.example/v1/',
      model: 'vendor-model',
      fetchImpl,
    });

    await expect(provider.complete(request())).resolves.toMatchObject({
      text: '{"title":"مرحبا"}',
      inputTokens: 9,
      outputTokens: 6,
      model: 'vendor-model-v2',
    });
    expect(endpoint).toBe('https://gateway.example/v1/chat/completions');
    expect(payload).toMatchObject({
      model: 'vendor-model',
      max_tokens: 321,
      temperature: 0.2,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('disables SDK retries and redacts provider response bodies', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { message: 'rate limit reached; sensitive-response-copy' } },
        429,
      ),
    ) as typeof fetch;
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'none',
      fetchImpl,
    });

    const error = await provider.complete(request()).catch((cause) => cause);
    expect(error).toBeInstanceOf(TranslationError);
    expect(error).toMatchObject({
      code: 'TRANSLATION_RATE_LIMITED',
      providerStatus: 429,
    });
    expect(error.message).not.toContain('sensitive-response-copy');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps provider authentication failures onto the existing taxonomy', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { message: 'invalid key; sensitive-response-copy' } },
        401,
      ),
    ) as typeof fetch;
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'none',
      fetchImpl,
    });

    const error = await provider.complete(request()).catch((cause) => cause);
    expect(error).toMatchObject({
      code: 'TRANSLATION_NOT_CONFIGURED',
      retryable: false,
      providerStatus: 401,
    });
    expect(error.message).not.toContain('sensitive-response-copy');
  });

  it('keeps aborts in the existing timeout category', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    }) as typeof fetch;
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'none',
      fetchImpl,
    });

    await expect(provider.complete(request())).rejects.toMatchObject({
      code: 'TRANSLATION_TIMED_OUT',
      retryable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('classifies malformed provider envelopes without publishing them', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as typeof fetch;
    const provider = createOpenAiProvider({
      apiKey: 'test-key',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'none',
      fetchImpl,
    });

    await expect(provider.complete(request())).rejects.toMatchObject({
      code: 'TRANSLATION_MALFORMED_OUTPUT',
      retryable: true,
    });
  });
});
