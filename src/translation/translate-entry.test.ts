import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TranslationConfig } from './config';
import type { TranslatableLeaf } from './field-map';
import { resolveContentLocale, type ContentLocale } from './locales/resolve';
import { resetPromptCacheForTest } from './prompts';
import { resetTranslationSlotsForTest } from './provider';
import { translateEntryLeaves } from './translate-entry';

const CONFIG: TranslationConfig = {
  provider: 'openai-compatible',
  apiKey: 'k',
  baseUrl: 'https://api.example/v1',
  model: 'test-model',
  reasoningEffort: 'none',
  concurrency: 2,
  timeoutMs: 5_000,
  maxAttempts: 1,
  maxOutputTokens: 1_000,
  chunkChars: 10_000,
  dailyBudgetUsd: 0,
  inputCostPerMTok: 1,
  outputCostPerMTok: 2,
};

const LOCALE = resolveContentLocale('ar', {
  countryCode: 'AE',
  countryName: 'United Arab Emirates',
}) as ContentLocale;

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

  it('repairs only failed fields so a correction cannot damage valid translations', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'عنوان صالح',
          description: 'Save more with this offer',
        }),
        inputTokens: 10,
        outputTokens: 5,
        model: 'writer',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({ description: 'وفّر أكثر مع هذا العرض' }),
        inputTokens: 4,
        outputTokens: 2,
        model: 'writer-correction',
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          title: 'عنوان محرر',
          description: 'وفّر أكثر مع العرض',
        }),
        inputTokens: 8,
        outputTokens: 4,
        model: 'editor',
      });

    const result = await translateEntryLeaves(
      strapi,
      { name: 'fake', complete },
      CONFIG,
      LOCALE,
      [
        leaf('title', 'A valid title'),
        leaf('description', 'Save more with this offer'),
      ],
    );

    const correction = complete.mock.calls[1][0].user as string;
    expect(correction).toContain('"description"');
    expect(correction).not.toContain('"title"');
    expect(result.translations.get('title')).toBe('عنوان محرر');
    expect(result.translations.get('description')).toBe('وفّر أكثر مع العرض');
  });

  it('never gives protected values to either model role and restores them after editing', async () => {
    const complete = vi.fn(async ({ user }: any) => {
      expect(user).not.toContain('AED 150');
      expect(user).not.toContain('20%');
      expect(user).toContain('{{CG_PROTECTED_0}}');
      expect(user).toContain('{{CG_PROTECTED_1}}');
      return {
        text: JSON.stringify({
          description: 'وفّر {{CG_PROTECTED_0}} على {{CG_PROTECTED_1}} اليوم',
        }),
        inputTokens: 3,
        outputTokens: 2,
        model: 'm',
      };
    });

    const result = await translateEntryLeaves(
      strapi,
      { name: 'fake', complete },
      CONFIG,
      LOCALE,
      [leaf('description', 'Save 20% on AED 150 today')],
    );

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.translations.get('description')).toBe(
      'وفّر 20% على AED 150 اليوم',
    );
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

  it('renders the batch brief and per-leaf notes in the writer message', async () => {
    const complete = vi.fn(async () => ({
      text: JSON.stringify({ 'offers.count.one': 'عرض واحد', 'common.viewAll': 'عرض الكل' }),
      inputTokens: 1,
      outputTokens: 1,
      model: 'm',
    }));
    await translateEntryLeaves(
      strapi,
      { name: 'fake', complete },
      CONFIG,
      LOCALE,
      [
        leaf('offers.count.one', 'One offer available', {
          note: "plural form 'one' for a count like 1",
        }),
        leaf('common.viewAll', 'View all offers'),
      ],
      {
        uid: 'ui-dictionary',
        contentType: 'Storefront UI text',
        brief: 'Short UI labels and buttons; keep {placeholders} intact.',
      },
    );
    const writerUser = complete.mock.calls[0][0].user as string;
    expect(writerUser).toContain('Content type: Storefront UI text');
    expect(writerUser).toContain(
      'Short UI labels and buttons; keep {placeholders} intact.',
    );
    expect(writerUser).toContain('## Field notes');
    expect(writerUser).toContain(
      "* offers.count.one: plural form 'one' for a count like 1",
    );
    expect(writerUser).not.toContain('* common.viewAll:');
    // The editor pass sees the same guidance and is addressed by language name.
    const editorUser = complete.mock.calls[1][0].user as string;
    expect(editorUser).toContain('## Arabic draft JSON');
    expect(editorUser).toContain('## Field notes');
  });

  it('uses the generic prompts and language name for a locale without overrides', async () => {
    const hindi = resolveContentLocale('hi', {
      countryCode: 'IN',
      countryName: 'India',
    }) as ContentLocale;
    const complete = vi.fn(async () => ({
      text: JSON.stringify({ tagline: 'और बचाएँ' }),
      inputTokens: 1,
      outputTokens: 1,
      model: 'm',
    }));
    const result = await translateEntryLeaves(
      strapi,
      { name: 'fake', complete },
      CONFIG,
      hindi,
      [leaf('tagline', 'Save more with this offer')],
    );
    expect(result.translations.get('tagline')).toBe('और बचाएँ');
    expect(complete.mock.calls[0][0].system).toContain('native-level Hindi');
    expect(complete.mock.calls[0][0].system).not.toContain('{{');
    expect(complete.mock.calls[1][0].system).toContain('senior Hindi copy editor');
    expect(complete.mock.calls[1][0].user).toContain('## Hindi draft JSON');
  });

  it('rejects an untranslated batch for a non-Latin target via the script check', async () => {
    const hindi = resolveContentLocale('hi', {
      countryCode: 'IN',
      countryName: 'India',
    }) as ContentLocale;
    const complete = vi.fn(async () => ({
      text: JSON.stringify({ tagline: 'Save even more with this offer' }),
      inputTokens: 1,
      outputTokens: 1,
      model: 'm',
    }));
    await expect(
      translateEntryLeaves(
        strapi,
        { name: 'fake', complete },
        CONFIG,
        hindi,
        [leaf('tagline', 'Save more with this offer')],
      ),
    ).rejects.toThrow(/target-language-missing/);
  });
});
