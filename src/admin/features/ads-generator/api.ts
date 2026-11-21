import type { useFetchClient } from '@strapi/strapi/admin';
import {
  ADS_GENERATOR_ROUTE_PREFIX,
  type AdsGeneratorFormInput,
  type AdsGeneratorJob,
  type AdsGeneratorOptions,
  type AdsGeneratorResult,
} from '../../../constants/ads-generator';

/** React-free request logic for Settings → Ads Generator. */

type Client = ReturnType<typeof useFetchClient>;

export const OPTIONS_PATH = `${ADS_GENERATOR_ROUTE_PREFIX}/options`;
export const GENERATE_PATH = `${ADS_GENERATOR_ROUTE_PREFIX}/generate`;

export function jobPath(id: string): string {
  return `${ADS_GENERATOR_ROUTE_PREFIX}/jobs/${encodeURIComponent(id)}`;
}

export const EMPTY_FORM: AdsGeneratorFormInput = {
  adType: 'evergreen',
  campaignName: '',
  brandName: '',
  countries: '',
  landingPage: '',
  dailyBudget: '',
  targetCpa: '',
  label: '',
  mobileAdjustment: '',
  tabletAdjustment: '',
  desktopAdjustment: '',
  negativeKeywordLists: '',
  offerDetails: '',
  brandCategories: '',
};

export function adsGeneratorApi(client: Client) {
  return {
    async options(): Promise<AdsGeneratorOptions> {
      return (await client.get(OPTIONS_PATH)).data;
    },
    /** Starts a background job (or reattaches to the running one). */
    async generate(form: AdsGeneratorFormInput): Promise<AdsGeneratorJob> {
      return (await client.post(GENERATE_PATH, form)).data;
    },
    async job(id: string): Promise<AdsGeneratorJob> {
      return (await client.get(jobPath(id))).data;
    },
  };
}

export type AdsGeneratorFailure = { message: string; problems: string[]; forbidden: boolean };

/** Server errors are `{ error, problems? }`; show both. */
export function adsGeneratorError(error: unknown): AdsGeneratorFailure {
  const value = error as { status?: number; message?: string; response?: { status?: number; data?: any } };
  const status = value?.response?.status ?? value?.status;
  const data = value?.response?.data;
  const message = typeof data?.error === 'string'
    ? data.error
    : data?.error?.message ?? value?.message ?? 'The request failed. Try again.';
  return {
    message: status === 403 ? 'Your role needs the “Generate Google Ads” permission.' : message,
    problems: Array.isArray(data?.problems) ? data.problems.map(String) : [],
    forbidden: status === 403,
  };
}

/** A failed job carries the same `{ message, problems }` the page already shows. */
export function jobFailure(job: AdsGeneratorJob): AdsGeneratorFailure {
  return {
    message: job.error?.message ?? 'Ad generation failed. Try again.',
    problems: job.error?.problems ?? [],
    forbidden: false,
  };
}

export function progressLabel(job: AdsGeneratorJob): string {
  if (job.attempt <= 1) return 'Writing the ad…';
  return `Fixing the copy (OpenAI call ${job.attempt} of ${job.maxAttempts})…`;
}

/**
 * The running job's id survives a page reload in this tab, so the page can
 * reconnect to it. sessionStorage can be unavailable; that only loses the
 * reconnect, never the job.
 */
const JOB_KEY = 'ads-generator.job-id';

export function rememberJob(id: string | null): void {
  try {
    if (id) window.sessionStorage.setItem(JOB_KEY, id);
    else window.sessionStorage.removeItem(JOB_KEY);
  } catch {
    // Storage blocked: nothing to remember.
  }
}

export function rememberedJob(): string | null {
  try {
    return window.sessionStorage.getItem(JOB_KEY);
  } catch {
    return null;
  }
}

/** Saves the generated CSV through a temporary object URL. */
export function downloadCsv(csv: AdsGeneratorResult['csv']): void {
  const url = URL.createObjectURL(new Blob([csv.content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = csv.filename;
  link.click();
  URL.revokeObjectURL(url);
}
