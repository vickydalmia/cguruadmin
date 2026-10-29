import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError } from 'ai';
import {
  ADS_ACCOUNT_CURRENCY,
  ADS_FORM_LIMITS,
  ADS_PROMPT_VERSION,
  type AdsGeneratorOptions,
  type AdsGeneratorResult,
} from '../constants/ads-generator';
import { readAdsDebugLogging, readAdsGeneratorConfig, readAdsUsageLimits, type AdsGeneratorConfig } from './config';
import { parseAdsForm } from './form';
import { AdsGenerationError, generateAds } from './generate-ads';
import { AdsModelIncompleteError, createOpenAiCreativeModel, type CreativeModelCall } from './openai-client';
import { checkRelevance } from './relevance-gate';
import { ResultCache } from './result-cache';
import { UsageLimiter } from './usage-limiter';

/**
 * The request pipeline, in the order that keeps cost at zero for anything
 * that is not a valid, relevant, allowed brief:
 *   parse form → relevance gate → configured? → cache hit? → rate limit → OpenAI.
 */

export type ServiceResponse =
  | { status: 200; body: AdsGeneratorResult }
  | { status: number; body: { error: string; problems?: string[] } };

type Logger = {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type AdsGeneratorDeps = {
  config: AdsGeneratorConfig | null;
  createModel: (config: AdsGeneratorConfig) => CreativeModelCall;
  limiter: UsageLimiter;
  cache: ResultCache;
  log: Logger;
  /** Log full prompts and responses (ADS_GENERATOR_DEBUG_LOG=true). */
  debugLogging?: boolean;
};

export function createAdsGeneratorService(deps: AdsGeneratorDeps) {
  const model = deps.config ? deps.createModel(deps.config) : null;

  return {
    options(): AdsGeneratorOptions {
      return {
        configured: Boolean(deps.config),
        currency: ADS_ACCOUNT_CURRENCY,
        promptVersion: ADS_PROMPT_VERSION,
        limits: ADS_FORM_LIMITS,
      };
    },

    async generate(body: unknown, userId: string): Promise<ServiceResponse> {
      const parsed = parseAdsForm(body);
      // `in` narrowing: boolean discriminants do not narrow under `strict: false`.
      if ('errors' in parsed) return fail(400, 'Fix the form and try again.', parsed.errors);
      const form = parsed.form;

      const irrelevant = checkRelevance(form);
      if (irrelevant.length) return fail(400, 'This request is not a valid ad brief.', irrelevant);

      if (!deps.config || !model) {
        return fail(503, 'Ad generation is not configured on this server (ADS_GENERATOR_OPENAI_API_KEY / ADS_GENERATOR_MODEL).');
      }

      const cacheKey = ResultCache.key(form, deps.config.model);
      const cached = deps.cache.get(cacheKey);
      if (cached) return { status: 200, body: { ...cached, cached: true } };

      const slot = deps.limiter.acquire(userId);
      if ('message' in slot) return fail(429, slot.message);
      try {
        const debug = deps.debugLogging ? (message: string) => deps.log.debug(message) : undefined;
        const result = await generateAds(form, model, debug);
        deps.cache.set(cacheKey, result);
        deps.log.info(
          `[ads-generator] admin ${userId} generated ${form.adType} "${form.campaignName}" ` +
          `(${result.usage.calls} calls, ${result.usage.inputTokens}+${result.usage.outputTokens} tokens, ` +
          `${result.model}, effort ${deps.config.reasoningEffort}, prompt ${result.promptVersion})`,
        );
        return { status: 200, body: { ...result, cached: false } };
      } catch (error) {
        return toFailure(error, deps.log, deps.config);
      } finally {
        deps.limiter.release(userId);
      }
    },
  };
}

/** Process-wide singletons: limits and cache must be shared across requests. */
let service: ReturnType<typeof createAdsGeneratorService> | null = null;

export function adsGeneratorService(log: Logger) {
  service ??= createAdsGeneratorService({
    config: readAdsGeneratorConfig(),
    createModel: createOpenAiCreativeModel,
    limiter: new UsageLimiter(readAdsUsageLimits()),
    cache: new ResultCache(),
    log,
    debugLogging: readAdsDebugLogging(),
  });
  return service;
}

function fail(status: number, error: string, problems?: string[]): ServiceResponse {
  return { status, body: problems?.length ? { error, problems } : { error } };
}

function toFailure(error: unknown, log: Logger, config: AdsGeneratorConfig): ServiceResponse {
  if (error instanceof AdsGenerationError) return fail(error.status, error.message, error.problems);
  if (error instanceof AdsModelIncompleteError) {
    log.warn(
      `[ads-generator] no output: finish ${error.finishReason}, ${error.outputTokens} output tokens ` +
      `(${error.reasoningTokens} reasoning), cap ${config.maxOutputTokens}, effort ${config.reasoningEffort}`,
    );
    if (error.finishReason === 'length') {
      return fail(502,
        `OpenAI used its whole output budget (${error.outputTokens} tokens, ${error.reasoningTokens} on reasoning) ` +
        `before writing the ad. Lower ADS_GENERATOR_REASONING_EFFORT (now ${config.reasoningEffort}) or raise ` +
        `ADS_GENERATOR_MAX_OUTPUT_TOKENS (now ${config.maxOutputTokens}), then restart Strapi.`);
    }
    if (error.finishReason === 'content-filter') return fail(502, 'OpenAI\'s content filter stopped the answer. Check the brief wording.');
    return fail(502, `OpenAI stopped without writing the ad (${error.finishReason}). Try again.`);
  }
  if (NoOutputGeneratedError.isInstance(error)) {
    log.warn(`[ads-generator] no output generated: ${error.message}`);
    return fail(502, 'OpenAI returned no ad copy. Try again.');
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    log.warn('[ads-generator] OpenAI call timed out');
    return fail(504, 'OpenAI took too long to answer. Try again.');
  }
  if (NoObjectGeneratedError.isInstance(error)) {
    log.warn(`[ads-generator] malformed model output: ${error.message}`);
    return fail(502, 'OpenAI returned an unreadable answer. Try again.');
  }
  if (APICallError.isInstance(error)) {
    log.error(`[ads-generator] OpenAI HTTP ${error.statusCode ?? 'error'}: ${error.message}`);
    if (error.statusCode === 429) return fail(429, 'OpenAI rate limit or quota reached. Try again later.');
    if (error.statusCode === 401 || error.statusCode === 403) return fail(503, 'The OpenAI key was rejected. Check the server configuration.');
    return fail(502, 'OpenAI request failed. Try again.');
  }
  log.error(`[ads-generator] unexpected failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  return fail(500, 'Ad generation failed unexpectedly.');
}
