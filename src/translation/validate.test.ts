import { describe, expect, it } from 'vitest';
import type { TranslatableLeaf } from './field-map';
import {
  maskProtectedValues,
  protectedValues,
  validateTranslatedBatch,
} from './validate';
import { parseBatchJson } from './translate-entry';

const ARABIC = /\p{Script=Arabic}/u;

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
        ARABIC,
      ),
    ).toEqual([
      { path: 'copy', problems: ['protected-value-changed'] },
      { path: 'invented', problems: ['unexpected-key'] },
    ]);
  });

  it('protects any currency code or symbol, before or after the amount', () => {
    const cases: [string, string][] = [
      ['Get INR 500 off', 'خصم INR 50'],
      ['Save ¥1,200 today', 'وفّر ¥1,20 اليوم'],
      ['Spend 150 SAR', 'أنفق 15 SAR'],
      ['Only ₹99', 'فقط ₹9'],
      ['From 200 د.إ', 'من 20 د.إ'],
    ];
    for (const [source, translated] of cases) {
      expect(
        validateTranslatedBatch([leaf('copy', source)], { copy: translated }, ARABIC),
      ).toEqual([{ path: 'copy', problems: ['protected-value-changed'] }]);
    }
    expect(
      validateTranslatedBatch([leaf('copy', 'Get INR 500 off')], { copy: 'خصم INR 500' }, ARABIC),
    ).toEqual([]);
    // Ordinary upper-case words are not currencies.
    expect(protectedValues('GET 50 today')).toEqual(['50']);
  });

  it('rejects invented protected facts and collapsed duplicate values', () => {
    const invented = validateTranslatedBatch(
      [leaf('body', 'Save 20% today')],
      { body: 'وفّر 20% واحصل على 50% اليوم' },
      ARABIC,
    );
    const duplicateLost = validateTranslatedBatch(
      [leaf('body', 'Use AED 100, then another AED 100')],
      { body: 'استخدم AED 100 مرة واحدة' },
      ARABIC,
    );

    expect(invented[0]?.problems).toContain('protected-value-changed');
    expect(duplicateLost[0]?.problems).toContain('protected-value-changed');
  });

  it('masks protected facts before the model and restores their exact source bytes', () => {
    const mask = maskProtectedValues(
      'Save 20% on AED 150 at https://shop.example/x for {customerName}',
    );

    expect(mask.masked).not.toContain('20%');
    expect(mask.masked).not.toContain('AED 150');
    expect(mask.masked).not.toContain('https://shop.example/x');
    expect(mask.masked).not.toContain('{customerName}');
    expect(
      mask.restore(
        'وفّر {{CG_PROTECTED_0}} على {{CG_PROTECTED_1}} لدى ' +
          '{{CG_PROTECTED_2}} للعميل {{CG_PROTECTED_3}}',
      ),
    ).toBe(
      'وفّر 20% على AED 150 لدى https://shop.example/x للعميل {customerName}',
    );
  });

  it('rejects unchanged English prose for an Arabic target', () => {
    expect(
      validateTranslatedBatch(
        [leaf('summary', 'Save more with this offer')],
        { summary: 'Save more with this offer' },
        ARABIC,
      ),
    ).toEqual([
      {
        path: 'summary',
        problems: ['untranslated-source', 'target-language-missing'],
      },
    ]);
  });

  it('flags English output that lacks the target script', () => {
    expect(
      validateTranslatedBatch(
        [leaf('summary', 'Save more with this offer')],
        { summary: 'Save even more with this offer' },
        ARABIC,
      ),
    ).toEqual([{ path: 'summary', problems: ['target-language-missing'] }]);
    expect(
      validateTranslatedBatch(
        [leaf('summary', 'Save more with this offer')],
        { summary: 'इस ऑफ़र के साथ और बचाएँ' },
        /\p{Script=Devanagari}/u,
      ),
    ).toEqual([]);
  });

  it('allows a root taxonomy name to retain its registered Latin brand identity', () => {
    expect(
      validateTranslatedBatch(
        [leaf('name', 'Golden Scent')],
        { name: 'Golden Scent' },
        ARABIC,
      ),
    ).toEqual([]);
  });

  it('skips the script check for Latin-script targets (null pattern)', () => {
    expect(
      validateTranslatedBatch(
        [leaf('summary', 'Save more with this offer')],
        { summary: 'Hemat lebih banyak dengan penawaran ini' },
        null,
      ),
    ).toEqual([]);
    // Unchanged prose is still caught by the source-equality check.
    expect(
      validateTranslatedBatch(
        [leaf('summary', 'Save more with this offer')],
        { summary: 'Save more with this offer' },
        null,
      ),
    ).toEqual([{ path: 'summary', problems: ['untranslated-source'] }]);
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
