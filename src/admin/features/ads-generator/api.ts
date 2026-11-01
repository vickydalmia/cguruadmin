import type { useFetchClient } from '@strapi/strapi/admin';
import {
  ADS_GENERATOR_ROUTE_PREFIX,
  type AdsGeneratorFormInput,
  type AdsGeneratorOptions,
  type AdsGeneratorResult,
} from '../../../constants/ads-generator';

/** React-free request logic for Settings → Ads Generator. */

type Client = ReturnType<typeof useFetchClient>;

export const OPTIONS_PATH = `${ADS_GENERATOR_ROUTE_PREFIX}/options`;
export const GENERATE_PATH = `${ADS_GENERATOR_ROUTE_PREFIX}/generate`;

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
    async generate(form: AdsGeneratorFormInput): Promise<AdsGeneratorResult> {
      return (await client.post(GENERATE_PATH, form)).data;
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

/** Saves the generated CSV through a temporary object URL. */
export function downloadCsv(csv: AdsGeneratorResult['csv']): void {
  const url = URL.createObjectURL(new Blob([csv.content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = csv.filename;
  link.click();
  URL.revokeObjectURL(url);
}
