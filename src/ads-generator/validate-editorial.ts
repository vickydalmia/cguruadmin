import { ADS_EDITORIAL_RULES as RULES, ADS_FILLER_PHRASES, ADS_TRUST_TERMS, type GeneratedAd } from '../constants/ads-generator';
import { hasAnyTerm, numbersIn, withoutBrand } from './copy-text';
import type { AdsForm } from './form';

/**
 * Readability checks from the 30 Oct 2026 prompt revisions: brand stuffing
 * above the editorial maximum (the revision-3 minimum is blocking, in
 * ./validate-creative.ts), coupon-synonym stuffing, CouponzGuru
 * self-promotion, "browse/check the listing" and "For Less" filler, too few
 * brand + offer (or brand + category + coupon term) headlines, and stuffed
 * (optional) trust terms (ADS_TRUST_TERMS). These are NOT blocking: generate-ads.ts sends them to the
 * repair call, and anything left after the repair budget becomes a reviewer
 * warning. They cannot prove copy is good, only flag the common bad patterns.
 */

/** "coupon(s)" or "promo" as words: "CouponzGuru" is deliberately not a match. */
const COUPON_INTENT = /\bcoupons?\b|\bpromo\b/i;
const COUPONZGURU = /couponzguru/i;

export function checkEditorial(ads: GeneratedAd[], form: AdsForm): string[] {
  const issues: string[] = [];
  const brandName = form.brandName;
  const brand = normalize(brandName);
  const hasBrand = (text: string) => normalize(text).includes(brand);
  const instruction = new RegExp(`^(?:${RULES.instructionVerbs.join('|')})\\b`, 'i');

  ads.forEach((ad, index) => {
    const name = `Ad ${index + 1}`;
    const count = (lines: string[], test: (text: string) => boolean) => lines.filter(test).length;

    const brandHeadlines = count(ad.headlines, hasBrand);
    if (brandHeadlines > RULES.maxBrandHeadlines) {
      issues.push(`${name} uses "${brandName}" in ${brandHeadlines} headlines; keep it to ${RULES.maxBrandHeadlines} at most and give the others a distinct offer fact or benefit.`);
    }
    const brandDescriptions = count(ad.descriptions, hasBrand);
    if (brandDescriptions > RULES.maxBrandDescriptions) {
      issues.push(`${name} uses "${brandName}" in ${brandDescriptions} descriptions; keep it to ${RULES.maxBrandDescriptions}, including description 1.`);
    }
    if (ad.descriptions[0] && !hasBrand(ad.descriptions[0])) {
      issues.push(`${name} description 1 should mention "${brandName}" with the main offer.`);
    }

    const couponHeadlines = count(ad.headlines, (text) => COUPON_INTENT.test(text));
    if (couponHeadlines > RULES.maxCouponIntentHeadlines) {
      issues.push(`${name} has coupon/promo wording in ${couponHeadlines} headlines; keep it to ${RULES.maxCouponIntentHeadlines} at most and mix in discount, offer, deal or product messages.`);
    }
    if (count(ad.headlines, (text) => COUPONZGURU.test(text)) > RULES.maxCouponzGuruHeadlines) {
      issues.push(`${name} mentions CouponzGuru in more than ${RULES.maxCouponzGuruHeadlines} headline.`);
    }
    if (count(ad.descriptions, (text) => COUPONZGURU.test(text)) > RULES.maxCouponzGuruDescriptions) {
      issues.push(`${name} mentions CouponzGuru in more than ${RULES.maxCouponzGuruDescriptions} description.`);
    }

    const hooked = count(ad.headlines, (text) => hasBrand(text) && hasHook(text, form));
    if (hooked < RULES.minBrandHookHeadlines) {
      issues.push(form.adType === 'offer'
        ? `${name} pairs "${brandName}" with an offer fact in ${hooked} headline${hooked === 1 ? '' : 's'}; make at least ${RULES.minBrandHookHeadlines} like "${brandName} Up To 50% Off Shoes", using only figures from OFFER DETAILS.`
        : `${name} pairs "${brandName}" with a category and a coupon term in ${hooked} headline${hooked === 1 ? '' : 's'}; make at least ${RULES.minBrandHookHeadlines} like "${brandName} Shoe Coupon Codes", using only supplied categories.`);
    }

    // Trust terms are optional; only stuffing is flagged.
    const trusted = (text: string) => Boolean(hasAnyTerm(text, ADS_TRUST_TERMS));
    const trustHeadlines = count(ad.headlines, trusted);
    if (trustHeadlines > RULES.maxTrustHeadlines) {
      issues.push(`${name} uses trust terms (${ADS_TRUST_TERMS.join(', ')}) in ${trustHeadlines} headlines; keep them to ${RULES.maxTrustHeadlines} at most, where they read naturally.`);
    }
    const trustDescriptions = count(ad.descriptions, trusted);
    if (trustDescriptions > RULES.maxTrustDescriptions) {
      issues.push(`${name} uses trust terms in ${trustDescriptions} descriptions; keep them to ${RULES.maxTrustDescriptions} at most.`);
    }

    const instructions = count(ad.headlines.slice(2), (text) => instruction.test(text.trim()));
    if (instructions > RULES.maxInstructionHeadlines) {
      issues.push(`${name} has ${instructions} supporting headlines that only say ${RULES.instructionVerbs.join('/')}; replace them with offer facts, categories or saving benefits.`);
    }

    [...ad.headlines.map((text, i) => [`headline ${i + 1}`, text]), ...ad.descriptions.map((text, i) => [`description ${i + 1}`, text])]
      .forEach(([field, text]) => {
        // Brand removed first so "Listed Myntra Deal" still reads as "listed deal".
        const plain = normalize(normalize(text).split(brand).join(' '));
        const filler = ADS_FILLER_PHRASES.find((phrase) => plain.includes(phrase));
        if (filler) issues.push(`${name} ${field} uses vague filler "${filler}": "${text}".`);
      });

    for (const [first, second, swapped] of nearDuplicateHeadlines(ad.headlines)) {
      issues.push(
        `${name} headlines ${first + 1} and ${second + 1} are the same pattern with one word swapped ("${swapped}"): ` +
        `"${ad.headlines[first]}" / "${ad.headlines[second]}". Rewrite one with a different shape.`,
      );
    }

    const seen = new Set<string>();
    for (const description of ad.descriptions) {
      const key = normalize(description);
      if (seen.has(key)) issues.push(`${name} repeats the description "${description}".`);
      seen.add(key);
    }
  });
  return issues;
}

/**
 * Offer ads: the headline uses a number that is in Offer details. Evergreen
 * ads: it names a supplied category (singular or plural) and a coupon term.
 */
function hasHook(text: string, form: AdsForm): boolean {
  if (form.adType === 'offer') {
    const offerNumbers = numbersIn(withoutBrand(form.offerDetails, form.brandName));
    return numbersIn(withoutBrand(text, form.brandName)).some((n) => offerNumbers.includes(n));
  }
  const lower = normalize(text);
  const namesCategory = form.brandCategories.some((category) => {
    const name = normalize(category);
    return lower.includes(name) || lower.includes(name.replace(/s$/, ''));
  });
  return namesCategory && Boolean(hasAnyTerm(text, [...RULES.couponTerms, ...RULES.couponTerms.map((term) => `${term}s`)]));
}

/**
 * Pairs of headlines with the same words in the same order except exactly one
 * ("Myntra Fashion Up To 50% Off" / "Myntra Clothing Up To 50% Off"). Exact
 * duplicates are a mechanical error elsewhere, so they are not reported here.
 */
function nearDuplicateHeadlines(headlines: string[]): Array<[number, number, string]> {
  const words = headlines.map((text) => normalize(text).replace(/[^\p{L}\p{N}%\s]/gu, ' ').split(/\s+/).filter(Boolean));
  const pairs: Array<[number, number, string]> = [];
  for (let a = 0; a < words.length; a += 1) {
    for (let b = a + 1; b < words.length; b += 1) {
      // Short headlines change meaning with one word ("Myntra Coupons & Discounts"
      // vs "Myntra Clothing Discounts"), so only 4+ word headlines are compared.
      if (words[a].length < 4 || words[a].length !== words[b].length) continue;
      const differing = words[a].map((word, i) => i).filter((i) => words[a][i] !== words[b][i]);
      if (differing.length === 1) pairs.push([a, b, `${words[a][differing[0]]}/${words[b][differing[0]]}`]);
    }
  }
  return pairs;
}

function normalize(text: string): string {
  return text.toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
}
