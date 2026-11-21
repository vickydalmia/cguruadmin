import {
  ADS_LLM_LIMITS,
  ADS_MANUAL_STEPS,
  ADS_PROMPT_VERSION,
  type AdsGeneratorResult,
} from '../constants/ads-generator';
import { buildKeywords, buildNewCampaignRows } from './csv/build-rows';
import { serializeCsv } from './csv/serialize';
import type { AdsForm } from './form';
import type { CreativeModelCall } from './openai-client';
import type { AdsModelOutput } from './prompt/output-schema';
import { renderBrief, renderRepair, systemPromptFor } from './prompt/render-prompts';
import { validateCreative } from './validate-creative';
import { checkEditorial } from './validate-editorial';

/**
 * New-campaign generation: one model call, then at most
 * ADS_LLM_LIMITS.maxRepairAttempts repair calls carrying the exact problems.
 * Copy is never trimmed or patched in code.
 *  - Mechanical errors (counts, lengths, brand in H1, banned words, numbers
 *    not in the offer details) block: no CSV.
 *  - Editorial issues (repetition, filler) are repaired when possible; any
 *    left after the budget are returned as reviewer warnings.
 */

export class AdsGenerationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly problems: string[] = [],
  ) {
    super(message);
  }
}

/** Optional sink for full prompts/responses; the service wires it to strapi.log.debug. */
export type DebugLog = (message: string) => void;

export async function generateAds(
  form: AdsForm,
  callModel: CreativeModelCall,
  debug: DebugLog = () => {},
  /** Called before each OpenAI call with its 1-based number (job progress). */
  onAttempt: (attempt: number) => void = () => {},
): Promise<Omit<AdsGeneratorResult, 'cached'>> {
  const system = systemPromptFor(form.adType);
  const brief = renderBrief(form);
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let prompt = brief;
  let model = '';
  let errors: string[] = [];
  // Best answer with no mechanical errors so far: a repair aimed at an
  // editorial issue must never cost an otherwise valid CSV.
  let usable: { output: AdsModelOutput; editorial: string[] } | null = null;

  for (let attempt = 0; attempt <= ADS_LLM_LIMITS.maxRepairAttempts; attempt += 1) {
    onAttempt(attempt + 1);
    debug(`[ads-generator] attempt ${attempt + 1} prompt:\n${prompt}`);
    const response = await callModel({ system, prompt });
    debug(`[ads-generator] attempt ${attempt + 1} response: ${JSON.stringify(response.output)}`);
    usage.calls += 1;
    usage.inputTokens += response.inputTokens;
    usage.outputTokens += response.outputTokens;
    model = response.model;
    const output = response.output;

    if (output.status === 'insufficient_evidence') {
      const source = form.adType === 'evergreen' ? 'brand categories' : 'offer details';
      throw new AdsGenerationError(`The ${source} are not usable: ${output.reason || 'no reason given'}`, 422);
    }
    errors = validateCreative(output, form);
    const editorial = checkEditorial(output.ads, form);
    if (!errors.length && (!usable || editorial.length <= usable.editorial.length)) usable = { output, editorial };
    if (!errors.length && !editorial.length) break;
    debug(`[ads-generator] attempt ${attempt + 1} problems: ${JSON.stringify({ errors, editorial })}`);
    prompt = `${brief}\n\n${renderRepair(form.adType, [...errors, ...editorial], output)}`;
  }

  if (!usable) {
    throw new AdsGenerationError(
      `The generated ads still failed validation after ${usage.calls} attempts. No CSV was created.`,
      422,
      errors,
    );
  }

  const { output, editorial } = usable;
  const keywords = buildKeywords(form.brandName);
  const rows = buildNewCampaignRows(form, keywords, output.ads);
  return {
    adType: form.adType,
    promptVersion: ADS_PROMPT_VERSION,
    model,
    keywords,
    ads: output.ads,
    warnings: [...reviewWarnings(form), ...editorial.map((issue) => `Copy review: ${issue}`), ...output.warnings],
    manualSteps: [...ADS_MANUAL_STEPS],
    usage,
    csv: { filename: csvFilename(form.campaignName), content: serializeCsv(rows), rows: rows.length },
  };
}

function reviewWarnings(form: AdsForm): string[] {
  const warnings: string[] = [];
  if (form.adType === 'offer') {
    warnings.push('Offer-specific copy names the current offer: regenerate or pause these ads when the offer changes.');
  }
  if (form.negativeKeywordLists.length) {
    warnings.push(
      'Negative keyword lists must already exist in the Google Ads account with these exact names; otherwise that row fails with "Item not found".',
    );
  }
  if (form.targetCpa > form.dailyBudget) {
    warnings.push('Target CPA is higher than the daily budget.');
  }
  return warnings;
}

function csvFilename(campaignName: string): string {
  const slug = campaignName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'campaign';
  return `google-ads-${slug}.csv`;
}
