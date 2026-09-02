// Translation OUTPUT VALIDATION: per-key checks over the LLM's JSON batch.
// A failed key is retried once with a corrective instruction
// (translate-entry.ts); what still fails is rejected before any locale write.
// checks are deliberately structural — natural-language quality is the
// prompt's job, structure and facts are ours.
import type { TranslatableLeaf } from './field-map';

export type LeafProblem =
  | 'missing'
  | 'empty'
  | 'not-a-string'
  | 'over-budget'
  | 'html-structure-changed'
  | 'protected-value-changed'
  | 'untranslated-source'
  | 'target-language-missing'
  | 'unexpected-key';

export type LeafVerdict = {
  path: string;
  problems: LeafProblem[];
};

function htmlStructure(html: string): string[] {
  return (html.match(/<!--[\s\S]*?-->|<[^>]+>/gu) ?? []).map((tag) =>
    tag.replace(/\s+/gu, ' ').trim(),
  );
}

function sameHtmlStructure(source: string, translated: string): boolean {
  const sourceTags = htmlStructure(source);
  const translatedTags = htmlStructure(translated);
  return (
    sourceTags.length === translatedTags.length &&
    sourceTags.every((tag, index) => tag === translatedTags[index])
  );
}

/**
 * Identifiers that must survive translation verbatim: URLs and email
 * addresses embedded in the text. (Coupon codes never enter the pipeline —
 * `code` fields are non-localized — so codes inside prose are the LLM's
 * brief, not a hard gate: too many false positives on ALL-CAPS words.)
 */
function protectedPatterns(): RegExp[] {
  return [
    /https?:\/\/[^\s"'<>]+/gu,
    /[\w.+-]+@[\w-]+\.[\w.]+/gu,
    /\{\{[^{}]+\}\}|\$\{[^{}]+\}|\{[a-zA-Z_][\w.-]*\}|%[a-z]/gu,
    currencyAmountPattern(),
    /\d[\d,.]*\s*(?:%|٪)/gu,
    /\b\d[\d,.]*(?:st|nd|rd|th)?\b/giu,
  ];
}

export function protectedValues(value: string): string[] {
  const patterns = protectedPatterns();
  return patterns.flatMap((pattern) => value.match(pattern) ?? []);
}

export type ProtectedValueMask = {
  masked: string;
  restore: (translated: string) => string;
};

/**
 * Replace protected facts before they reach the model. Asking a model to copy
 * `AED 150`, `20%`, a URL, or a placeholder verbatim is weaker than making
 * the value unavailable to change. Tokens remain in the surrounding sentence
 * so the model can translate its grammar; the exact source bytes are restored
 * before output validation and persistence.
 */
export function maskProtectedValues(value: string): ProtectedValueMask {
  const spans: Array<{ start: number; end: number; value: string }> = [];
  for (const pattern of protectedPatterns()) {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const matcher = new RegExp(pattern.source, flags);
    for (let match = matcher.exec(value); match; match = matcher.exec(value)) {
      const matched = match[0];
      if (!matched) {
        matcher.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + matched.length;
      if (spans.some((span) => start < span.end && end > span.start)) continue;
      spans.push({ start, end, value: matched });
    }
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  if (spans.length === 0) return { masked: value, restore: (text) => text };

  const replacements = spans.map((span, index) => ({
    ...span,
    token: `{{CG_PROTECTED_${index}}}`,
  }));
  let masked = '';
  let cursor = 0;
  for (const replacement of replacements) {
    masked += value.slice(cursor, replacement.start) + replacement.token;
    cursor = replacement.end;
  }
  masked += value.slice(cursor);

  return {
    masked,
    restore(translated: string) {
      return replacements.reduce(
        (current, replacement) =>
          current.split(replacement.token).join(replacement.value),
        translated,
      );
    },
  };
}

/**
 * Any currency, not a per-site list: every ISO 4217 code ICU knows plus the
 * common symbols and Arabic abbreviations, before OR after the amount. The
 * code list is case-sensitive so ordinary words ("GET 50") stay unprotected.
 */
let currencyAmountRegExp: RegExp | null = null;

export function currencyAmountPattern(): RegExp {
  if (!currencyAmountRegExp) {
    // ES2022 API; the compile target's lib predates it. Node 22 has it.
    const intl = Intl as typeof Intl & {
      supportedValuesOf?: (key: 'currency') => string[];
    };
    const codes = (intl.supportedValuesOf?.('currency') ?? []).join('|');
    const symbols = '[$€£¥₹₩₺₪฿₫₱₦₴₵₡₲₭₮₸₼₽₾₿]';
    const arabic = 'د\\.إ|ر\\.س|ج\\.م|د\\.ك|ر\\.ق|د\\.ب|ر\\.ع|د\\.ا|ل\\.ل|د\\.م';
    const code = codes ? `\\b(?:${codes})\\b|` : '';
    const unit = `(?:${code}${symbols}|${arabic})`;
    const amount = '\\d[\\d,.]*';
    currencyAmountRegExp = new RegExp(
      `${unit}\\s*${amount}|${amount}\\s*${unit}`,
      'gu',
    );
  }
  currencyAmountRegExp.lastIndex = 0;
  return currencyAmountRegExp;
}

function keepsProtectedValues(source: string, translated: string): boolean {
  const ordered = (value: string) => [...protectedValues(value)].sort();
  const expected = ordered(source);
  const actual = ordered(translated);
  return (
    expected.length === actual.length &&
    expected.every((identifier, index) => identifier === actual[index])
  );
}

function isEnglishProse(value: string): boolean {
  const text = value.replace(/<[^>]+>/gu, ' ');
  const words = text.match(/[a-z]+(?:['’-][a-z]+)?/giu) ?? [];
  return words.length >= 2 && words.join('').length >= 8;
}

function sameVisibleText(source: string, translated: string): boolean {
  const normalize = (value: string) =>
    value.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ').trim().toLowerCase();
  return normalize(source) === normalize(translated);
}

/**
 * Validate one batch response against its leaves. Returns ONLY the leaves
 * with problems — an empty array is a clean pass.
 *
 * `targetScript` (from unicodeScriptPattern) enables the "target language
 * missing" check: English prose whose output contains no character of the
 * target script was left untranslated. Null for Latin-script targets, where
 * the check cannot distinguish source from translation.
 */
export function validateTranslatedBatch(
  leaves: readonly TranslatableLeaf[],
  translated: Record<string, unknown>,
  targetScript?: RegExp | null,
): LeafVerdict[] {
  const verdicts: LeafVerdict[] = [];
  const expectedPaths = new Set(leaves.map((leaf) => leaf.path));
  for (const leaf of leaves) {
    const problems: LeafProblem[] = [];
    const value = translated[leaf.path];
    if (value === undefined) {
      problems.push('missing');
    } else if (typeof value !== 'string') {
      problems.push('not-a-string');
    } else {
      if (!value.trim()) problems.push('empty');
      if (leaf.maxLength && [...value].length > leaf.maxLength) {
        problems.push('over-budget');
      }
      if (leaf.kind === 'richtext' && !sameHtmlStructure(leaf.value, value)) {
        problems.push('html-structure-changed');
      }
      if (!keepsProtectedValues(leaf.value, value)) {
        problems.push('protected-value-changed');
      }
      // Root taxonomy names are often proper brand names ("Golden Scent",
      // "American Eagle") that Arabic editorial convention may legitimately
      // retain in Latin script. They are still offered to the translator; we
      // simply do not misclassify an unchanged brand identity as prose.
      const enforceTranslatedProse = leaf.path !== 'name' && isEnglishProse(leaf.value);
      if (enforceTranslatedProse && sameVisibleText(leaf.value, value)) {
        problems.push('untranslated-source');
      }
      if (targetScript && enforceTranslatedProse && !targetScript.test(value)) {
        problems.push('target-language-missing');
      }
    }
    if (problems.length) verdicts.push({ path: leaf.path, problems });
  }
  for (const path of Object.keys(translated)) {
    if (!expectedPaths.has(path)) {
      verdicts.push({ path, problems: ['unexpected-key'] });
    }
  }
  return verdicts;
}
