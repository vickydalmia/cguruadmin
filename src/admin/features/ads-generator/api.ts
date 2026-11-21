import type { useFetchClient } from '@strapi/strapi/admin';
import {
  ADS_GENERATOR_ROUTE_PREFIX,
  type AdsGeneratorFormInput,
  type AdsGeneratorJob,
  type AdsGeneratorOptions,
  type AdsGeneratorResult,
} from '../../../constants/ads-generator';
import {
  generationFailure,
  type GenerationFailure,
} from '../../utils/generation-job';

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

/** Refills the form from a recovered job, keeping only known text fields. */
export function restoredForm(input: unknown): AdsGeneratorFormInput {
  const source = (input ?? {}) as Record<string, unknown>;
  const form = { ...EMPTY_FORM } as Record<string, unknown>;
  for (const key of Object.keys(EMPTY_FORM)) if (typeof source[key] === 'string') form[key] = source[key];
  return form as AdsGeneratorFormInput;
}

export function adsGeneratorApi(client: Client) {
  return {
    async options(): Promise<AdsGeneratorOptions> {
      return (await client.get(OPTIONS_PATH)).data;
    },
    /** Starts a background job (or reattaches to the running one). */
    async generate(form: AdsGeneratorFormInput): Promise<AdsGeneratorJob> {
      return (await client.post(GENERATE_PATH, form)).data;
    },
    async latest(): Promise<AdsGeneratorJob | null> {
      return (await client.get(`${ADS_GENERATOR_ROUTE_PREFIX}/jobs/latest`)).data.job;
    },
    async job(id: string): Promise<AdsGeneratorJob> {
      return (await client.get(jobPath(id))).data;
    },
  };
}

export type AdsGeneratorFailure = GenerationFailure;

/** Server errors are `{ error, problems? }`; show both. */
export function adsGeneratorError(error: unknown): AdsGeneratorFailure {
  return generationFailure(error, 'Your role needs the “Generate Google Ads” permission.');
}

export function progressLabel(job: AdsGeneratorJob): string {
  if (job.attempt <= 1) return 'Writing the ad…';
  return `Fixing the copy (OpenAI call ${job.attempt} of ${job.maxAttempts})…`;
}

/** sessionStorage key for the running job, so a reload can reconnect. */
export const JOB_STORAGE_KEY = 'ads-generator.job-id';

/** Saves the generated CSV through a temporary object URL. */
export function downloadCsv(csv: AdsGeneratorResult['csv']): void {
  const url = URL.createObjectURL(new Blob([csv.content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = csv.filename;
  link.click();
  URL.revokeObjectURL(url);
}
