import { describe, expect, it } from 'vitest';
import { maskProtectedValues, validateTranslatedBatch } from './validate';
import type { TranslatableLeaf } from './field-map';

const path = 'supportCta.emailLabel';
const arabic = /\p{Script=Arabic}/u;

describe('protected facts versus translatable prose', () => {
  it.each([
    'admin@couponzguru.com',
    'https://www.couponzguru.ae/contact-us/',
    '{{email}}',
    'AED 100',
    '<a href="mailto:admin@couponzguru.com">admin@couponzguru.com</a>',
  ])('accepts unchanged protected-only content: %s', (source) => {
    const leaf: TranslatableLeaf = { path, value: source, kind: source.startsWith('<') ? 'richtext' : 'plain' };
    expect(validateTranslatedBatch([leaf], { [path]: source }, arabic)).toEqual([]);
    const mask = maskProtectedValues(source);
    expect(validateTranslatedBatch([leaf], { [path]: mask.masked }, arabic,
      new Map([[path, mask]]))).toEqual([]);
  });

  it.each(['البريد الإلكتروني', 'other@couponzguru.com', ''])('rejects removed or altered email facts: %s', (output) => {
    const leaf: TranslatableLeaf = { path, value: 'admin@couponzguru.com', kind: 'plain' };
    expect(validateTranslatedBatch([leaf], { [path]: output }, arabic)[0].problems)
      .toContain('protected-value-changed');
    const mask = maskProtectedValues(leaf.value);
    expect(validateTranslatedBatch([leaf], { [path]: output }, arabic,
      new Map([[path, mask]]))[0].problems).toContain('protected-value-changed');
  });

  it.each(['Email admin@couponzguru.com', 'Visit https://www.couponzguru.ae/', 'Save AED 100', 'Offers']) (
    'still requires translation of prose around facts: %s', (source) => {
      const leaf: TranslatableLeaf = { path, value: source, kind: 'plain' };
      const mask = maskProtectedValues(source);
      for (const verdicts of [
        validateTranslatedBatch([leaf], { [path]: source }, arabic),
        validateTranslatedBatch([leaf], { [path]: mask.masked }, arabic, new Map([[path, mask]])),
      ]) {
        expect(verdicts[0].problems).toEqual(['untranslated-source', 'target-language-missing']);
      }
    },
  );

  it('accepts translated prose with the email intact', () => {
    const leaf: TranslatableLeaf = { path, value: 'Email admin@couponzguru.com', kind: 'plain' };
    expect(validateTranslatedBatch([leaf], { [path]: 'راسل admin@couponzguru.com' }, arabic)).toEqual([]);
  });
});
