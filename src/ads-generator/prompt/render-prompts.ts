import { ADS_APPROVED_SITE_CLAIMS, ADS_TRUST_TERMS, type AdsAdType } from '../../constants/ads-generator';
import type { AdsForm } from '../form';
import { EVERGREEN_REPAIR_TEMPLATE, EVERGREEN_SYSTEM_PROMPT, EVERGREEN_USER_TEMPLATE } from './evergreen-prompts';
import { OFFER_REPAIR_TEMPLATE, OFFER_SYSTEM_PROMPT, OFFER_USER_TEMPLATE } from './offer-prompts';

// Picks the prompt set for the ad type and fills its {{placeholders}}.
// renderTemplate() throws on a missing or unused value, so a template edit
// can never send a half-filled prompt.

type PromptSet = { system: string; user: string; repair: string };

const PROMPT_SETS: Record<AdsAdType, PromptSet> = {
  evergreen: { system: EVERGREEN_SYSTEM_PROMPT, user: EVERGREEN_USER_TEMPLATE, repair: EVERGREEN_REPAIR_TEMPLATE },
  offer: { system: OFFER_SYSTEM_PROMPT, user: OFFER_USER_TEMPLATE, repair: OFFER_REPAIR_TEMPLATE },
};

export function systemPromptFor(adType: AdsAdType): string {
  return PROMPT_SETS[adType].system;
}

export function briefValues(form: AdsForm): Record<string, string> {
  const shared = {
    brand_name: form.brandName,
    countries: form.countries.join(', '),
    landing_page: form.landingPage,
    trust_signals: trustSignals(),
  };
  if (form.adType === 'offer') return { ...shared, offer_details: form.offerDetails || '(none supplied)' };
  return { ...shared, brand_categories: form.brandCategories.join(', ') };
}

/** The approved trust terms plus the CouponzGuru claims that make them true. */
function trustSignals(): string {
  const claims = ADS_APPROVED_SITE_CLAIMS.length
    ? ADS_APPROVED_SITE_CLAIMS.map((claim) => `- ${claim}`).join('\n')
    : '- (no other claims approved)';
  return `Terms: ${ADS_TRUST_TERMS.join(', ')}\nApproved claims:\n${claims}`;
}

export function renderBrief(form: AdsForm): string {
  return renderTemplate(PROMPT_SETS[form.adType].user, briefValues(form));
}

export function renderRepair(adType: AdsAdType, problems: string[], previousAnswer: unknown): string {
  return renderTemplate(PROMPT_SETS[adType].repair, {
    problems: problems.map((problem) => `- ${problem}`).join('\n'),
    previous_answer: JSON.stringify(previousAnswer, null, 2),
  });
}

/** Replaces {{name}} placeholders; throws on a missing or unused value. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  const used = new Set<string>();
  const output = template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new Error(`Prompt placeholder {{${name}}} has no value.`);
    used.add(name);
    return values[name];
  });
  const unused = Object.keys(values).filter((name) => !used.has(name));
  if (unused.length) throw new Error(`Prompt values not used by the template: ${unused.join(', ')}.`);
  return output;
}
