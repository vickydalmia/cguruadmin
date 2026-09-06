// Prompt TEMPLATE LOADER. Templates are markdown files under
// src/translation/locales/prompts/, read from the app root at runtime — the
// same pattern the nightly cron uses for database/*.js: TypeScript builds
// only compile src/**/*.ts into dist/, so non-code assets are addressed
// through strapi.dirs.app.root, which points at the repo root in both dev
// and production layouts.
//
// A language with hand-tuned files (locales/table.ts) renders those; every
// other language renders the generic default templates with the locale's
// facts substituted for `{{placeholders}}`. Rendered system prompts are
// hashed into every stored translation (translationPromptFingerprint), so
// the `ar` output is pinned byte-for-byte by prompts.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from '@strapi/strapi';
import { TranslationError } from './errors';
import type { ContentLocale } from './locales/resolve';

const DEFAULT_PROMPT_FILE = 'default.md';
const DEFAULT_EDITOR_PROMPT_FILE = 'default-editor.md';

const PLACEHOLDER = /\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/gu;

const cache = new Map<string, string>();

function templateValues(locale: ContentLocale): Record<string, string> {
  return {
    languageName: locale.name,
    nativeName: locale.nativeName,
    countryName: locale.countryName,
    countryCode: locale.countryCode,
    script: locale.script ?? 'native',
    dir: locale.dir,
  };
}

/**
 * Substitute `{{name}}` tokens. An unknown or empty token is a configuration
 * error (a typo in a template, or a site without a country name) — throw the
 * same non-retryable error a missing template raises rather than sending an
 * LLM a prompt with a hole in it.
 */
function renderTemplate(
  template: string,
  locale: ContentLocale,
  file: string,
): string {
  const values = templateValues(locale);
  const unresolved: string[] = [];
  const rendered = template.replace(PLACEHOLDER, (token, name: string) => {
    const value = values[name];
    if (typeof value === 'string' && value.trim()) return value;
    unresolved.push(token);
    return token;
  });
  if (unresolved.length > 0) {
    throw new TranslationError('TRANSLATION_NOT_CONFIGURED', {
      detail:
        `prompt template ${file} has unresolved placeholder(s) for locale ` +
        `"${locale.code}": ${[...new Set(unresolved)].join(', ')}`,
    });
  }
  return rendered;
}

function loadLocaleAsset(
  strapi: Core.Strapi,
  locale: ContentLocale,
  directory: 'prompts' | 'glossaries',
  file: string,
): string {
  const cacheKey = `${locale.code}:${directory}:${file}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const path = join(
    strapi.dirs.app.root,
    'src',
    'translation',
    'locales',
    directory,
    file,
  );
  let template: string;
  try {
    template = readFileSync(path, 'utf8');
  } catch (error) {
    throw new TranslationError('TRANSLATION_NOT_CONFIGURED', {
      cause: error,
      detail: `${directory} asset missing for locale "${locale.code}" at ${path}`,
    });
  }
  if (!template.trim()) {
    throw new TranslationError('TRANSLATION_NOT_CONFIGURED', {
      detail: `${directory} asset for locale "${locale.code}" is empty`,
    });
  }
  const rendered = renderTemplate(template, locale, file);
  cache.set(cacheKey, rendered);
  return rendered;
}

export function loadPromptTemplate(
  strapi: Core.Strapi,
  locale: ContentLocale,
): string {
  return loadLocaleAsset(
    strapi,
    locale,
    'prompts',
    locale.promptFile ?? DEFAULT_PROMPT_FILE,
  );
}

export function loadEditorPromptTemplate(
  strapi: Core.Strapi,
  locale: ContentLocale,
): string {
  return loadLocaleAsset(
    strapi,
    locale,
    'prompts',
    locale.editorPromptFile ?? DEFAULT_EDITOR_PROMPT_FILE,
  );
}

/** Only a language with a declared glossary file gets a terminology section. */
export function loadGlossary(
  strapi: Core.Strapi,
  locale: ContentLocale,
): string {
  if (!locale.glossaryFile) return '';
  return loadLocaleAsset(
    strapi,
    locale,
    'glossaries',
    locale.glossaryFile,
  );
}

/** Test hook. */
export function resetPromptCacheForTest(): void {
  cache.clear();
}

/**
 * The machine contract appended after the human localization brief. The
 * brief describes HOW to write; this describes the exact I/O envelope the
 * pipeline parses.
 */
export function batchOutputContract(locale: ContentLocale): string {
  return [
    '## Input and output format (machine contract)',
    '',
    'The user message contains an "English source JSON" object. Each key is',
    'an opaque field identifier; each value is one English source text',
    '(plain text or an HTML fragment). An editor request also contains an',
    `"${locale.name} draft JSON" object. Some entries carry a "maxChars" limit`,
    'listed under "## Length budgets" in the user message.',
    '',
    'Return ONLY a JSON object — no code fences, no commentary — with',
    'EXACTLY the same keys, where every value is the final translation of',
    'the corresponding source value:',
    '',
    '* Never translate, drop, merge, or invent keys.',
    '* Preserve the HTML structure of HTML values: identical tags and',
    '  attributes, translated human-readable text only.',
    '* Keep every URL, email address, coupon code, and numeric value',
    '  exactly as written in the source.',
    '* A value with a maxChars budget MUST fit the budget while staying',
    '  natural — shorten by rephrasing, never by truncating mid-sentence.',
  ].join('\n');
}

function glossarySection(glossary: string): string {
  return glossary.trim() ? `## Approved terminology\n\n${glossary.trim()}` : '';
}

export function writerSystemPrompt(
  strapi: Core.Strapi,
  locale: ContentLocale,
): string {
  return [
    loadPromptTemplate(strapi, locale),
    glossarySection(loadGlossary(strapi, locale)),
    batchOutputContract(locale),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function editorSystemPrompt(
  strapi: Core.Strapi,
  locale: ContentLocale,
): string {
  return [
    loadEditorPromptTemplate(strapi, locale),
    glossarySection(loadGlossary(strapi, locale)),
    batchOutputContract(locale),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Every instruction that can affect output, for prompt-aware source hashes. */
export function translationPromptFingerprint(
  strapi: Core.Strapi,
  locale: ContentLocale,
): string {
  return [
    'translation-pipeline-v2-writer-editor',
    writerSystemPrompt(strapi, locale),
    editorSystemPrompt(strapi, locale),
  ].join('\n---\n');
}
