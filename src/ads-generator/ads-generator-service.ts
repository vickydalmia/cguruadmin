import {
  ADS_ACCOUNT_CURRENCY,
  ADS_FORM_LIMITS,
  ADS_PROMPT_VERSION,
  type AdsGeneratorJob,
  type AdsGeneratorOptions,
} from '../constants/ads-generator';
import { readAdsDebugLogging, readAdsGeneratorConfig, readAdsUsageLimits, type AdsGeneratorConfig } from './config';
import { failure, toFailure, type Failure } from './failure';
import { parseAdsForm, type AdsForm } from './form';
import { generateAds } from './generate-ads';
import { AdsJobStore } from './job-store';
import { createOpenAiCreativeModel, type CreativeModelCall } from './openai-client';
import { checkRelevance } from './relevance-gate';
import { ResultCache } from './result-cache';
import { UsageLimiter } from './usage-limiter';

/**
 * The request pipeline, in the order that keeps cost at zero for anything
 * that is not a valid, relevant, allowed brief:
 *   parse form → relevance gate → configured? → running job? → cache hit? →
 *   rate limit → background job (OpenAI).
 * The POST answers immediately (202 + job); the page polls GET /jobs/:id, so
 * no proxy timeout can cut a multi-minute generation.
 */

export type ServiceResponse =
  | { status: 200 | 202; body: AdsGeneratorJob }
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
  jobs: AdsJobStore;
  log: Logger;
  /** Log full prompts and responses (ADS_GENERATOR_DEBUG_LOG=true). */
  debugLogging?: boolean;
};

export function createAdsGeneratorService(deps: AdsGeneratorDeps) {
  const model = deps.config ? deps.createModel(deps.config) : null;

  /** Runs one generation to completion and records the outcome on the job. */
  async function run(jobId: string, form: AdsForm, userId: string, cacheKey: string): Promise<void> {
    const config = deps.config!;
    try {
      const debug = deps.debugLogging ? (message: string) => deps.log.debug(message) : undefined;
      const result = await generateAds(form, model!, debug, (attempt) => deps.jobs.progress(jobId, attempt));
      deps.cache.set(cacheKey, result);
      deps.jobs.succeed(jobId, { ...result, cached: false });
      deps.log.info(
        `[ads-generator] admin ${userId} generated ${form.adType} "${form.campaignName}" ` +
        `(${result.usage.calls} calls, ${result.usage.inputTokens}+${result.usage.outputTokens} tokens, ` +
        `${result.model}, effort ${config.reasoningEffort}, prompt ${result.promptVersion}, job ${jobId})`,
      );
    } catch (error) {
      const failed = toFailure(error, deps.log, config);
      deps.jobs.fail(jobId, { message: failed.error, problems: failed.problems ?? [] });
    } finally {
      deps.limiter.release(userId);
    }
  }

  return {
    options(): AdsGeneratorOptions {
      return {
        configured: Boolean(deps.config),
        currency: ADS_ACCOUNT_CURRENCY,
        promptVersion: ADS_PROMPT_VERSION,
        limits: ADS_FORM_LIMITS,
      };
    },

    /** Validates synchronously, then starts (or reattaches to) a background job. */
    generate(body: unknown, userId: string): ServiceResponse {
      const parsed = parseAdsForm(body);
      // `in` narrowing: boolean discriminants do not narrow under `strict: false`.
      if ('errors' in parsed) return reject(failure(400, 'Fix the form and try again.', parsed.errors));
      const form = parsed.form;

      const irrelevant = checkRelevance(form);
      if (irrelevant.length) return reject(failure(400, 'This request is not a valid ad brief.', irrelevant));

      if (!deps.config || !model) {
        return reject(failure(503, 'Ad generation is not configured on this server (ADS_GENERATOR_OPENAI_API_KEY / ADS_GENERATOR_MODEL).'));
      }

      // A second submit (double click, retry after a proxy timeout, another
      // tab) joins the running job instead of failing or paying twice.
      const running = deps.jobs.runningFor(userId);
      if (running) return { status: 202, body: { ...running, reattached: true } };

      const cacheKey = ResultCache.key(form, deps.config.model);
      const cached = deps.cache.get(cacheKey);
      if (cached) return { status: 200, body: deps.jobs.finished(userId, { ...cached, cached: true }) };

      const slot = deps.limiter.acquire(userId);
      if ('message' in slot) return reject(failure(429, slot.message));

      const job = deps.jobs.start(userId);
      void run(job.id, form, userId, cacheKey);
      return { status: 202, body: job };
    },

    job(id: string, userId: string): ServiceResponse {
      const job = deps.jobs.get(id, userId);
      if (job) return { status: 200, body: job };
      return reject(failure(404, 'This generation is no longer available (it expired or the server restarted). Generate again.'));
    },
  };
}

/** Process-wide singletons: limits, cache and jobs must be shared across requests. */
let service: ReturnType<typeof createAdsGeneratorService> | null = null;

export function adsGeneratorService(log: Logger) {
  service ??= createAdsGeneratorService({
    config: readAdsGeneratorConfig(),
    createModel: createOpenAiCreativeModel,
    limiter: new UsageLimiter(readAdsUsageLimits()),
    cache: new ResultCache(),
    jobs: new AdsJobStore(),
    log,
    debugLogging: readAdsDebugLogging(),
  });
  return service;
}

function reject({ status, error, problems }: Failure): ServiceResponse {
  return { status, body: problems?.length ? { error, problems } : { error } };
}
