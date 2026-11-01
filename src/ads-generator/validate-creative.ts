import {
  ADS_BANNED_COPY_PHRASES,
  ADS_CREATIVE_RULES as RULES,
  ADS_EVERGREEN_BLOCKED_TERMS,
  ADS_NON_STACKING_TERMS,
  ADS_STACKING_COPY_TERMS,
  ADS_STACKING_EVIDENCE_TERMS,
} from '../constants/ads-generator';
import { hasAnyTerm, numbersIn, withoutBrand } from './copy-text';
import type { AdsForm } from './form';
import type { AdsModelOutput } from './prompt/output-schema';

/**
 * Checks the model's copy against the rules in code. Structured Outputs only
 * guarantees the JSON shape, not the counts, lengths or truthfulness. Each
 * problem is phrased so it can be sent back verbatim in a repair call.
 *
 * Numbers: offer ads may only use numbers found in Offer details; evergreen
 * ads may use none (they must stay true on any day), and also may not use
 * time/event words from ADS_EVERGREEN_BLOCKED_TERMS.
 */

// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001F\u007F]/;
const FORMULA_PREFIX = /^[=+\-@]/;


export function validateCreative(output: AdsModelOutput, form: AdsForm): string[] {
  const problems: string[] = [];
  if (output.ads.length !== RULES.adCount) {
    problems.push(`Return exactly ${RULES.adCount} ad${RULES.adCount === 1 ? '' : 's'} (got ${output.ads.length}).`);
  }
  const evergreen = form.adType === 'evergreen';
  const stackingStated = offerStatesStacking(form.offerDetails);
  const allowedNumbers = evergreen ? [] : numbersIn(withoutBrand(form.offerDetails, form.brandName));
  const brandWords = new Set(form.brandName.toUpperCase().split(/\s+/));

  output.ads.forEach((ad, adIndex) => {
    const adName = `Ad ${adIndex + 1}`;
    if (ad.headlines.length !== RULES.headlineCount) {
      problems.push(`${adName} needs exactly ${RULES.headlineCount} headlines (got ${ad.headlines.length}).`);
    }
    if (ad.descriptions.length !== RULES.descriptionCount) {
      problems.push(`${adName} needs exactly ${RULES.descriptionCount} descriptions (got ${ad.descriptions.length}).`);
    }
    ad.headlines.forEach((text, i) => {
      checkText(problems, `${adName} headline ${i + 1}`, text, RULES.headlineMin, RULES.headlineMax);
    });
    ad.descriptions.forEach((text, i) => {
      checkText(problems, `${adName} description ${i + 1}`, text, RULES.descriptionMin, RULES.descriptionMax);
    });

    const seen = new Set<string>();
    for (const headline of ad.headlines) {
      const key = headline.trim().toLowerCase();
      if (seen.has(key)) problems.push(`${adName} repeats the headline "${headline}".`);
      seen.add(key);
    }

    const brandHeadlines = ad.headlines.filter((text) => text.toLowerCase().includes(form.brandName.toLowerCase())).length;
    if (brandHeadlines < RULES.minBrandHeadlines) {
      problems.push(
        `${adName} has the full brand name "${form.brandName}" in ${brandHeadlines} of ${ad.headlines.length} headlines; ` +
        `at least ${RULES.minBrandHeadlines} are required. Add it to supporting headlines without removing the main offer.`,
      );
    }

    const first = (ad.headlines[0] ?? '').toLowerCase();
    if (!first.includes(form.brandName.toLowerCase())) {
      problems.push(`${adName} headline 1 must contain the full brand name "${form.brandName}".`);
    }
    if (!RULES.headline1Intents.some((word) => first.includes(word))) {
      problems.push(`${adName} headline 1 must say ${RULES.headline1Intents.join(', ')}.`);
    }

    for (const [field, text] of fieldsOf(adName, ad)) {
      const lower = text.toLowerCase();
      const banned = ADS_BANNED_COPY_PHRASES.find((phrase) => lower.includes(phrase));
      if (banned) problems.push(`${field} uses the banned phrase "${banned}": "${text}".`);

      const shouting = text.split(/\s+/).find((word) => /^[A-Z]{4,}$/.test(word) && !brandWords.has(word));
      if (shouting) problems.push(`${field} uses the ALL-CAPS word "${shouting}".`);

      const unsupported = numbersIn(withoutBrand(text, form.brandName)).filter((n) => !allowedNumbers.includes(n));
      if (unsupported.length) {
        problems.push(evergreen
          ? `${field} uses ${unsupported.join(', ')}; evergreen ads must not contain numbers. Rewrite without it: "${text}".`
          : `${field} uses ${unsupported.join(', ')}, which is not in OFFER DETAILS. Remove it or use a stated figure: "${text}".`);
      }
      if (evergreen) {
        const dated = hasAnyTerm(text, ADS_EVERGREEN_BLOCKED_TERMS);
        if (dated) problems.push(`${field} uses "${dated}", which goes stale; evergreen ads must stay true on any day: "${text}".`);
      } else if (!stackingStated && numbersIn(text).length) {
        const joiner = hasAnyTerm(text, ADS_STACKING_COPY_TERMS);
        if (joiner) {
          problems.push(
            `${field} joins offers with "${joiner}", but OFFER DETAILS does not say they can be combined. ` +
            `State each offer separately: "${text}".`,
          );
        }
      }
    }
  });
  return problems;
}

function checkText(problems: string[], field: string, text: string, min: number, max: number): void {
  const length = [...text].length;
  if (length < min || length > max) {
    problems.push(`${field} is ${length} characters; it must be ${min}-${max}: "${text}".`);
  }
  if (text !== text.trim()) problems.push(`${field} has leading or trailing spaces.`);
  if (UNSAFE_TEXT.test(text)) problems.push(`${field} contains a line break or control character.`);
  if (FORMULA_PREFIX.test(text)) problems.push(`${field} must not start with = + - or @.`);
}

function fieldsOf(adName: string, ad: AdsModelOutput['ads'][number]): Array<[string, string]> {
  return [
    ...ad.headlines.map((text, i): [string, string] => [`${adName} headline ${i + 1}`, text]),
    ...ad.descriptions.map((text, i): [string, string] => [`${adName} description ${i + 1}`, text]),
  ];
}

/** Explicit "can be combined" wording, and no "not stackable"-style denial. */
function offerStatesStacking(offerDetails: string): boolean {
  if (hasAnyTerm(offerDetails, ADS_NON_STACKING_TERMS)) return false;
  return Boolean(hasAnyTerm(offerDetails, ADS_STACKING_EVIDENCE_TERMS));
}
