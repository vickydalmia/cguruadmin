import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError } from 'ai';
import type { AdsGeneratorConfig } from './config';
import { AdsGenerationError } from './generate-ads';
import { AdsModelIncompleteError } from './openai-client';

/** Turns a generation failure into the HTTP status and message the admin sees. */

export type Failure = { status: number; error: string; problems?: string[] };

export type FailureLogger = { warn(message: string): void; error(message: string): void };

export function failure(status: number, error: string, problems?: string[]): Failure {
  return problems?.length ? { status, error, problems } : { status, error };
}

export function toFailure(error: unknown, log: FailureLogger, config: AdsGeneratorConfig): Failure {
  if (error instanceof AdsGenerationError) return failure(error.status, error.message, error.problems);
  if (error instanceof AdsModelIncompleteError) {
    log.warn(
      `[ads-generator] no output: finish ${error.finishReason}, ${error.outputTokens} output tokens ` +
      `(${error.reasoningTokens} reasoning), cap ${config.maxOutputTokens}, effort ${config.reasoningEffort}`,
    );
    if (error.finishReason === 'length') {
      return failure(502,
        `OpenAI used its whole output budget (${error.outputTokens} tokens, ${error.reasoningTokens} on reasoning) ` +
        `before writing the ad. Lower ADS_GENERATOR_REASONING_EFFORT (now ${config.reasoningEffort}) or raise ` +
        `ADS_GENERATOR_MAX_OUTPUT_TOKENS (now ${config.maxOutputTokens}), then restart Strapi.`);
    }
    if (error.finishReason === 'content-filter') return failure(502, 'OpenAI\'s content filter stopped the answer. Check the brief wording.');
    return failure(502, `OpenAI stopped without writing the ad (${error.finishReason}). Try again.`);
  }
  if (NoOutputGeneratedError.isInstance(error)) {
    log.warn(`[ads-generator] no output generated: ${error.message}`);
    return failure(502, 'OpenAI returned no ad copy. Try again.');
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    log.warn('[ads-generator] OpenAI call timed out');
    return failure(504, 'OpenAI took too long to answer. Try again.');
  }
  if (NoObjectGeneratedError.isInstance(error)) {
    log.warn(`[ads-generator] malformed model output: ${error.message}`);
    return failure(502, 'OpenAI returned an unreadable answer. Try again.');
  }
  if (APICallError.isInstance(error)) {
    log.error(`[ads-generator] OpenAI HTTP ${error.statusCode ?? 'error'}: ${error.message}`);
    if (error.statusCode === 429) return failure(429, 'OpenAI rate limit or quota reached. Try again later.');
    if (error.statusCode === 401 || error.statusCode === 403) return failure(503, 'The OpenAI key was rejected. Check the server configuration.');
    return failure(502, 'OpenAI request failed. Try again.');
  }
  log.error(`[ads-generator] unexpected failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return failure(500, 'Ad generation failed unexpectedly.');
}
