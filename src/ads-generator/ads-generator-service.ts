import { JobStore } from '../ai-generation/job-store';
import { UsageLimiter } from '../ai-generation/usage-limiter';
import {
  ADS_ACCOUNT_CURRENCY,
  ADS_ARABIC_PROMPT_VERSION,
  ADS_LLM_LIMITS,
  ADS_FORM_LIMITS,
  ADS_PROMPT_VERSION,
  type AdsBatchResult,
  type AdsCampaignRun,
  type AdsGeneratorJob,
  type AdsLanguage,
  type AdsGeneratorResult,
  type AdsGeneratorOptions,
} from '../constants/ads-generator';
import { readAdsDebugLogging, readAdsGeneratorConfig, readAdsUsageLimits, type AdsGeneratorConfig } from './config';
import { isRetryRequest, mergeRetry, parseAdsBatch } from './batch';
import { failure, toFailure, type Failure } from './failure';
import type { AdsForm } from './form';
import { generateAds } from './generate-ads';
import { translateAds } from './translate-ads';
import { createOpenAiCreativeModel, type CreativeModelCall } from './openai-client';
import { ResultCache } from './result-cache';

/**
 * The request pipeline, in the order that keeps cost at zero for anything
 * that is not a valid, relevant, allowed brief:
 *   parse batch → relevance gate → configured? → running job? → reuse paid
 *   results → rate limit (one per campaign to generate) → background job.
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
  jobs: JobStore<AdsBatchResult>;
  log: Logger;
  /** Log full prompts and responses (ADS_GENERATOR_DEBUG_LOG=true). */
  debugLogging?: boolean;
};

export function createAdsGeneratorService(deps: AdsGeneratorDeps) {
  const model = deps.config ? deps.createModel(deps.config) : null;

  /** Generates one campaign and records its outcome on its run. */
  async function runCampaign(
    run: AdsCampaignRun, form: AdsForm, language: AdsLanguage, previous: AdsCampaignRun[],
    userId: string, jobId: string, publish: () => void,
  ): Promise<void> {
    const config = deps.config!;
    run.status = 'running';
    publish();
    try {
      const debug = deps.debugLogging ? (message: string) => deps.log.debug(message) : undefined;
      const onAttempt = (attempt: number) => { run.attempt = attempt; publish(); };
      // English is always written and validated first; Arabic only translates it.
      let english = paidEnglish(run.englishKey!, previous);
      if (!english) {
        run.phase = 'english';
        english = await generateAds(form, model!, debug, onAttempt);
        deps.cache.set(run.englishKey!, english);
        deps.log.info(
          `[ads-generator] admin ${userId} generated ${form.adType} "${form.campaignName}" ` +
          `(${english.usage.calls} calls, ${english.usage.inputTokens}+${english.usage.outputTokens} tokens, ` +
          `${english.model}, effort ${config.reasoningEffort}, prompt ${english.promptVersion}, job ${jobId})`,
        );
      }
      if (language === 'ar') {
        run.english = english;
        run.phase = 'arabic';
        run.attempt = 0;
        publish();
        const arabic = await translateAds(form, english, model!, debug, onAttempt);
        const translated = { ...english, arabic };
        deps.cache.set(run.key, translated);
        run.result = { ...translated, cached: false };
        delete run.english;
      } else {
        run.result = { ...english, cached: false };
      }
      run.status = 'succeeded';
    } catch (error) {
      const failed = toFailure(error, deps.log, config);
      run.error = { message: failed.error, problems: failed.problems ?? [] };
      run.status = 'failed';
    }
    publish();
  }

  /** Works through the queued campaigns a few at a time; one failure never stops the rest. */
  async function runBatch(
    jobId: string, runs: AdsCampaignRun[], forms: AdsForm[], language: AdsLanguage, previous: AdsCampaignRun[], userId: string,
  ): Promise<void> {
    const publish = () => deps.jobs.update(jobId, { campaigns: runs.map((run) => ({ ...run })) });
    const queue = runs.filter((run) => run.status === 'queued');
    const worker = async () => {
      for (let run = queue.shift(); run; run = queue.shift()) await runCampaign(run, forms[run.index], language, previous, userId, jobId, publish);
    };
    try {
      await Promise.all(Array.from({ length: Math.min(ADS_LLM_LIMITS.batchConcurrency, queue.length) }, worker));
      deps.jobs.succeed(jobId, { campaigns: runs.map((run) => ({ ...run })) });
    } catch (error) {
      const failed = toFailure(error, deps.log, deps.config!);
      deps.jobs.fail(jobId, { message: failed.error, problems: failed.problems ?? [] });
    } finally {
      deps.limiter.release(userId);
    }
  }

  /** Already-paid results: the short cache, then the admin's previous run. */
  function reusable(key: string, previous: AdsCampaignRun[]): AdsGeneratorResult | null {
    const cached = deps.cache.get(key);
    if (cached) return { ...cached, cached: true };
    const earlier = previous.find((run) => run.key === key && run.status === 'succeeded')?.result;
    return earlier ? { ...earlier, cached: true } : null;
  }

  /** Validated English already paid for, including from a failed translation. */
  function paidEnglish(key: string, previous: AdsCampaignRun[]): Omit<AdsGeneratorResult, 'cached'> | null {
    const cached = deps.cache.get(key);
    if (cached) return cached;
    for (const run of previous) {
      if ((run.englishKey ?? run.key) !== key) continue;
      if (run.english) return run.english;
      if (run.result) {
        const { arabic: _arabic, cached: _cached, ...english } = run.result;
        return english;
      }
    }
    return null;
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

    /** Validates the whole batch, then starts (or reattaches to) a background job. */
    generate(body: unknown, userId: string): ServiceResponse {
      let batch = body;
      let retried: AdsCampaignRun[] | null = null;
      if (isRetryRequest(body)) {
        const merged = mergeRetry(deps.jobs.get(String(body.retryJobId), userId), body);
        if ('error' in merged) return reject(failure(merged.status, merged.error));
        batch = merged.body;
        retried = merged.previous;
      }

      const parsed = parseAdsBatch(batch);
      // `in` narrowing: boolean discriminants do not narrow under `strict: false`.
      if ('errors' in parsed) return reject(failure(400, 'Fix the campaigns and try again.', parsed.errors));
      const { forms, language } = parsed;

      if (!deps.config || !model) {
        return reject(failure(503, 'Ad generation is not configured on this server (ADS_GENERATOR_OPENAI_API_KEY / ADS_GENERATOR_MODEL).'));
      }

      const englishKeys = forms.map((form) => ResultCache.key(form, deps.config!.model));
      const keys = language === 'ar' ? englishKeys.map((key) => `${key}:ar:${ADS_ARABIC_PROMPT_VERSION}`) : englishKeys;
      const request = {
        requestKey: keys.join('|'),
        input: { campaigns: (batch as { campaigns: unknown[] }).campaigns, ...(language === 'ar' ? { language } : {}) },
      };

      // The same batch (double click, retry after a proxy timeout, another tab)
      // joins the running job. A different batch must never receive its results.
      const running = deps.jobs.runningFor(userId);
      if (running) {
        if (deps.jobs.isSameRequest(running.id, request.requestKey)) return { status: 202, body: { ...running, reattached: true } };
        return reject(failure(409, 'Another run is still generating. Wait for it to finish, then submit these campaigns.'));
      }

      const previous = retried ?? deps.jobs.latestFor(userId)?.result?.campaigns ?? [];
      const runs = forms.map((form, index): AdsCampaignRun => {
        const result = reusable(keys[index], previous);
        return {
          index,
          campaignName: form.campaignName,
          key: keys[index],
          englishKey: englishKeys[index],
          status: result ? 'succeeded' : 'queued',
          attempt: 0,
          ...(result ? { result } : {}),
        };
      });
      const queued = runs.filter((run) => run.status === 'queued');
      // One generation per campaign. An Arabic campaign's English and translation count once.
      const toGenerate = queued.length;
      if (!queued.length) return { status: 200, body: deps.jobs.finished(userId, { campaigns: runs }, request) };

      const slot = deps.limiter.acquire(userId, toGenerate);
      if ('message' in slot) return reject(failure(429, slot.message));

      const job = deps.jobs.start(userId, request);
      deps.jobs.update(job.id, { campaigns: runs.map((run) => ({ ...run })) });
      const started = deps.jobs.get(job.id, userId)!;
      void runBatch(job.id, runs, forms, language, previous, userId);
      return { status: 202, body: started };
    },

    /** The admin's running or last job, so any tab or reload can recover it. */
    latest(userId: string): { job: AdsGeneratorJob | null } {
      return { job: deps.jobs.latestFor(userId) };
    },

    /** "New batch": the finished job is no longer recovered on load. */
    dismiss(id: string, userId: string): { status: number; body: unknown } {
      if (deps.jobs.dismiss(id, userId)) return { status: 200, body: { dismissed: true } };
      return reject(failure(409, 'This run cannot be cleared. It may still be generating or no longer exist.'));
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
    jobs: adsJobStore(),
    log,
    debugLogging: readAdsDebugLogging(),
  });
  return service;
}

/** One OpenAI call plus up to maxRepairAttempts repairs per job. */
export function adsJobStore(): JobStore<AdsBatchResult> {
  return new JobStore({ retentionMs: ADS_LLM_LIMITS.jobRetentionMs, maxAttempts: 1 + ADS_LLM_LIMITS.maxRepairAttempts });
}

function reject({ status, error, problems }: Failure): ServiceResponse {
  return { status, body: problems?.length ? { error, problems } : { error } };
}
