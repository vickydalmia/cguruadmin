import { describe, expect, it } from 'vitest';
import type { TranslatableLeaf } from './field-map';
import {
  maskProtectedValues,
  protectedValues,
  stripMarkers,
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

  it('accepts the Arabic renderings that dead-lettered the UAE backfill', () => {
    // Every row below is a real failure from cguruaedb.csv: the English
    // source keeps its amount mid-sentence, the faithful Arabic ends the
    // clause with it, and the old greedy amount / word-boundary regexes saw
    // "AED 749." or a freshly separated "90" as a changed fact.
    const cases: [string, string][] = [
      ['Enjoy artworks from AED 749 onwards.', 'استمتع بأعمال فنية تبدأ من AED 749.'],
      ['A minimum order of USD 150 is needed.', 'الحد الأدنى للطلب هو USD 150.'],
      ['Save $40 on orders, limited time.', 'وفّر $40 على الطلبات, لفترة محدودة.'],
      ['Versace Crystal Noir EDT Spray For Her 90ml', 'عطر فيرساتشي كريستال نوار للنساء 90 مل'],
      ['Bathing - Upto 40% + Additional10% Off', 'الاستحمام - حتى 40% + خصم إضافي 10%'],
      ['Stay Starting At Just AED400.', 'إقامة تبدأ من AED400 فقط.'],
      ['Visit https://noon.com for details.', 'زوروا https://noon.com.'],
      ['Write to help@x.com today', 'راسل help@x.com.'],
    ];
    for (const [source, translated] of cases) {
      expect(
        validateTranslatedBatch([leaf('copy', source)], { copy: translated }, ARABIC),
      ).toEqual([]);
    }
  });

  it('protects digits glued to letters and a code glued to its amount as single facts', () => {
    expect(protectedValues('Spray For Her 90ml')).toEqual(['90']);
    expect(protectedValues('Upto 40% + Additional10% Off')).toEqual([
      '40%',
      '10%',
    ]);
    expect(protectedValues('Just AED400.')).toEqual(['AED400']);
    expect(protectedValues('Visit https://noon.com.')).toEqual(['https://noon.com']);
    expect(maskProtectedValues('Spray For Her 90ml').masked).toBe(
      'Spray For Her {{CGPV_A}}ml',
    );
    expect(maskProtectedValues('Just AED400.').masked).toBe('Just {{CGPV_A}}.');
    expect(maskProtectedValues('Over 1,000.').masked).toBe('Over {{CGPV_A}}.');
  });

  it('tokenizes complete URLs and atomic structured values without overlap', () => {
    expect(
      protectedValues(
        'Visit https://x.test/a) https://x.test/b] https://x.test/c? ' +
          'https://x.test/d! https://x.test/e; https://x.test/f: and https://x.test/g.',
      ),
    ).toEqual([
      'https://x.test/a)',
      'https://x.test/b]',
      'https://x.test/c?',
      'https://x.test/d!',
      'https://x.test/e;',
      'https://x.test/f:',
      'https://x.test/g',
    ]);
    expect(
      protectedValues(
        'Call +971 (50) 123-4567 on 04/09/2026 at 10:30 PM; ' +
          'v2.4.1 costs AED 1,250.50, saves 15%, and lasts 3–5 days.',
      ),
    ).toEqual([
      '+971 (50) 123-4567',
      '04/09/2026',
      '10:30 PM',
      'v2.4.1',
      'AED 1,250.50',
      '15%',
      '3–5',
    ]);
  });

  it('masks quoted HTML attributes as one ordered span', () => {
    const source = '<a title="1 > 0" href="https://x.test/a)">Save 15%</a><!-- note -->';
    const mask = maskProtectedValues(source);
    expect(mask.masked).toBe('{{CGPV_A}}Save {{CGPV_B}}{{CGPV_C}}{{CGPV_D}}');
    expect(mask.restore(mask.masked)).toBe(source);
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
        'وفّر {{CGPV_A}} على {{CGPV_B}} لدى ' +
          '{{CGPV_C}} للعميل {{CGPV_D}}',
      ),
    ).toBe(
      'وفّر 20% على AED 150 لدى https://shop.example/x للعميل {customerName}',
    );
    expect(mask.restore('وفّر {{ cgpv-a }} على {{ CGPV _ B }}')).toBe(
      'وفّر {{ cgpv-a }} على {{ CGPV _ B }}',
    );
  });

  it('judges masked output by its markers, not by re-matching the restored prose', () => {
    const source = 'Enjoy artworks from AED 749 onwards, see https://noon.com.';
    const mask = maskProtectedValues(source);
    const masks = new Map([['copy', mask]]);
    expect(mask.labels).toEqual(['A', 'B']);
    const judge = (copy: string) =>
      validateTranslatedBatch([leaf('copy', source)], { copy }, ARABIC, masks);

    // Sentence-final price and reordered exact markers are fine.
    expect(judge('راجع {{CGPV_B}}، أعمال فنية تبدأ من {{CGPV_A}}.')).toEqual([]);
    expect(judge('راجع {{CGPV_B}}، أعمال فنية تبدأ من {{ cgpv-a }}.')).toEqual([
      { path: 'copy', problems: ['protected-value-changed'] },
    ]);
    // A dropped, duplicated or unknown marker is a changed fact.
    expect(judge('أعمال فنية تبدأ من {{CGPV_A}}.')).toEqual([
      { path: 'copy', problems: ['protected-value-changed'] },
    ]);
    expect(judge('من {{CGPV_A}} و{{CGPV_A}}، راجع {{CGPV_B}}.')).toEqual([
      { path: 'copy', problems: ['protected-value-changed'] },
    ]);
    expect(judge('من {{CGPV_A}}، راجع {{CGPV_B}} و{{CGPV_C}}.')).toEqual([
      { path: 'copy', problems: ['protected-value-changed'] },
    ]);
    expect(judge('من {{CGPV_A}}، راجع {{CGPV_B}} و{{ cgpv-c }}.')).toEqual([
      { path: 'copy', problems: ['protected-value-changed'] },
    ]);
    // So is any number the writer added on its own, in any digit script.
    expect(judge('من {{CGPV_A}} واحصل على خصم 50%، راجع {{CGPV_B}}.')).toEqual([
      { path: 'copy', problems: ['protected-value-changed'] },
    ]);
    expect(judge('من {{CGPV_A}} واحصل على ٥٠ درهم، راجع {{CGPV_B}}.')).toEqual([
      { path: 'copy', problems: ['protected-value-changed'] },
    ]);
    // Structure, budget and script checks still see the restored text.
    expect(
      validateTranslatedBatch(
        [leaf('copy', source, { maxLength: 10 })],
        { copy: 'راجع {{CGPV_B}}، أعمال فنية تبدأ من {{CGPV_A}}.' },
        ARABIC,
        masks,
      ),
    ).toEqual([{ path: 'copy', problems: ['over-budget'] }]);
    expect(judge('Enjoy artworks from {{CGPV_A}} onwards, see {{CGPV_B}}.')).toEqual([
      { path: 'copy', problems: ['untranslated-source', 'target-language-missing'] },
    ]);
  });

  it('keeps masked HTML markers in the structure check', () => {
    const source = '<ul><li>From AED 749.</li></ul>';
    const mask = maskProtectedValues(source);
    const masks = new Map([['body', mask]]);
    expect(mask.masked).toBe('{{CGPV_A}}{{CGPV_B}}From {{CGPV_C}}.{{CGPV_D}}{{CGPV_E}}');
    expect(
      validateTranslatedBatch(
        [leaf('body', source, { kind: 'richtext' })],
        { body: '{{CGPV_A}}{{CGPV_B}}من {{CGPV_C}}.{{CGPV_D}}{{CGPV_E}}' },
        ARABIC,
        masks,
      ),
    ).toEqual([]);
    expect(
      validateTranslatedBatch(
        [leaf('body', source, { kind: 'richtext' })],
        { body: '{{CGPV_B}}{{CGPV_A}}من {{CGPV_C}}.{{CGPV_D}}{{CGPV_E}}' },
        ARABIC,
        masks,
      ),
    ).toEqual([{ path: 'body', problems: ['html-structure-changed'] }]);
    expect(stripMarkers('{{CGPV_A}}من {{ cgpv b }}.')).toBe(' من {{ cgpv b }}.');
  });

  it('does not let a promotional heading claim the entity-name exemption', () => {
    expect(
      validateTranslatedBatch(
        [leaf('hero.products.0.titleOverride', 'Apple AirPods Pro', { identity: true })],
        { 'hero.products.0.titleOverride': 'Apple AirPods Pro' },
        ARABIC,
      ),
    ).toEqual([
      {
        path: 'hero.products.0.titleOverride',
        problems: ['untranslated-source', 'target-language-missing'],
      },
    ]);
  });

  it('uses alphabetic marker labels when dense copy contains more than 26 facts', () => {
    const source = Array.from({ length: 28 }, (_, index) => `${index + 1}%`).join(' ');
    const mask = maskProtectedValues(source);

    expect(mask.masked).toContain('{{CGPV_A}}');
    expect(mask.masked).toContain('{{CGPV_Z}}');
    expect(mask.masked).toContain('{{CGPV_AA}}');
    expect(mask.masked).toContain('{{CGPV_AB}}');
    expect(mask.restore(mask.masked)).toBe(source);
  });

  it('masks complete HTML tags so the model cannot alter attributes or structure', () => {
    const source = '<a href="https://shop.example/deal" rel="nofollow">Save 20%</a>';
    const mask = maskProtectedValues(source);

    expect(mask.masked).toBe('{{CGPV_A}}Save {{CGPV_B}}{{CGPV_C}}');
    expect(mask.restore('{{CGPV_A}}وفّر {{CGPV_B}}{{CGPV_C}}')).toBe(
      '<a href="https://shop.example/deal" rel="nofollow">وفّر 20%</a>',
    );
  });

  it('uses the real schema ceiling while prompting toward a shorter target', () => {
    expect(
      validateTranslatedBatch(
        [leaf('seo.metaDescription', 'Source', { maxLength: 4, validationMaxLength: 5 })],
        { 'seo.metaDescription': 'عربية' },
        ARABIC,
      ),
    ).toEqual([]);
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
        [leaf('name', 'Golden Scent', { identity: true })],
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
