// Translate ONE ENTRY's leaves with two independent roles: a first Arabic
// writer and a native copy editor. Both outputs are structurally validated;
// a failed stage receives one corrective pass. Nothing is returned to the
// writer unless every leaf passes, so partial English or clipped text can
// never be persisted as a locale version.
import type { Core } from '@strapi/strapi';
import type { TranslationConfig } from './config';
import { TranslationError } from './errors';
import type { TranslatableLeaf } from './field-map';
import type { ContentLocale } from './locales/registry';
import { editorSystemPrompt, writerSystemPrompt } from './prompts';
import {
  completeWithRetry,
  type CompletionAttemptHooks,
} from './provider';
import type { TranslationProvider } from './provider/types';
import {
  validateTranslatedBatch,
  type LeafVerdict,
} from './validate';

export type EntryTranslation = {
  /** path → final target-locale text, one entry per input leaf. */
  translations: Map<string, string>;
  /** Kept for status compatibility; a successful strict pass is never review-only. */
  needsReview: boolean;
  reviewNotes: string[];
  inputTokens: number;
  outputTokens: number;
  model: string;
};

export type TranslationContentContext = {
  uid?: string;
  contentType?: string;
  sourceLocale?: string;
  targetLocale?: string;
};

export type TranslationAttemptStage =
  | 'writer'
  | 'writer-correction'
  | 'editor'
  | 'editor-correction';

export type TranslationAttemptHookFactory = (
  stage: TranslationAttemptStage,
) => CompletionAttemptHooks | undefined;

function contextSection(
  locale: ContentLocale,
  context?: TranslationContentContext,
): string {
  return [
    '## Content context',
    `* Content type: ${context?.contentType ?? context?.uid ?? 'Strapi content'}`,
    `* Source locale: ${context?.sourceLocale ?? 'en'}`,
    `* Target locale: ${context?.targetLocale ?? locale.code}`,
    '* Field identifiers in the JSON describe each text’s role and are not copy.',
  ].join('\n');
}

function sourcePayload(leaves: readonly TranslatableLeaf[]): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const leaf of leaves) payload[leaf.path] = leaf.value;
  return payload;
}

function budgetsSection(leaves: readonly TranslatableLeaf[]): string {
  const budgets = leaves
    .filter((leaf) => leaf.maxLength)
    .map((leaf) => `* ${leaf.path}: maxChars ${leaf.maxLength}`);
  return budgets.length ? ['## Length budgets', budgets.join('\n')].join('\n') : '';
}

function writerMessage(
  locale: ContentLocale,
  leaves: readonly TranslatableLeaf[],
  context?: TranslationContentContext,
): string {
  return [
    contextSection(locale, context),
    '## English source JSON',
    JSON.stringify(sourcePayload(leaves), null, 1),
    budgetsSection(leaves),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function editorMessage(
  locale: ContentLocale,
  leaves: readonly TranslatableLeaf[],
  draft: Record<string, unknown>,
  context?: TranslationContentContext,
): string {
  return [
    contextSection(locale, context),
    '## English source JSON',
    JSON.stringify(sourcePayload(leaves), null, 1),
    '## Arabic draft JSON',
    JSON.stringify(draft, null, 1),
    budgetsSection(leaves),
    'Return the fully edited final Arabic JSON. Rewrite any draft wording that does not sound native.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function correctiveMessage(
  stage: 'writer' | 'editor',
  locale: ContentLocale,
  leaves: readonly TranslatableLeaf[],
  verdicts: readonly LeafVerdict[],
  context?: TranslationContentContext,
  draft?: Record<string, unknown>,
): string {
  const notes = verdicts.map(
    ({ path, problems }) => `* ${path}: ${problems.join(', ')}`,
  );
  return [
    'Your previous answer had problems with these fields:',
    notes.join('\n'),
    'Return the COMPLETE object again with exactly the requested keys.',
    '- Rephrase naturally to fit maxChars; never truncate.',
    '- Reproduce source HTML tags, order, and attributes exactly.',
    '- Preserve numbers, prices, percentages, URLs, emails, and placeholders verbatim.',
    '- Replace unchanged English prose with fluent Arabic.',
    '',
    stage === 'editor'
      ? editorMessage(locale, leaves, draft ?? {}, context)
      : writerMessage(locale, leaves, context),
  ].join('\n');
}

/** Tolerant JSON extraction: models occasionally fence the object. */
export function parseBatchJson(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/```\s*$/u, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new TranslationError('TRANSLATION_MALFORMED_OUTPUT', {
      detail: 'no JSON object in provider output',
    });
  }
  try {
    const parsed = JSON.parse(unfenced.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new TranslationError('TRANSLATION_MALFORMED_OUTPUT', {
      cause: error,
      detail: 'provider output was not parseable JSON',
    });
  }
}

function chunkLeaves(
  leaves: readonly TranslatableLeaf[],
  chunkChars: number,
): TranslatableLeaf[][] {
  const chunks: TranslatableLeaf[][] = [];
  let current: TranslatableLeaf[] = [];
  let currentChars = 0;
  for (const leaf of leaves) {
    const size = leaf.value.length;
    if (current.length && currentChars + size > chunkChars) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(leaf);
    currentChars += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export async function translateEntryLeaves(
  strapi: Core.Strapi,
  provider: TranslationProvider,
  config: TranslationConfig,
  locale: ContentLocale,
  leaves: readonly TranslatableLeaf[],
  context?: TranslationContentContext,
  attemptHooks?: TranslationAttemptHookFactory,
): Promise<EntryTranslation> {
  const writerSystem = writerSystemPrompt(strapi, locale);
  const editorSystem = editorSystemPrompt(strapi, locale);
  const translations = new Map<string, string>();
  const reviewNotes: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let model = config.model;

  const addUsage = (completion: {
    inputTokens: number;
    outputTokens: number;
    model: string;
  }) => {
    inputTokens += completion.inputTokens;
    outputTokens += completion.outputTokens;
    model = completion.model;
  };

  const parseOrEmpty = (text: string): Record<string, unknown> => {
    try {
      return parseBatchJson(text);
    } catch {
      return {};
    }
  };

  const requireClean = (
    stage: 'writer' | 'editor',
    chunk: readonly TranslatableLeaf[],
    batch: Record<string, unknown>,
  ): Record<string, unknown> => {
    const verdicts = validateTranslatedBatch(chunk, batch, locale.code);
    if (verdicts.length) {
      const detail = verdicts
        .map(({ path, problems }) => `${path}: ${problems.join(', ')}`)
        .join('; ');
      throw new TranslationError('TRANSLATION_QUALITY_GATE_FAILED', {
        detail: `${stage} output failed validation after correction (${detail})`,
      });
    }
    return batch;
  };

  for (const chunk of chunkLeaves(leaves, config.chunkChars)) {
    const first = await completeWithRetry(provider, config, {
      system: writerSystem,
      user: writerMessage(locale, chunk, context),
    }, attemptHooks?.('writer'));
    addUsage(first);
    let writerBatch = parseOrEmpty(first.text);
    let writerVerdicts = validateTranslatedBatch(chunk, writerBatch, locale.code);
    if (writerVerdicts.length) {
      const correction = await completeWithRetry(provider, config, {
        system: writerSystem,
        user: correctiveMessage(
          'writer',
          locale,
          chunk,
          writerVerdicts,
          context,
        ),
      }, attemptHooks?.('writer-correction'));
      addUsage(correction);
      writerBatch = parseOrEmpty(correction.text);
    }
    requireClean('writer', chunk, writerBatch);

    const edited = await completeWithRetry(provider, config, {
      system: editorSystem,
      user: editorMessage(locale, chunk, writerBatch, context),
    }, attemptHooks?.('editor'));
    addUsage(edited);
    let editorBatch = parseOrEmpty(edited.text);
    let editorVerdicts = validateTranslatedBatch(chunk, editorBatch, locale.code);
    if (editorVerdicts.length) {
      const correction = await completeWithRetry(provider, config, {
        system: editorSystem,
        user: correctiveMessage(
          'editor',
          locale,
          chunk,
          editorVerdicts,
          context,
          writerBatch,
        ),
      }, attemptHooks?.('editor-correction'));
      addUsage(correction);
      editorBatch = parseOrEmpty(correction.text);
    }
    requireClean('editor', chunk, editorBatch);

    for (const leaf of chunk) {
      translations.set(leaf.path, editorBatch[leaf.path] as string);
    }
  }

  return {
    translations,
    needsReview: false,
    reviewNotes,
    inputTokens,
    outputTokens,
    model,
  };
}
