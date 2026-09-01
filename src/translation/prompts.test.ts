import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveContentLocale, type ContentLocale } from './locales/resolve';
import {
  batchOutputContract,
  editorSystemPrompt,
  loadGlossary,
  resetPromptCacheForTest,
  translationPromptFingerprint,
  writerSystemPrompt,
} from './prompts';

// The real prompt files are read from the repo via strapi.dirs.app.root.
const strapi = { dirs: { app: { root: process.cwd() } } } as any;

const AR = resolveContentLocale('ar', {
  countryCode: 'AE',
  countryName: 'United Arab Emirates',
}) as ContentLocale;

const HI = resolveContentLocale('hi', {
  countryCode: 'IN',
  countryName: 'India',
}) as ContentLocale;

const FIXTURES = join(__dirname, '__fixtures__');

/**
 * GOLDEN: the rendered `ar` system prompts are part of every stored content
 * hash (translationPromptFingerprint). Any byte of drift marks the whole
 * Arabic catalogue stale and re-translates it at real cost. Regenerate the
 * fixtures ONLY for a deliberate prompt change, with
 * `UPDATE_PROMPT_GOLDEN=1 yarn test src/translation/prompts.test.ts`.
 */
function golden(name: string, actual: string): void {
  const path = join(FIXTURES, name);
  if (process.env.UPDATE_PROMPT_GOLDEN === '1' || !existsSync(path)) {
    writeFileSync(path, actual, 'utf8');
  }
  expect(actual).toBe(readFileSync(path, 'utf8'));
}

beforeEach(() => resetPromptCacheForTest());

describe('ar system prompts (golden)', () => {
  it('renders the writer system prompt byte-identically', () => {
    golden('ar-writer-system.txt', writerSystemPrompt(strapi, AR));
  });

  it('renders the editor system prompt byte-identically', () => {
    golden('ar-editor-system.txt', editorSystemPrompt(strapi, AR));
  });

  it('fingerprints exactly the two rendered system prompts', () => {
    expect(translationPromptFingerprint(strapi, AR)).toBe(
      [
        'translation-pipeline-v2-writer-editor',
        readFileSync(join(FIXTURES, 'ar-writer-system.txt'), 'utf8'),
        readFileSync(join(FIXTURES, 'ar-editor-system.txt'), 'utf8'),
      ].join('\n---\n'),
    );
  });

  it('is unaffected by another locale sharing the prompt cache', () => {
    writerSystemPrompt(strapi, HI);
    editorSystemPrompt(strapi, HI);
    expect(writerSystemPrompt(strapi, AR)).toBe(
      readFileSync(join(FIXTURES, 'ar-writer-system.txt'), 'utf8'),
    );
  });
});

describe('generic prompts for a locale without overrides', () => {
  it('renders the default templates with every placeholder substituted', () => {
    const writer = writerSystemPrompt(strapi, HI);
    const editor = editorSystemPrompt(strapi, HI);
    for (const prompt of [writer, editor]) {
      expect(prompt).not.toMatch(/\{\{/u);
      expect(prompt).toContain('Hindi');
      expect(prompt).toContain('India');
      expect(prompt).toContain('"Hindi draft JSON"');
    }
    expect(writer).toContain('native-level Hindi commerce writer');
    expect(writer).toContain('* Language: Hindi (हिन्दी)');
    expect(writer).toContain('* Script (CLDR code): Deva');
    expect(writer).toContain('* Text direction: ltr');
    expect(writer).toContain('* Market: India (IN)');
    expect(writer).not.toContain('Arabic');
    expect(writer).not.toContain('## Approved terminology');
    expect(editor).toContain('senior Hindi copy editor');
    expect(loadGlossary(strapi, HI)).toBe('');
  });

  it('addresses the machine contract by language name', () => {
    expect(batchOutputContract(AR)).toContain('"Arabic draft JSON"');
    expect(batchOutputContract(HI)).toContain('"Hindi draft JSON"');
  });

  it('throws TRANSLATION_NOT_CONFIGURED when a placeholder cannot be filled', () => {
    const noCountry = { ...HI, countryName: '' };
    expect(() => writerSystemPrompt(strapi, noCountry)).toThrow(
      /TRANSLATION_NOT_CONFIGURED: prompt template default\.md has unresolved placeholder\(s\) for locale "hi": \{\{countryName\}\}/,
    );
  });

  it('throws TRANSLATION_NOT_CONFIGURED on an unknown placeholder in a template', () => {
    const root = join(tmpdir(), `cguru-prompts-${process.pid}-${Date.now()}`);
    const prompts = join(root, 'src', 'translation', 'locales', 'prompts');
    mkdirSync(prompts, { recursive: true });
    writeFileSync(
      join(prompts, 'default.md'),
      'Write {{languageName}} for {{marketSegment}}.',
      'utf8',
    );
    const scratchStrapi = { dirs: { app: { root } } } as any;
    expect(() => writerSystemPrompt(scratchStrapi, HI)).toThrow(
      /unresolved placeholder\(s\) for locale "hi": \{\{marketSegment\}\}/,
    );
  });

  it('caches per locale code, not per file', () => {
    const hindi = writerSystemPrompt(strapi, HI);
    const bengali = writerSystemPrompt(
      strapi,
      resolveContentLocale('bn', { countryCode: 'IN', countryName: 'India' }) as ContentLocale,
    );
    expect(hindi).toContain('native-level Hindi');
    expect(bengali).toContain('native-level Bangla');
    expect(bengali).not.toContain('Hindi');
  });
});
