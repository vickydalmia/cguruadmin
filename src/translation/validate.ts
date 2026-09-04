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
 * A number with optional thousands/decimal separators, where every separator
 * must be followed by a digit. English keeps an amount mid-sentence ("AED 749
 * onwards"); natural Arabic routinely ends the clause with it ("تبدأ من AED
 * 749."), and a greedy `[\d,.]*` made the sentence-ending "." part of the
 * amount on the output side only — the whole UAE backfill failed on it.
 */
const AMOUNT = '\\d+(?:[,.]\\d+)*';

/**
 * Identifiers that must survive translation verbatim: URLs and email
 * addresses embedded in the text. (Coupon codes never enter the pipeline —
 * `code` fields are non-localized — so codes inside prose are the LLM's
 * brief, not a hard gate: too many false positives on ALL-CAPS words.)
 */
export type ProtectedSpanKind =
  | 'html'
  | 'html-entity'
  | 'url'
  | 'email'
  | 'placeholder'
  | 'currency'
  | 'percentage'
  | 'date'
  | 'time'
  | 'version'
  | 'range'
  | 'phone'
  | 'number';

export type ProtectedSpan = {
  start: number;
  end: number;
  value: string;
  kind: ProtectedSpanKind;
};

/**
 * Consume one complete HTML tag/comment, respecting quoted `>` characters in
 * attributes. A regex such as `<[^>]+>` splits `<a title="1 > 0">` and then
 * lets the model rewrite the rest of the tag, which is exactly the structure
 * the marker boundary is meant to make unavailable.
 */
function htmlSpanAt(value: string, start: number): ProtectedSpan | null {
  if (value.startsWith('<!--', start)) {
    const close = value.indexOf('-->', start + 4);
    if (close === -1) return null;
    const end = close + 3;
    return { start, end, value: value.slice(start, end), kind: 'html' };
  }
  if (value[start] !== '<') return null;
  let quote: '"' | "'" | null = null;
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') {
      const end = index + 1;
      return { start, end, value: value.slice(start, end), kind: 'html' };
    }
  }
  return null;
}

/**
 * Match `pattern` exactly at `start` of the FULL string (sticky), never on a
 * slice: a `\b` or lookbehind at the pattern's left edge must see the real
 * neighbouring character. Anchoring `^` on `value.slice(start)` made every
 * offset a word boundary, so "FALL 20%" protected "ALL 20" (the lek code) and
 * "Kumar 10%" protected "mar 10".
 */
function anchoredAt(pattern: RegExp, value: string, start: number): string | null {
  const flags = pattern.flags.replace(/[gy]/gu, '') + 'y';
  const sticky = new RegExp(pattern.source, flags);
  sticky.lastIndex = start;
  const match = sticky.exec(value);
  return match?.[0] || null;
}

function phoneAt(value: string, start: number): string | null {
  const matched = anchoredAt(
    /(?:\+\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?){2,5}\d{2,4}/u,
    value,
    start,
  );
  if (!matched) return null;
  const digitCount = matched.match(/\d/gu)?.length ?? 0;
  return digitCount >= 7 && digitCount <= 15 ? matched : null;
}

function urlAt(value: string, start: number): string | null {
  const matched = anchoredAt(/https?:\/\/[^\s"'<>]+/u, value, start);
  // Sentence full stops and commas are delimiters. Other trailing punctuation
  // (`)`, `]`, `?`, `!`, `;`, `:`) is valid URL data and remains protected.
  return matched?.replace(/[.,]+$/u, '') || null;
}

/**
 * Ordered, non-overlapping tokenizer. At each source offset the most specific
 * atomic forms win before the catch-all number rule. This prevents a date,
 * version, phone number or currency amount from becoming several separately
 * movable markers and makes one source byte belong to at most one marker.
 */
export function protectedSpans(
  value: string,
  options: { includeHtml?: boolean } = {},
): ProtectedSpan[] {
  const spans: ProtectedSpan[] = [];
  for (let start = 0; start < value.length;) {
    if (options.includeHtml) {
      const html = htmlSpanAt(value, start);
      if (html) {
        spans.push(html);
        start = html.end;
        continue;
      }
    }

    const candidates: Array<[ProtectedSpanKind, string | null]> = [
      // URLs intentionally retain all non-delimiter trailing bytes. `)`, `]`,
      // `?`, `!`, `;` and `:` are valid URL data and must not be peeled off by
      // sentence-punctuation heuristics.
      ['url', urlAt(value, start)],
      ['email', anchoredAt(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u, value, start)],
      [
        'placeholder',
        anchoredAt(/\{\{[^{}]+\}\}|\$\{[^{}]+\}|\{[a-zA-Z_][\w.-]*\}|%[a-z]/u, value, start),
      ],
      // Keep character references whole. Without this, `&#8217;` became
      // `&#{{CGPV_A}};` and any entity normalization destroyed the marker.
      ['html-entity', anchoredAt(/&(?:#\d+|#x[\da-f]+|[a-z][a-z0-9]+);/iu, value, start)],
      ['currency', anchoredAt(currencyAmountPattern(), value, start)],
      ['percentage', anchoredAt(new RegExp(`${AMOUNT}\\s*(?:%|٪)`, 'u'), value, start)],
      // Numeric dates only. A month NAME is prose the translator must render
      // ("Dec" -> "ديسمبر"); the day and year around it are protected by the
      // number rule as two whole numbers. The earlier month-name branch
      // consumed just two digits of a year ("31 Dec 2026" -> `31`, `Dec 20`,
      // `26`) and, because markers may legitimately move, restored to a
      // different date.
      ['date', anchoredAt(/\d{1,4}[-\/.]\d{1,2}[-\/.]\d{1,4}/u, value, start)],
      ['time', anchoredAt(/\d{1,2}:\d{2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?/iu, value, start)],
      ['version', anchoredAt(/(?:v(?:ersion)?\s*)?\d+(?:\.\d+){1,4}/iu, value, start)],
      ['range', anchoredAt(new RegExp(`${AMOUNT}\\s*(?:-|–|—|to)\\s*${AMOUNT}`, 'iu'), value, start)],
      ['phone', phoneAt(value, start)],
      // No word boundary: digits glued to words ("90ml") are immutable too.
      ['number', anchoredAt(new RegExp(`${AMOUNT}(?:st|nd|rd|th)?`, 'iu'), value, start)],
    ];
    const found = candidates.find(([, matched]) => Boolean(matched));
    if (!found?.[1]) {
      start += 1;
      continue;
    }
    const [kind, matched] = found as [ProtectedSpanKind, string];
    const end = start + matched.length;
    spans.push({ start, end, value: matched, kind });
    start = end;
  }
  return spans;
}

export function protectedValues(value: string): string[] {
  return protectedSpans(value).map((span) => span.value);
}

export type ProtectedValueMask = {
  masked: string;
  /** Marker labels (A, B, … AA) in source order — one per masked span. */
  labels: string[];
  /** Restored codepoints minus marker codepoints for exact output budgeting. */
  restoredLengthDelta: number;
  restore: (translated: string) => string;
};

function markerLabel(index: number): string {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function markerPattern(label: string): RegExp {
  return new RegExp(`\\{\\{CGPV_${label}\\}\\}`, 'gu');
}

/** Any exact marker, whatever its label. Malformed spellings count as missing. */
function anyMarkerPattern(): RegExp {
  return /\{\{CGPV_([A-Z]+)\}\}/gu;
}

/** The model's text with every marker removed: what it wrote on its own. */
export function stripMarkers(value: string): string {
  return value.replace(anyMarkerPattern(), ' ');
}

/**
 * Replace protected facts before they reach the model. Asking a model to copy
 * `AED 150`, `20%`, a URL, or a placeholder verbatim is weaker than making
 * the value unavailable to change. Tokens remain in the surrounding sentence
 * so the model can translate its grammar; the exact source bytes are restored
 * before output validation and persistence.
 */
export function maskProtectedValues(value: string): ProtectedValueMask {
  const spans = protectedSpans(value, { includeHtml: true });
  if (spans.length === 0) {
    return { masked: value, labels: [], restoredLengthDelta: 0, restore: (text) => text };
  }

  const replacements = spans.map((span, index) => ({
    ...span,
    label: markerLabel(index),
    token: `{{CGPV_${markerLabel(index)}}}`,
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
    labels: replacements.map((replacement) => replacement.label),
    restoredLengthDelta: replacements.reduce(
      (sum, replacement) =>
        sum + [...replacement.value].length - [...replacement.token].length,
      0,
    ),
    restore(translated: string) {
      return replacements.reduce(
        (current, replacement) =>
          current.replace(markerPattern(replacement.label), () => replacement.value),
        translated,
      );
    },
  };
}

/**
 * Any currency, not a per-site list: every ISO 4217 code ICU knows plus the
 * common symbols and Arabic abbreviations, before OR after the amount. The
 * code list is case-sensitive so ordinary words ("GET 50") stay unprotected.
 * The word boundary sits on the OUTER side of a code only, so "AED400" is
 * one fact rather than an unprotected code beside an unprotected number.
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
    const leading = codes ? `\\b(?:${codes})|` : '';
    const trailing = codes ? `(?:${codes})\\b|` : '';
    const unitBefore = `(?:${leading}${symbols}|${arabic})`;
    const unitAfter = `(?:${trailing}${symbols}|${arabic})`;
    currencyAmountRegExp = new RegExp(
      `${unitBefore}\\s*${AMOUNT}|${AMOUNT}\\s*${unitAfter}`,
      'gu',
    );
  }
  currencyAmountRegExp.lastIndex = 0;
  return currencyAmountRegExp;
}

function sameMultiset(expected: readonly string[], actual: readonly string[]): boolean {
  const left = [...expected].sort();
  const right = [...actual].sort();
  return (
    left.length === right.length &&
    left.every((identifier, index) => identifier === right[index])
  );
}

/** Unmasked comparison — for callers that validate plain text without a mask. */
function keepsProtectedValues(source: string, translated: string): boolean {
  return sameMultiset(protectedValues(source), protectedValues(translated));
}

/**
 * Every marker the mask produced appears exactly once in the model's output,
 * and no marker the mask never produced does. Checked on the RAW output: the
 * marker is the fact, so this is the whole "did the fact survive" question —
 * re-matching the restored Arabic prose with context-sensitive regexes is
 * what used to fail on a sentence-final price.
 */
function keepsMarkers(labels: readonly string[], output: string): boolean {
  const known = new Set(labels.map((label) => label.toUpperCase()));
  const markerLikes = output.match(/\{\{[^{}]*CGPV[^{}]*\}\}/giu) ?? [];
  const exactMarkers = output.match(anyMarkerPattern()) ?? [];
  if (markerLikes.length !== exactMarkers.length) return false;
  const actual: string[] = [];
  for (const match of output.matchAll(anyMarkerPattern())) {
    const label = match[1].toUpperCase();
    if (!known.has(label)) return false;
    actual.push(label);
  }
  // Immutable facts are positional as well as byte-exact. Accepting A/B as
  // B/A can swap two prices or date components while still passing a multiset
  // check and publish a materially false sentence.
  return actual.length === labels.length &&
    labels.every((label, index) => actual[index] === label.toUpperCase());
}

/**
 * The facts the writer added on its own. Both sides are marker-stripped, so
 * the source side is whatever the mask patterns did not cover; anything
 * beyond that in the output — a digit run in any script, an amount, a URL,
 * an e-mail — was invented. (A bare currency word beside a marker is not a
 * fact by itself and passes; the amount it qualifies is the marker.)
 */
function keepsMaskedFacts(maskedSource: string, output: string): boolean {
  const facts = (value: string) => {
    const text = stripMarkers(value);
    return [...protectedValues(text), ...(text.match(/\p{Nd}+/gu) ?? [])];
  };
  return sameMultiset(facts(maskedSource), facts(output));
}

function hasEnglishText(value: string): boolean {
  const text = value.replace(/<[^>]+>/gu, ' ');
  const words = text.match(/[a-z]+(?:['’-][a-z]+)?/giu) ?? [];
  // A one-word promotional label ("Sale", "Offers", "Apply") still needs
  // translation. Only actual entity `name` leaves receive the identity
  // exemption; requiring two words allowed short menu/notification headings
  // to be persisted unchanged and then treated as durable memory forever.
  return words.join('').length >= 2;
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
 *
 * With `masks` (the pipeline's case) `translated` is the model's RAW output,
 * markers included: facts are judged by marker integrity plus "nothing new"
 * on the marker-stripped text, and the restored text serves the structure,
 * budget and script checks. Without a mask for a path the plain-text
 * comparison applies.
 */
export function validateTranslatedBatch(
  leaves: readonly TranslatableLeaf[],
  translated: Record<string, unknown>,
  targetScript?: RegExp | null,
  masks?: ReadonlyMap<string, ProtectedValueMask>,
): LeafVerdict[] {
  const verdicts: LeafVerdict[] = [];
  const expectedPaths = new Set(leaves.map((leaf) => leaf.path));
  for (const leaf of leaves) {
    const problems: LeafProblem[] = [];
    const raw = translated[leaf.path];
    if (raw === undefined) {
      problems.push('missing');
    } else if (typeof raw !== 'string') {
      problems.push('not-a-string');
    } else {
      const mask = masks?.get(leaf.path);
      const value = mask ? mask.restore(raw) : raw;
      if (!value.trim()) problems.push('empty');
      const maximumLength = leaf.validationMaxLength ?? leaf.maxLength;
      if (maximumLength && [...value].length > maximumLength) {
        problems.push('over-budget');
      }
      if (leaf.kind === 'richtext' && !sameHtmlStructure(leaf.value, value)) {
        problems.push('html-structure-changed');
      }
      const factsKept = mask
        ? keepsMarkers(mask.labels, raw) && keepsMaskedFacts(mask.masked, raw)
        : keepsProtectedValues(leaf.value, value);
      if (!factsKept) {
        problems.push('protected-value-changed');
      }
      // Only leaves identified by the schema walker as true entity names may
      // remain in Latin script. Promotional headings/descriptions — including
      // homepage title overrides — never receive this exemption.
      const actualEntityName = leaf.identity === true && leaf.path === 'name';
      const enforceTranslatedProse =
        !actualEntityName && hasEnglishText(leaf.value);
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
