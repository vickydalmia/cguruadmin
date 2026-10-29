import {
  ADS_ALLOWED_LANDING_DOMAINS,
  ADS_ALLOWED_LANDING_HOSTS,
  ADS_BLOCKED_INPUT_PATTERNS,
} from '../constants/ads-generator';
import type { AdsForm } from './form';

/**
 * Deterministic "is this a real ad brief?" checks that run BEFORE any paid
 * call. The form has no free prompt field, so the only ways to steer the model
 * off-topic are the text values themselves; these checks close that door
 * without spending tokens on an LLM classifier.
 */

/** Letters (any script), digits, spaces and the punctuation real brand names use. */
const BRAND_NAME = /^[\p{L}\p{N}][\p{L}\p{N} &'.,+-]*$/u;
const URL_IN_TEXT = /\bhttps?:\/\/|\bwww\./i;

export function checkRelevance(form: AdsForm): string[] {
  const problems: string[] = [];

  const host = new URL(form.landingPage).hostname.toLowerCase();
  if (!ADS_ALLOWED_LANDING_HOSTS.includes(host)) {
    problems.push(`Landing page must be on a CouponzGuru website: ${ADS_ALLOWED_LANDING_DOMAINS.join(', ')}.`);
  }

  if (!BRAND_NAME.test(form.brandName)) {
    problems.push('Brand name may only contain letters, numbers, spaces and & \' . , + -');
  }

  if (URL_IN_TEXT.test(form.offerDetails)) {
    problems.push('Offer details must not contain links; put the page in Landing page.');
  }
  if (form.brandCategories.some((category) => URL_IN_TEXT.test(category))) {
    problems.push('Brand categories must not contain links.');
  }

  const fields: Array<[string, string]> = [
    ['Campaign name', form.campaignName],
    ['Brand name', form.brandName],
    ['Label', form.label],
    ['Offer details', form.offerDetails],
    ...form.negativeKeywordLists.map((name): [string, string] => ['Negative keyword lists', name]),
    ...form.countries.map((name): [string, string] => ['Countries', name]),
    ...form.brandCategories.map((name): [string, string] => ['Brand categories', name]),
  ];
  for (const [field, value] of fields) {
    const lower = value.toLowerCase();
    const hit = ADS_BLOCKED_INPUT_PATTERNS.find((pattern) => lower.includes(pattern));
    if (hit) problems.push(`${field} contains text that is not allowed in an ad brief ("${hit}").`);
  }

  return problems;
}
