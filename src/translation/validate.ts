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
function protectedValues(value: string): string[] {
  const patterns = [
    /https?:\/\/[^\s"'<>]+/gu,
    /[\w.+-]+@[\w-]+\.[\w.]+/gu,
    /\{\{[^{}]+\}\}|\$\{[^{}]+\}|\{[a-zA-Z_][\w.-]*\}|%[a-z]/gu,
    /(?:AED|USD|EUR|GBP|د\.إ)\s*\d[\d,.]*/giu,
    /\d[\d,.]*\s*(?:%|٪)/gu,
    /\b\d[\d,.]*(?:st|nd|rd|th)?\b/giu,
  ];
  return patterns.flatMap((pattern) => value.match(pattern) ?? []);
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
 */
export function validateTranslatedBatch(
  leaves: readonly TranslatableLeaf[],
  translated: Record<string, unknown>,
  targetLocale?: string,
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
      if (isEnglishProse(leaf.value) && sameVisibleText(leaf.value, value)) {
        problems.push('untranslated-source');
      }
      if (
        targetLocale === 'ar' &&
        isEnglishProse(leaf.value) &&
        !/\p{Script=Arabic}/u.test(value)
      ) {
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
