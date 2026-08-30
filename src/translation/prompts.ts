// Prompt TEMPLATE LOADER. Templates are markdown files under
// src/translation/locales/prompts/, read from the app root at runtime — the
// same pattern the nightly cron uses for database/*.js: TypeScript builds
// only compile src/**/*.ts into dist/, so non-code assets are addressed
// through strapi.dirs.app.root, which points at the repo root in both dev
// and production layouts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from '@strapi/strapi';
import { TranslationError } from './errors';
import type { ContentLocale } from './locales/registry';

const cache = new Map<string, string>();

function loadLocaleAsset(
  strapi: Core.Strapi,
  locale: ContentLocale,
  directory: 'prompts' | 'glossaries',
  file: string,
): string {
  const cacheKey = `${directory}:${file}`;
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
  cache.set(cacheKey, template);
  return template;
}

export function loadPromptTemplate(
  strapi: Core.Strapi,
  locale: ContentLocale,
): string {
  return loadLocaleAsset(strapi, locale, 'prompts', locale.promptFile);
}

export function loadEditorPromptTemplate(
  strapi: Core.Strapi,
  locale: ContentLocale,
): string {
  return loadLocaleAsset(
    strapi,
    locale,
    'prompts',
    locale.editorPromptFile,
  );
}

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
export function batchOutputContract(): string {
  return [
    '## Input and output format (machine contract)',
    '',
    'The user message contains an "English source JSON" object. Each key is',
    'an opaque field identifier; each value is one English source text',
    '(plain text or an HTML fragment). An editor request also contains an',
    '"Arabic draft JSON" object. Some entries carry a "maxChars" limit',
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
    batchOutputContract(),
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
    batchOutputContract(),
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
