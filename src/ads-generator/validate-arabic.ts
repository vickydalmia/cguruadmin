import {
  ADS_ARABIC_BANNED_PHRASES,
  ADS_ARABIC_CLAIM_EVIDENCE,
  ADS_ARABIC_EVERGREEN_BLOCKED_TERMS,
  ADS_ARABIC_NUMBER_WORDS,
  ADS_BANNED_COPY_PHRASES,
  ADS_CREATIVE_RULES as RULES,
  type GeneratedAd,
} from '../constants/ads-generator';
import { numbersIn, withoutBrand } from './copy-text';
import type { AdsForm } from './form';

/**
 * Checks a translation against its validated English line. Arabic has no
 * minimum length because it is often shorter; Google's maximums still apply.
 * Each problem is phrased so it can be sent back in a repair call.
 */

const ARABIC_LETTER = /[\u0621-\u064A]/;
const ARABIC_DIGIT = /[\u0660-\u0669\u06F0-\u06F9]/;
const DIACRITIC = /[\u064B-\u0652]/;
const DIRECTION_MARK = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u001F\u007F]/;
const FORMULA_PREFIX = /^[=+\-@]/;
const LETTER_DIGIT_TOKEN = /\b(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{3,}\b/gi;
const NAMED_CODE = /\bcodes?\s*[:\-]?\s*([a-z0-9]{3,})\b/gi;
const NOT_A_CODE = new Set(['not', 'none', 'supplied', 'required', 'needed', 'applies', 'and', 'for', 'at', 'with', 'from']);
const ENGLISH_NUMBER_WORD = /\b(one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|half|quarter)\b/i;
const SITE_NAME = 'couponzguru';

const sorted = (values: string[]) => [...values].sort().join(',');

/** One spelling for the letter variants, so a blocklist cannot be missed by hamza or ta marbuta. */
export function normalizeArabic(text: string): string {
  return text.replace(/[\u064B-\u0652]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase();
}

/** Whole-word match that allows the attached prefixes and common endings. */
function hasArabicTerm(normalized: string, terms: readonly string[]): string | undefined {
  return terms.find((term) => new RegExp(
    `(?:^|[^\\u0621-\\u064A])[وفبلك]?(?:ال)?${term.replace(/ /g, '\\s+')}(?:ه|ها|ات)?(?=$|[^\\u0621-\\u064A])`,
  ).test(normalized));
}

/** Codes in this English line: letter-digit tokens, and any code Offer details names. */
function codesIn(source: string, form: AdsForm): string[] {
  const line = withoutBrand(source, form.brandName);
  const named: string[] = [...(form.offerDetails ?? '').matchAll(NAMED_CODE)]
    .map((match) => String((match as RegExpMatchArray)[1]))
    .filter((code) => !NOT_A_CODE.has(code.toLowerCase()));
  const words: string[] = line.match(/[a-z0-9]+/gi) ?? [];
  const namedInLine = words.filter((word) => named.some((code) => code.toLowerCase() === word.toLowerCase()));
  return [...new Set([...(line.match(LETTER_DIGIT_TOKEN) ?? []), ...namedInLine])];
}

function checkLine(problems: string[], field: string, source: string, text: string, max: number, form: AdsForm): void {
  const length = [...text].length;
  if (!length || length > max) problems.push(`${field} is ${length} characters; it must be 1-${max}: "${text}".`);
  if (text !== text.trim()) problems.push(`${field} has leading or trailing spaces.`);
  if (!ARABIC_LETTER.test(text)) problems.push(`${field} is not in Arabic: "${text}".`);
  if (ARABIC_DIGIT.test(text)) problems.push(`${field} must use Western digits (0-9): "${text}".`);
  if (DIACRITIC.test(text)) problems.push(`${field} must not use diacritics: "${text}".`);
  if (DIRECTION_MARK.test(text) || UNSAFE_TEXT.test(text)) problems.push(`${field} contains an invisible or control character.`);
  if (FORMULA_PREFIX.test(text)) problems.push(`${field} must not start with = + - or @.`);

  const lower = text.toLowerCase();
  const normalized = normalizeArabic(text);
  const banned = hasArabicTerm(normalized, ADS_ARABIC_BANNED_PHRASES) ?? ADS_BANNED_COPY_PHRASES.find((phrase) => lower.includes(phrase));
  if (banned) problems.push(`${field} uses the banned phrase "${banned}": "${text}".`);

  if (source.toLowerCase().includes(form.brandName.toLowerCase()) && !text.includes(form.brandName)) {
    problems.push(`${field} must keep the brand "${form.brandName}" in Latin letters: "${text}".`);
  }
  if (source.toLowerCase().includes(SITE_NAME) && !lower.includes(SITE_NAME)) {
    problems.push(`${field} must keep CouponzGuru in Latin letters: "${text}".`);
  }
  const expected = numbersIn(withoutBrand(source, form.brandName));
  const actual = numbersIn(withoutBrand(text, form.brandName));
  if (sorted(expected) !== sorted(actual)) {
    problems.push(`${field} must contain exactly the numbers [${expected.join(', ')}] from the English; it has [${actual.join(', ')}]: "${text}".`);
  }
  for (const code of codesIn(source, form)) {
    if (!text.includes(code)) problems.push(`${field} must keep the code ${code} unchanged: "${text}".`);
  }
  if (form.adType === 'evergreen') {
    const dated = hasArabicTerm(normalized, ADS_ARABIC_EVERGREEN_BLOCKED_TERMS);
    if (dated) problems.push(`${field} uses "${dated}", which goes stale; evergreen ads must stay true on any day: "${text}".`);
  }
  if (!ENGLISH_NUMBER_WORD.test(source)) {
    const spelled = hasArabicTerm(normalized, ADS_ARABIC_NUMBER_WORDS);
    if (spelled) problems.push(`${field} spells out a number ("${spelled}") that the English line does not state: "${text}".`);
  }
  for (const claim of ADS_ARABIC_CLAIM_EVIDENCE) {
    const added = hasArabicTerm(normalized, claim.arabic);
    if (added && !claim.english.test(source)) problems.push(`${field} adds the claim "${added}", which the English line does not state: "${text}".`);
  }
}

export function validateArabic(english: GeneratedAd[], arabic: GeneratedAd[], form: AdsForm): string[] {
  if (arabic.length !== english.length) return [`Return exactly ${english.length} ad(s) (got ${arabic.length}).`];
  const problems: string[] = [];
  english.forEach((source, adIndex) => {
    const ad = arabic[adIndex];
    const name = `Ad ${adIndex + 1}`;
    if (ad.headlines.length !== source.headlines.length) problems.push(`${name} needs exactly ${source.headlines.length} headlines (got ${ad.headlines.length}).`);
    if (ad.descriptions.length !== source.descriptions.length) problems.push(`${name} needs exactly ${source.descriptions.length} descriptions (got ${ad.descriptions.length}).`);
    ad.headlines.slice(0, source.headlines.length).forEach((text, i) => checkLine(problems, `${name} headline ${i + 1}`, source.headlines[i], text, RULES.headlineMax, form));
    ad.descriptions.slice(0, source.descriptions.length).forEach((text, i) => checkLine(problems, `${name} description ${i + 1}`, source.descriptions[i], text, RULES.descriptionMax, form));
    const unique = new Set(ad.headlines.map((text) => text.trim()));
    if (unique.size !== ad.headlines.length) problems.push(`${name} repeats a headline.`);
  });
  return problems;
}
