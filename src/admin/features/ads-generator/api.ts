import type { useFetchClient } from '@strapi/strapi/admin';
import {
  ADS_GENERATOR_ROUTE_PREFIX,
  ADS_FORM_LIMITS,
  type AdsCampaignRun,
  type AdsGenerationRequest,
  type AdsGeneratorRetryInput,
  type AdsLanguage,
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

/** One repeater row; the id keeps React state stable when rows move. */
export type CampaignRow = { id: string; value: AdsGeneratorFormInput };

let nextRowId = 0;
export function newRow(value: AdsGeneratorFormInput = EMPTY_FORM): CampaignRow {
  nextRowId += 1;
  return { id: `campaign-${nextRowId}`, value: { ...value } };
}

/** Campaign names must be unique in a batch and fit the limit, so the copy gets its own. */
export function duplicateRow(row: CampaignRow, rows: CampaignRow[] = [row]): CampaignRow {
  const name = row.value.campaignName.trim();
  if (!name) return newRow({ ...row.value, campaignName: '' });
  const taken = new Set(rows.map((entry) => entry.value.campaignName.trim().toLowerCase()));
  for (let copy = 1; ; copy += 1) {
    const suffix = copy === 1 ? ' Copy' : ` Copy ${copy}`;
    const candidate = `${name.slice(0, ADS_FORM_LIMITS.campaignNameMax - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return newRow({ ...row.value, campaignName: candidate });
  }
}

/**
 * Retries only the failed campaigns, using each one's current row so a fix is
 * picked up. A removed row falls back to what was originally submitted.
 */
export function retryRequest(job: AdsGeneratorJob, rows: CampaignRow[], submittedIds: string[]): AdsGeneratorRetryInput {
  const submitted = ((job.input as { campaigns?: AdsGeneratorFormInput[] } | undefined)?.campaigns) ?? [];
  const replacements = (job.result?.campaigns ?? [])
    .filter((run) => run.status === 'failed')
    .map((run) => ({
      index: run.index,
      form: rows.find((row) => row.id === submittedIds[run.index])?.value ?? submitted[run.index],
    }));
  return { retryJobId: job.id, replacements };
}

export function restoredLanguage(input: unknown): AdsLanguage {
  return (input as { language?: unknown } | null)?.language === 'ar' ? 'ar' : 'en';
}

/** The file to download: the Arabic CSV when Arabic was requested. */
export function downloadableCsv(result: AdsGeneratorResult): AdsGeneratorResult['csv'] {
  return result.arabic?.csv ?? result.csv;
}

/** Rebuilds the repeater from a recovered job. */
export function restoredRows(input: unknown): CampaignRow[] | null {
  const campaigns = (input as { campaigns?: unknown } | null)?.campaigns;
  if (!Array.isArray(campaigns) || !campaigns.length) return null;
  return campaigns.slice(0, ADS_FORM_LIMITS.campaignsMax).map((campaign) => newRow(restoredForm(campaign)));
}

/** Refills one campaign from a recovered job, keeping only known text fields. */
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
    async generate(request: AdsGenerationRequest): Promise<AdsGeneratorJob> {
      return (await client.post(GENERATE_PATH, request)).data;
    },
    async latest(): Promise<AdsGeneratorJob | null> {
      return (await client.get(`${ADS_GENERATOR_ROUTE_PREFIX}/jobs/latest`)).data.job;
    },
    async dismiss(id: string): Promise<void> {
      await client.post(`${jobPath(id)}/dismiss`);
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
  const runs = job.result?.campaigns ?? [];
  if (runs.length === 1 && runs[0].phase === 'arabic') return 'Translating to Arabic…';
  if (runs.length > 1) {
    const done = runs.filter((run) => run.status === 'succeeded' || run.status === 'failed').length;
    return `Generated ${done} of ${runs.length} campaigns…`;
  }
  const attempt = runs[0]?.attempt ?? job.attempt;
  if (attempt <= 1) return 'Writing the ad…';
  return `Fixing the copy (OpenAI call ${attempt} of ${job.maxAttempts})…`;
}

/** sessionStorage key for the running job, so a reload can reconnect. */
export const JOB_STORAGE_KEY = 'ads-generator.job-id';

/** Saves the generated CSV through a temporary object URL. */
export function downloadCsv(csv: AdsGeneratorResult['csv']): void {
  saveBlob(new Blob([csv.content], { type: 'text/csv;charset=utf-8' }), csv.filename);
}

/** One Google Ads upload: the shared header once, then each campaign's rows in form order. */
export function combineCampaignCsv(runs: AdsCampaignRun[], date: Date = new Date()): AdsGeneratorResult['csv'] | null {
  const files = runs.flatMap((run) => (run.result ? [downloadableCsv(run.result)] : []));
  if (!files.length) return null;
  const parts = files.map((file) => {
    const content = file.content.replace(/^\uFEFF/, '');
    const headerEnd = content.indexOf('\r\n');
    if (headerEnd < 0) throw new Error(`Invalid campaign CSV: ${file.filename}`);
    return { header: content.slice(0, headerEnd), body: content.slice(headerEnd + 2) };
  });
  if (parts.some((part) => part.header !== parts[0].header)) throw new Error('Campaign CSV headers do not match.');
  return {
    filename: `google-ads-campaigns-${date.toISOString().slice(0, 10)}.csv`,
    content: `\uFEFF${parts[0].header}\r\n${parts.map((part) => part.body).join('')}`,
    rows: files.reduce((total, file) => total + file.rows, 0),
  };
}

/** Saves every successful campaign in one CSV. */
export function downloadAllCsv(runs: AdsCampaignRun[]): void {
  const csv = combineCampaignCsv(runs);
  if (csv) downloadCsv(csv);
}

const DOWNLOADED_STORAGE_KEY = 'ads-generator.downloaded';
const DOWNLOADED_MEMORY_MAX = 200;

/** The same brief in the same language keeps this id through retries and reloads. */
export function downloadId(run: AdsCampaignRun): string {
  return run.result ? `${run.key}:${downloadableCsv(run.result).filename}` : run.key;
}

export function remainingDownloads(ready: AdsCampaignRun[], downloaded: ReadonlySet<string>): AdsCampaignRun[] {
  return ready.filter((run) => !downloaded.has(downloadId(run)));
}

export function downloadAllLabel(total: number, ready: number, remaining: number): string {
  if (remaining === 0) return `Download all again (${ready} campaigns, 1 CSV)`;
  if (remaining < ready) return `Download remaining (${remaining} ${remaining === 1 ? 'campaign' : 'campaigns'}, 1 CSV)`;
  return ready === total ? `Download all (${total} campaigns, 1 CSV)` : `Download ${ready} of ${total} campaigns (1 CSV)`;
}

export function readDownloaded(): Set<string> {
  try {
    const stored: unknown = JSON.parse(window.sessionStorage.getItem(DOWNLOADED_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Remembers downloads for this tab; losing storage only means a campaign is offered again. */
export function rememberDownloaded(runs: AdsCampaignRun[], current: ReadonlySet<string>): Set<string> {
  const next = new Set([...current, ...runs.map(downloadId)]);
  const kept = [...next].slice(-DOWNLOADED_MEMORY_MAX);
  try {
    window.sessionStorage.setItem(DOWNLOADED_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Private browsing or a full quota: the in-page state still works.
  }
  return new Set(kept);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
