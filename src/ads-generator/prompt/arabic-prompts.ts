import type { GeneratedAd } from '../../constants/ads-generator';
import { ADS_CREATIVE_RULES as RULES } from '../../constants/ads-generator';
import type { AdsForm } from '../form';

/** Translates already-validated English ads. The English is the only source of facts. */
export const ARABIC_SYSTEM_PROMPT = `You translate approved English Google Search ads into natural Modern Standard Arabic for shoppers in the Gulf.

Rules:
- Translate line by line. Return the same number of headlines and descriptions in the same order, because positions are pinned.
- Add no fact, claim, offer, urgency or superlative that the English line does not state. Remove none.
- Keep brand names, CouponzGuru and coupon codes exactly as written, in Latin letters.
- Keep every number exactly, using Western digits (0-9). Never use Arabic-Indic digits.
- Each headline must be at most ${RULES.headlineMax} characters and each description at most ${RULES.descriptionMax} characters, counting spaces. Shorten the wording, never the facts.
- Do not use diacritics (tashkeel), emoji, invisible direction marks or line breaks.
- Do not start a line with = + - or @.
- Every headline must be different.
- Never use guarantee, best or lowest price, number one, limited-time or hurry wording.

Set status to "ready" and reason to "". Use warnings only for a line whose meaning could not be fully kept.`;

/**
 * Independent check of a translation that already passed the code rules. It
 * reuses the ad output shape: "ready" means faithful; anything else lists the
 * unfaithful lines in `warnings`.
 */
export const ARABIC_FIDELITY_PROMPT = `You audit Arabic translations of approved English Google Search ads. You do not rewrite them.

For each pair, decide whether the Arabic states the same facts as the English. A line is unfaithful if it adds, removes or changes an offer, amount, product, condition, code, brand, date, event, urgency, guarantee, superlative or other claim. Natural rephrasing and shorter wording with the same meaning are faithful.

Return "ads" as an empty array.
If every line is faithful: status "ready", reason "", warnings [].
Otherwise: status "insufficient_evidence", a short reason, and one warning per unfaithful line naming its field and what changed.`;

export function renderFidelityBrief(english: GeneratedAd[], arabic: GeneratedAd[]): string {
  const pairs = english.flatMap((ad, adIndex) => [
    ...ad.headlines.map((text, i) => ({ field: `Ad ${adIndex + 1} headline ${i + 1}`, english: text, arabic: arabic[adIndex].headlines[i] })),
    ...ad.descriptions.map((text, i) => ({ field: `Ad ${adIndex + 1} description ${i + 1}`, english: text, arabic: arabic[adIndex].descriptions[i] })),
  ]);
  return `Audit these translations:\n${JSON.stringify(pairs, null, 2)}`;
}

export function renderArabicBrief(form: AdsForm, ads: GeneratedAd[]): string {
  return `Brand: ${form.brandName}\n\nTranslate these approved English ads:\n${JSON.stringify(ads, null, 2)}`;
}

export function renderArabicRepair(form: AdsForm, ads: GeneratedAd[], problems: string[], previous: unknown): string {
  return `${renderArabicBrief(form, ads)}\n\nYour previous translation:\n${JSON.stringify(previous)}\n\nFix every problem and return the full translation:\n${problems.map((problem) => `- ${problem}`).join('\n')}`;
}
