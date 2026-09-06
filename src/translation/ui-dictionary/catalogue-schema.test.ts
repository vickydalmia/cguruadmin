import { describe, expect, it } from 'vitest';
import { parseCatalogueBody } from './catalogue-schema';
import { MAX_CATALOGUE_KEYS } from './constants';

const version = 'a'.repeat(64);

function problems(body: unknown): string[] {
  const result = parseCatalogueBody(body);
  return result.ok ? [] : result.problems.map((problem) => `${problem.path}: ${problem.message}`);
}

describe('parseCatalogueBody', () => {
  it('accepts the cross-repo push shape, plural rows included', () => {
    const result = parseCatalogueBody({
      version,
      entries: {
        'common.viewAll': { text: 'View all', description: 'Section link' },
        'seo.defaultTitle': { text: 'Coupons & Deals', maxLength: 60 },
        'offers.count.one': { text: '{count} offer', pluralOf: 'offers.count' },
        'offers.count.other': { text: '{count} offers', pluralOf: 'offers.count' },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value.entries)).toHaveLength(4);
      expect(result.value.entries['seo.defaultTitle'].maxLength).toBe(60);
    }
  });

  it.each([
    [null, 'body must be an object'],
    [[], 'body must be an object'],
    [{ version: 'abc', entries: { 'a.b': { text: 'x' } } }, 'version'],
    [{ version, entries: {} }, 'entries must not be empty'],
    [{ version, entries: { 'Common.viewAll': { text: 'x' } } }, 'key must be dotted'],
    [{ version, entries: { common: { text: 'x' } } }, 'key must be dotted'],
    [{ version, entries: { 'common.viewAll': { text: '' } } }, 'entries.common.viewAll.text'],
    [{ version, entries: { 'common.viewAll': { text: '   ' } } }, 'text must not be blank'],
    [{ version, entries: { 'common.viewAll': { text: 'x', maxLength: 0 } } }, 'maxLength'],
    [{ version, entries: { 'common.viewAll': { text: 'x', maxLength: 1.5 } } }, 'maxLength'],
    [{ version, entries: { 'common.viewAll': { text: 'x'.repeat(2_001) } } }, 'text'],
  ])('rejects %j', (body, expected) => {
    expect(problems(body).join('\n')).toContain(expected);
  });

  it('requires a plural key to be <pluralOf>.<CLDR category> and its base to push `other`', () => {
    expect(
      problems({
        version,
        entries: {
          'offers.count.some': { text: 'x', pluralOf: 'offers.count' },
          'offers.count.other': { text: 'y', pluralOf: 'offers.count' },
        },
      }).join('\n'),
    ).toContain('entries.offers.count.some.pluralOf');
    expect(
      problems({
        version,
        entries: { 'offers.count.one': { text: 'x', pluralOf: 'offers.count' } },
      }).join('\n'),
    ).toContain('must push its `other` form');
    expect(
      problems({
        version,
        entries: { 'offers.total.one': { text: 'x', pluralOf: 'offers.count' } },
      }).join('\n'),
    ).toContain('entries.offers.total.one.pluralOf');
  });

  it('caps the key count', () => {
    const entries: Record<string, { text: string }> = {};
    for (let index = 0; index <= MAX_CATALOGUE_KEYS; index += 1) {
      entries[`ns.k${index}`] = { text: 'x' };
    }
    expect(problems({ version, entries }).join('\n')).toContain(
      `must not exceed ${MAX_CATALOGUE_KEYS} keys`,
    );
  });
});
