import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output, zodSchema, type FlexibleSchema } from 'ai';
import type { AdsGeneratorConfig } from './config';
import { ADS_OUTPUT_SCHEMA, type AdsModelOutput } from './prompt/output-schema';

/** One physical OpenAI call. The orchestrator owns repairs, so SDK retries stay off. */
export type CreativeModelCall = (request: { system: string; prompt: string }) => Promise<{
  output: AdsModelOutput;
  inputTokens: number;
  outputTokens: number;
  model: string;
}>;

/**
 * OpenAI stopped without writing the JSON: usually `length` (the output cap,
 * which includes hidden reasoning tokens, ran out) or `content-filter`.
 */
export class AdsModelIncompleteError extends Error {
  constructor(
    readonly finishReason: string,
    readonly outputTokens: number,
    readonly reasoningTokens: number,
  ) {
    super(`OpenAI returned no ad copy (finish reason: ${finishReason}).`);
    this.name = 'AdsModelIncompleteError';
  }
}

// Explicit type: letting TS infer the zod → JSON-schema conversion here hits
// "type instantiation is excessively deep" under this repo's compiler settings.
const OUTPUT_SCHEMA = zodSchema(ADS_OUTPUT_SCHEMA as any) as FlexibleSchema<AdsModelOutput>;

export function createOpenAiCreativeModel(config: AdsGeneratorConfig): CreativeModelCall {
  const openai = createOpenAI({ apiKey: config.apiKey });
  return async ({ system, prompt }) => {
    const result = await generateText({
      model: openai.responses(config.model),
      system,
      prompt,
      output: Output.object<AdsModelOutput>({ schema: OUTPUT_SCHEMA, name: 'couponzguru_search_ads' }),
      maxOutputTokens: config.maxOutputTokens,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(config.timeoutMs),
      providerOptions: {
        openai: {
          // Nothing is kept on OpenAI's side; the brief is not training data.
          store: false,
          strictJsonSchema: true,
          reasoningEffort: config.reasoningEffort,
          systemMessageMode: 'developer',
          forceReasoning: true,
        },
      },
    });
    const outputTokens = Number(result.totalUsage.outputTokens ?? 0);
    // The SDK only parses output for a normal finish (or partial text); read
    // the reason first so a budget/filter stop gets a clear error instead of
    // the SDK's generic NoOutputGeneratedError.
    if (result.finishReason !== 'stop' && !result.text.trim()) {
      throw new AdsModelIncompleteError(
        result.finishReason,
        outputTokens,
        Number(result.totalUsage.outputTokenDetails?.reasoningTokens ?? 0),
      );
    }
    return {
      output: result.output,
      inputTokens: Number(result.totalUsage.inputTokens ?? 0),
      outputTokens,
      model: String(result.response.modelId || config.model),
    };
  };
}
