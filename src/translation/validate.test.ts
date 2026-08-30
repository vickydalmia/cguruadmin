import { describe, expect, it } from 'vitest';
import type { TranslatableLeaf } from './field-map';
import { validateTranslatedBatch } from './validate';
import { parseBatchJson } from './translate-entry';

const leaf = (
  path: string,
  value: string,
  extra: Partial<TranslatableLeaf> = {},
): TranslatableLeaf => ({ path, kind: 'plain', value, ...extra });

describe('validateTranslatedBatch', () => {
  it('passes a faithful batch', () => {
    const leaves = [
      leaf('name', 'Amazon'),
      leaf('body', '<p>Use <a href="https://x.y/z">this link</a></p>', {
        kind: 'richtext',
      }),
    ];
    const verdicts = validateTranslatedBatch(leaves, {
      name: 'أمازون',
      body: '<p>استخدم <a href="https://x.y/z">هذا الرابط</a></p>',
    });
    expect(verdicts).toEqual([]);
  });

  it('flags missing keys, wrong types, blank output and char budgets', () => {
    const leaves = [
      leaf('a', 'Alpha'),
      leaf('b', 'Beta'),
      leaf('c', 'Gamma', { maxLength: 4 }),
    ];
    const verdicts = validateTranslatedBatch(leaves, {
      b: 42,
      c: 'خمسة أحرف طويلة جدا',
    });
    expect(verdicts).toEqual([
      { path: 'a', problems: ['missing'] },
      { path: 'b', problems: ['not-a-string'] },
      { path: 'c', problems: ['over-budget'] },
    ]);
  });

  it('rejects altered HTML structure and changed protected values', () => {
    const leaves = [
      leaf('html', '<p>Hi <strong>there</strong></p>', { kind: 'richtext' }),
      leaf('contact', 'Write to help@x.com today'),
    ];
    const verdicts = validateTranslatedBatch(leaves, {
      html: '<p>مرحبا there</p>',
      contact: 'راسلنا اليوم',
    });
    expect(verdicts).toEqual([
      { path: 'html', problems: ['html-structure-changed'] },
      {
        path: 'contact',
        problems: ['protected-value-changed'],
      },
    ]);
  });

  it('requires exact HTML tag order and attributes', () => {
    const leaves = [
      leaf('body', '<p><a class="cta" href="/go">Shop <strong>now</strong></a></p>', {
        kind: 'richtext',
      }),
    ];
    expect(
      validateTranslatedBatch(leaves, {
        body: '<p><a href="/go" class="cta">تسوّق <strong>الآن</strong></a></p>',
      }),
    ).toEqual([{ path: 'body', problems: ['html-structure-changed'] }]);
  });

  it('preserves numbers, currencies, percentages, placeholders, and exact keys', () => {
    const leaves = [leaf('copy', 'Save 20% on AED 150 for {customerName}')];
    expect(
      validateTranslatedBatch(
        leaves,
        { copy: 'وفّر 25% على AED 150', invented: 'قيمة' },
        'ar',
      ),
    ).toEqual([
      { path: 'copy', problems: ['protected-value-changed'] },
      { path: 'invented', problems: ['unexpected-key'] },
    ]);
  });

  it('rejects invented protected facts and collapsed duplicate values', () => {
    const invented = validateTranslatedBatch(
      [leaf('body', 'Save 20% today')],
      { body: 'وفّر 20% واحصل على 50% اليوم' },
      'ar',
    );
    const duplicateLost = validateTranslatedBatch(
      [leaf('body', 'Use AED 100, then another AED 100')],
      { body: 'استخدم AED 100 مرة واحدة' },
      'ar',
    );

    expect(invented[0]?.problems).toContain('protected-value-changed');
    expect(duplicateLost[0]?.problems).toContain('protected-value-changed');
  });

  it('rejects unchanged English prose for an Arabic target', () => {
    expect(
      validateTranslatedBatch(
        [leaf('summary', 'Save more with this offer')],
        { summary: 'Save more with this offer' },
        'ar',
      ),
    ).toEqual([
      {
        path: 'summary',
        problems: ['untranslated-source', 'target-language-missing'],
      },
    ]);
  });
});

describe('parseBatchJson', () => {
  it('parses plain and fenced JSON objects', () => {
    expect(parseBatchJson('{"a": "b"}')).toEqual({ a: 'b' });
    expect(parseBatchJson('```json\n{"a": "b"}\n```')).toEqual({ a: 'b' });
    expect(
      parseBatchJson('Here you go:\n{"a": "قيمة"}\nDone.'),
    ).toEqual({ a: 'قيمة' });
  });

  it('throws the typed error on garbage', () => {
    expect(() => parseBatchJson('no json here')).toThrowError(
      /TRANSLATION_MALFORMED_OUTPUT/,
    );
    expect(() => parseBatchJson('[1,2]')).toThrowError(
      /TRANSLATION_MALFORMED_OUTPUT/,
    );
  });
});
