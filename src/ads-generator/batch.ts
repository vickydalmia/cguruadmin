import {
  ADS_FORM_LIMITS,
  type AdsCampaignRun,
  type AdsGeneratorJob,
  type AdsGeneratorRetryInput,
} from '../constants/ads-generator';
import { parseAdsForm, type AdsForm } from './form';
import { checkRelevance } from './relevance-gate';

/**
 * Validates a whole batch before anything is paid for, reporting every
 * problem with the campaign it belongs to.
 */

export type ParsedAdsBatch = { ok: true; forms: AdsForm[] } | { ok: false; errors: string[] };

export function isRetryRequest(body: unknown): body is AdsGeneratorRetryInput {
  return Boolean(body) && typeof body === 'object' && 'retryJobId' in (body as object);
}

export type MergedRetry =
  | { body: { campaigns: unknown[] }; previous: AdsCampaignRun[] }
  | { status: number; error: string };

/**
 * Builds the batch for a retry: the job's own campaigns, with only its failed
 * ones replaced. Successful campaigns cannot change here, so they stay paid for.
 */
export function mergeRetry(job: AdsGeneratorJob | null, retry: AdsGeneratorRetryInput): MergedRetry {
  if (!job) return { status: 404, error: 'This generation is no longer available (it expired or the server restarted). Generate again.' };
  if (job.status === 'running') return { status: 409, error: 'This run is still generating. Wait for it to finish.' };
  const runs = job.result?.campaigns ?? [];
  const campaigns = [...(((job.input as { campaigns?: unknown[] } | undefined)?.campaigns) ?? [])];
  const replacements = Array.isArray(retry.replacements) ? retry.replacements : [];
  const indexes = replacements.map((entry) => entry?.index);
  const valid = replacements.length > 0
    && new Set(indexes).size === indexes.length
    && indexes.every((index) => Number.isInteger(index) && runs[index]?.status === 'failed');
  if (!valid || campaigns.length !== runs.length) return { status: 400, error: 'Only failed campaigns can be retried.' };
  for (const { index, form } of replacements) campaigns[index] = form;
  return { body: { campaigns }, previous: runs };
}

export function parseAdsBatch(body: unknown): ParsedAdsBatch {
  const campaigns = (body as { campaigns?: unknown } | null)?.campaigns;
  if (!Array.isArray(campaigns) || campaigns.length === 0) return { ok: false, errors: ['Add at least one campaign.'] };
  if (campaigns.length > ADS_FORM_LIMITS.campaignsMax) {
    return { ok: false, errors: [`Generate up to ${ADS_FORM_LIMITS.campaignsMax} campaigns at once.`] };
  }

  const errors: string[] = [];
  const forms: AdsForm[] = [];
  const names = new Map<string, number>();
  campaigns.forEach((campaign, index) => {
    const label = `Campaign ${index + 1}`;
    const parsed = parseAdsForm(campaign);
    if ('errors' in parsed) {
      errors.push(...parsed.errors.map((error) => `${label}: ${error}`));
      return;
    }
    errors.push(...checkRelevance(parsed.form).map((error) => `${label}: ${error}`));
    const name = parsed.form.campaignName.toLowerCase();
    const first = names.get(name);
    if (first !== undefined) errors.push(`${label}: same campaign name as Campaign ${first + 1}.`);
    else names.set(name, index);
    forms.push(parsed.form);
  });
  return errors.length ? { ok: false, errors } : { ok: true, forms };
}
