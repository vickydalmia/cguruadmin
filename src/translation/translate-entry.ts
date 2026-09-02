// Translate ONE ENTRY's leaves with two independent roles: a first
// target-language writer and a native copy editor. Both outputs are structurally validated;
// a failed stage receives one corrective pass. Nothing is returned to the
// writer unless every leaf passes, so partial English or clipped text can
// never be persisted as a locale version.
import type { Core } from '@strapi/strapi';
import type { TranslationConfig } from './config';
import { TranslationError } from './errors';
import type { TranslatableLeaf } from './field-map';
import { unicodeScriptPattern, type ContentLocale } from './locales/resolve';
import { editorSystemPrompt, writerSystemPrompt } from './prompts';
import {
  completeWithRetry,
  type CompletionAttemptHooks,
} from './provider';
import type { TranslationProvider } from './provider/types';
import {
  maskProtectedValues,
  validateTranslatedBatch,
  type LeafVerdict,
  type ProtectedValueMask,
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
  /** Free-form guidance about THIS batch (e.g. "short UI labels"), shown under the context. */
  brief?: string;
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
    ...(context?.brief?.trim() ? ['', context.brief.trim()] : []),
  ].join('\n');
}

function sourcePayload(leaves: readonly TranslatableLeaf[]): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const leaf of leaves) payload[leaf.path] = leaf.value;
  return payload;
}

function fieldNotesSection(leaves: readonly TranslatableLeaf[]): string {
  const notes = leaves
    .filter((leaf) => leaf.note?.trim())
    .map((leaf) => `* ${leaf.path}: ${leaf.note?.trim()}`);
  return notes.length ? ['## Field notes', notes.join('\n')].join('\n') : '';
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
    fieldNotesSection(leaves),
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
    `## ${locale.name} draft JSON`,
    JSON.stringify(draft, null, 1),
    fieldNotesSection(leaves),
    budgetsSection(leaves),
    `Return the fully edited final ${locale.name} JSON. Rewrite any draft wording that does not sound native.`,
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
    `- Replace unchanged English prose with fluent ${locale.name}.`,
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

function pickBatchKeys(
  batch: Record<string, unknown>,
  leaves: readonly TranslatableLeaf[],
): Record<string, unknown> {
  return Object.fromEntries(
    leaves
      .filter((leaf) => Object.prototype.hasOwnProperty.call(batch, leaf.path))
      .map((leaf) => [leaf.path, batch[leaf.path]]),
  );
}

function restoredBatch(
  batch: Record<string, unknown>,
  masks: ReadonlyMap<string, ProtectedValueMask>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(batch).map(([path, value]) => [
      path,
      typeof value === 'string' ? masks.get(path)?.restore(value) ?? value : value,
    ]),
  );
}

function expectedVerdicts(verdicts: readonly LeafVerdict[]): LeafVerdict[] {
  return verdicts.filter(
    (verdict) => !verdict.problems.includes('unexpected-key'),
  );
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
  const targetScript = unicodeScriptPattern(locale.script);
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
    const verdicts = validateTranslatedBatch(chunk, batch, targetScript);
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
    const masks = new Map(
      chunk.map((leaf) => [leaf.path, maskProtectedValues(leaf.value)] as const),
    );
    const modelChunk = chunk.map((leaf) => ({
      ...leaf,
      value: masks.get(leaf.path)!.masked,
    }));
    const validateModelBatch = (batch: Record<string, unknown>) =>
      validateTranslatedBatch(chunk, restoredBatch(batch, masks), targetScript);

    const first = await completeWithRetry(provider, config, {
      system: writerSystem,
      user: writerMessage(locale, modelChunk, context),
    }, attemptHooks?.('writer'));
    addUsage(first);
    let writerBatch = pickBatchKeys(parseOrEmpty(first.text), modelChunk);
    let writerVerdicts = validateModelBatch(writerBatch);
    if (writerVerdicts.length) {
      const repairVerdicts = expectedVerdicts(writerVerdicts);
      const repairPaths = new Set(repairVerdicts.map((verdict) => verdict.path));
      const repairLeaves = modelChunk.filter((leaf) => repairPaths.has(leaf.path));
      if (repairLeaves.length > 0) {
        const correction = await completeWithRetry(provider, config, {
          system: writerSystem,
          user: correctiveMessage(
            'writer',
            locale,
            repairLeaves,
            repairVerdicts,
            context,
          ),
        }, attemptHooks?.('writer-correction'));
        addUsage(correction);
        Object.assign(
          writerBatch,
          pickBatchKeys(parseOrEmpty(correction.text), repairLeaves),
        );
      }
    }
    requireClean(
      'writer',
      chunk,
      restoredBatch(writerBatch, masks),
    );

    const edited = await completeWithRetry(provider, config, {
      system: editorSystem,
      user: editorMessage(locale, modelChunk, writerBatch, context),
    }, attemptHooks?.('editor'));
    addUsage(edited);
    let editorBatch = pickBatchKeys(parseOrEmpty(edited.text), modelChunk);
    let editorVerdicts = validateModelBatch(editorBatch);
    if (editorVerdicts.length) {
      const repairVerdicts = expectedVerdicts(editorVerdicts);
      const repairPaths = new Set(repairVerdicts.map((verdict) => verdict.path));
      const repairLeaves = modelChunk.filter((leaf) => repairPaths.has(leaf.path));
      if (repairLeaves.length > 0) {
        const correction = await completeWithRetry(provider, config, {
          system: editorSystem,
          user: correctiveMessage(
            'editor',
            locale,
            repairLeaves,
            repairVerdicts,
            context,
            pickBatchKeys(writerBatch, repairLeaves),
          ),
        }, attemptHooks?.('editor-correction'));
        addUsage(correction);
        Object.assign(
          editorBatch,
          pickBatchKeys(parseOrEmpty(correction.text), repairLeaves),
        );
      }
    }
    const cleanEditorBatch = requireClean(
      'editor',
      chunk,
      restoredBatch(editorBatch, masks),
    );

    for (const leaf of chunk) {
      translations.set(leaf.path, cleanEditorBatch[leaf.path] as string);
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
