import {
  ADS_ARABIC_MANUAL_STEPS,
  ADS_ARABIC_PROMPT_VERSION,
  ADS_LLM_LIMITS,
  type AdsArabicVersion,
  type AdsGeneratorResult,
} from '../constants/ads-generator';
import { buildNewCampaignRows } from './csv/build-rows';
import { serializeCsv } from './csv/serialize';
import type { AdsForm } from './form';
import { AdsGenerationError, type DebugLog } from './generate-ads';
import type { CreativeModelCall } from './openai-client';
import {
  ARABIC_FIDELITY_PROMPT,
  ARABIC_SYSTEM_PROMPT,
  renderArabicBrief,
  renderArabicRepair,
  renderFidelityBrief,
} from './prompt/arabic-prompts';
import { validateArabic } from './validate-arabic';

/**
 * Translates validated English ads. Campaign settings, keywords and pins come
 * from the same CSV builder, so only the ad copy changes. Each translation
 * passes the code rules, then an independent fidelity check against its
 * English. One that still fails after the repair budget produces no Arabic CSV.
 */
export async function translateAds(
  form: AdsForm,
  english: Omit<AdsGeneratorResult, 'cached'>,
  callModel: CreativeModelCall,
  debug: DebugLog = () => {},
  onAttempt: (attempt: number) => void = () => {},
): Promise<AdsArabicVersion> {
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  let prompt = renderArabicBrief(form, english.ads);
  let problems: string[] = [];

  for (let attempt = 0; attempt <= ADS_LLM_LIMITS.maxRepairAttempts; attempt += 1) {
    onAttempt(attempt + 1);
    debug(`[ads-generator] arabic attempt ${attempt + 1} prompt:\n${prompt}`);
    const response = await callModel({ system: ARABIC_SYSTEM_PROMPT, prompt });
    debug(`[ads-generator] arabic attempt ${attempt + 1} response: ${JSON.stringify(response.output)}`);
    usage.calls += 1;
    usage.inputTokens += response.inputTokens;
    usage.outputTokens += response.outputTokens;
    const { output } = response;
    if (output.status !== 'ready') throw new AdsGenerationError(`The Arabic translation failed: ${output.reason || 'no reason given'}`, 422);

    problems = validateArabic(english.ads, output.ads, form);
    if (!problems.length) {
      const audit = await callModel({ system: ARABIC_FIDELITY_PROMPT, prompt: renderFidelityBrief(english.ads, output.ads) });
      debug(`[ads-generator] arabic attempt ${attempt + 1} fidelity: ${JSON.stringify(audit.output)}`);
      usage.calls += 1;
      usage.inputTokens += audit.inputTokens;
      usage.outputTokens += audit.outputTokens;
      if (audit.output.status !== 'ready') {
        problems = audit.output.warnings.length ? audit.output.warnings : [audit.output.reason || 'The translation does not match the English.'];
      }
    }
    if (!problems.length) {
      const rows = buildNewCampaignRows(form, english.keywords, output.ads);
      return {
        promptVersion: ADS_ARABIC_PROMPT_VERSION,
        ads: output.ads,
        warnings: output.warnings,
        manualSteps: [...ADS_ARABIC_MANUAL_STEPS],
        usage,
        csv: { filename: english.csv.filename.replace(/\.csv$/, '-ar.csv'), content: serializeCsv(rows), rows: rows.length },
      };
    }
    debug(`[ads-generator] arabic attempt ${attempt + 1} problems: ${JSON.stringify(problems)}`);
    prompt = renderArabicRepair(form, english.ads, problems, output);
  }
  throw new AdsGenerationError(`The Arabic translation still failed validation after ${usage.calls} attempts. No Arabic CSV was created.`, 422, problems);
}
