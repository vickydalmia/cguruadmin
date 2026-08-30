import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TranslationConfig } from './config';
import type { TranslatableLeaf } from './field-map';
import type { ContentLocale } from './locales/registry';
import { resetPromptCacheForTest } from './prompts';
import { resetTranslationSlotsForTest } from './provider';
import { translateEntryLeaves } from './translate-entry';

const CONFIG: TranslationConfig = {
  provider: 'openai-compatible',
  apiKey: 'k',
  baseUrl: 'https://api.example/v1',
  model: 'test-model',
  concurrency: 2,
  timeoutMs: 5_000,
  maxAttempts: 1,
  maxOutputTokens: 1_000,
  chunkChars: 10_000,
  dailyBudgetUsd: 0,
  inputCostPerMTok: 1,
  outputCostPerMTok: 2,
};

const LOCALE: ContentLocale = {
  code: 'ar',
  name: 'Arabic',
  nativeName: 'العربية',
  dir: 'rtl',
  ogLocale: 'ar_AE',
  promptFile: 'ar.md',
  editorPromptFile: 'ar-editor.md',
  glossaryFile: 'ar.md',
};

// The real prompt file is read from the repo via strapi.dirs.app.root.
const strapi = {
  dirs: { app: { root: process.cwd() } },
} as any;

const leaf = (
  path: string,
  value: string,
  extra: Partial<TranslatableLeaf> = {},
): TranslatableLeaf => ({ path, kind: 'plain', value, ...extra });

beforeEach(() => {
  resetPromptCacheForTest();
  resetTranslationSlotsForTest();
});

describe('translateEntryLeaves', () => {
  it('returns the batch translations with token accounting', async () => {
    const complete = vi.fn(async ({ user }: any) => {
      expect(user).toContain('"name"');
      return {
        text: JSON.stringify({ name: 'أمازون', tagline: 'وفر أكثر' }),
        inputTokens: 100,
        outputTokens: 40,
        model: 'test-model-1',
      };
    });
    const result = await translateEntryLeaves(
      strapi,
      { name: 'fake', complete },
      CONFIG,
      LOCALE,
      [leaf('name', 'Amazon'), leaf('tagline', 'Save more')],
    );
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.translations.get('name')).toBe('أمازون');
    expect(result.translations.get('tagline')).toBe('وفر أكثر');
    expect(result.needsReview).toBe(false);
    expect(complete.mock.calls[0][0].system).toContain('native-level Arabic');
    expect(complete.mock.calls[1][0].system).toContain('senior Arabic copy editor');
    expect(complete.mock.calls[1][0].user).toContain('Arabic draft JSON');
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(80);
    expect(result.model).toBe('test-model-1');
  });

  it('corrects an invalid writer batch before sending it to the editor', async () => {
    const complete = vi
      .fn()
      // First pass: one key over budget, one missing entirely.
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'عنوان طويل جدا جدا جدا جدا جدا جدا',
        }),
        inputTokens: 10,
        outputTokens: 10,
        model: 'm',
      })
      // Corrective writer pass returns the complete, valid object.
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'عنوان موجز',
          summary: 'ملخص',
        }),
        inputTokens: 5,
        outputTokens: 5,
        model: 'm',
      })
      // Independent editor pass.
      .mockResolvedValueOnce({
        text: JSON.stringify({ title: 'عنوان موجز', summary: 'ملخص واضح' }),
        inputTokens: 7,
        outputTokens: 4,
        model: 'editor-m',
      });
    const result = await translateEntryLeaves(
      strapi,
      { name: 'fake', complete },
      CONFIG,
      LOCALE,
      [leaf('title', 'A very long title', { maxLength: 12 }), leaf('summary', 'Summary')],
    );
    expect(complete).toHaveBeenCalledTimes(3);
    const secondUser = complete.mock.calls[1][0].user as string;
    expect(secondUser).toContain('over-budget');
    expect(secondUser).toContain('title');
    expect(secondUser).toContain('summary');
    expect(result.translations.get('summary')).toBe('ملخص واضح');
    expect(result.translations.get('title')).toBe('عنوان موجز');
    expect(result.needsReview).toBe(false);
    expect(result.inputTokens).toBe(22);
    expect(result.model).toBe('editor-m');
  });

  it('does not return a writeable result when correction remains broken', async () => {
    const complete = vi.fn(async () => ({
      text: JSON.stringify({ body: '<div>changed</div>' }),
      inputTokens: 1,
      outputTokens: 1,
      model: 'm',
    }));
    await expect(
      translateEntryLeaves(
        strapi,
        { name: 'fake', complete },
        CONFIG,
        LOCALE,
        [leaf('body', '<p>Hello <strong>there</strong></p>', { kind: 'richtext' })],
      ),
    ).rejects.toThrow(/TRANSLATION_QUALITY_GATE_FAILED/);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('uses the editor output rather than publishing the first draft', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({ summary: 'احصل على الادخار أكثر مع هذا العرض' }),
        inputTokens: 10,
        outputTokens: 5,
        model: 'writer',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ summary: 'وفّر أكثر مع هذا العرض' }),
        inputTokens: 12,
        outputTokens: 5,
        model: 'editor',
      });
    const result = await translateEntryLeaves(
      strapi,
      { name: 'fake', complete },
      CONFIG,
      LOCALE,
      [leaf('summary', 'Save more with this offer')],
      { uid: 'api::store.store', contentType: 'Store' },
    );
    expect(result.translations.get('summary')).toBe('وفّر أكثر مع هذا العرض');
    expect(complete.mock.calls[0][0].user).toContain('Content type: Store');
  });
});
