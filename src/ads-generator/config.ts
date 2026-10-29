import { ADS_LLM_LIMITS } from '../constants/ads-generator';
import type { UsageLimits } from './usage-limiter';

// Runtime secrets, model selection and the per-environment request limits.
// Every validation limit lives in src/constants/ads-generator.ts; prompts
// live in ./prompt/.

const REASONING_EFFORTS = ['none', 'low', 'medium', 'high'] as const;
export type AdsReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type AdsGeneratorConfig = {
  apiKey: string;
  model: string;
  reasoningEffort: AdsReasoningEffort;
  /** Includes reasoning tokens; see ADS_LLM_LIMITS.maxOutputTokens. */
  maxOutputTokens: number;
  timeoutMs: number;
};

/** Null when the key or model is missing: the feature is then inert (503). */
export function readAdsGeneratorConfig(env: NodeJS.ProcessEnv = process.env): AdsGeneratorConfig | null {
  const apiKey = String(env.ADS_GENERATOR_OPENAI_API_KEY ?? '').trim();
  const model = String(env.ADS_GENERATOR_MODEL ?? '').trim();
  if (!apiKey || !model) return null;
  const effort = String(env.ADS_GENERATOR_REASONING_EFFORT ?? '').trim() || 'low';
  return {
    apiKey,
    model,
    reasoningEffort: (REASONING_EFFORTS as readonly string[]).includes(effort)
      ? (effort as AdsReasoningEffort)
      : 'low',
    maxOutputTokens: positiveInteger(env.ADS_GENERATOR_MAX_OUTPUT_TOKENS, ADS_LLM_LIMITS.maxOutputTokens),
    timeoutMs: positiveInteger(env.ADS_GENERATOR_TIMEOUT_MS, ADS_LLM_LIMITS.timeoutMs),
  };
}

/**
 * Request limits per environment (e.g. generous locally, tight in
 * production). Blank or invalid values fall back to the ADS_LLM_LIMITS
 * defaults, so a typo can never remove the limit.
 */
export function readAdsUsageLimits(env: NodeJS.ProcessEnv = process.env): UsageLimits {
  return {
    maxRequestsPerUserPerHour: positiveInteger(
      env.ADS_GENERATOR_MAX_REQUESTS_PER_USER_PER_HOUR, ADS_LLM_LIMITS.maxRequestsPerUserPerHour,
    ),
    maxRequestsPerDay: positiveInteger(env.ADS_GENERATOR_MAX_REQUESTS_PER_DAY, ADS_LLM_LIMITS.maxRequestsPerDay),
  };
}

/**
 * Full rendered prompts and model responses in the log. Off unless explicitly
 * enabled: this repo has no config/logger, so Strapi's default level shows
 * debug lines in every environment.
 */
export function readAdsDebugLogging(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.ADS_GENERATOR_DEBUG_LOG ?? '').trim().toLowerCase() === 'true';
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
