import { describe, expect, it, vi } from 'vitest';
import { verifyManualFooterStoreNames, manualFooterStoreName } from './manual-footer-store-names';
import { collectTranslatableLeaves } from './field-map';
import { validateTranslatedBatch } from './validate';
import { loadPopulatedEntry, loadPopulatedEntries } from './writer';

const uid = 'api::footer.footer';
const models: Record<string, any> = {
  [uid]: require('../api/footer/content-types/footer/schema.json'),
  'footer.link-section': require('../components/footer/link-section.json'),
  'nav.link': require('../components/nav/link.json'),
};
const amazon = { documentId: 'amazon-id', slug: 'amazon-coupons', name: 'Amazon' };
const entry = (links: any[]) => ({ sections: [{ title: 'Popular Stores', links }] });
function harness(stores = [amazon], footer = entry([])) {
  const findMany = vi.fn().mockResolvedValue(stores);
  const strapi = {
    getModel: (model: string) => models[model] ?? { attributes: {} },
    documents: () => ({ findOne: vi.fn().mockResolvedValue(footer) }),
    db: { query: (model: string) => model === 'api::store.store'
      ? { findMany } : { findMany: vi.fn().mockResolvedValue([footer]) } },
  } as any;
  return { strapi, findMany };
}

describe('manual footer store-name verification', () => {
  it('verifies exact names by English slug without changing CMS content or adding relations', async () => {
    const link = { label: 'Amazon', url: '/amazon-coupons/' };
    const source = entry([link, { label: 'View All Stores', url: '/stores/' }]);
    const before = JSON.stringify(source);
    const { strapi, findMany } = harness();
    await verifyManualFooterStoreNames(strapi, uid, [source], 'en');
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith({
      where: { locale: 'en', slug: { $in: ['amazon-coupons', 'stores'] } },
      select: ['documentId', 'slug', 'name'],
    });
    expect(JSON.stringify(source)).toBe(before);
    expect(link).not.toHaveProperty('store');
    const leaves = collectTranslatableLeaves(strapi, uid, source);
    expect(leaves.find((leaf) => leaf.path === 'sections.0.links.0.label')?.linkedStoreName).toBe('Amazon');
    const unchanged = Object.fromEntries(leaves.map((leaf) => [leaf.path, leaf.value]));
    expect(validateTranslatedBatch(leaves, unchanged, /\p{Script=Arabic}/u).map((v) => v.path))
      .toEqual(['sections.0.title', 'sections.0.links.1.label']);
  });

  it.each([
    ['Amazon Sale', '/amazon-coupons/'],
    ['Amazon', '/missing/'],
    ['Amazon', 'https://evil.example/amazon-coupons/'],
    ['Amazon', '//evil.example/amazon-coupons/'],
    ['Amazon', '/x/../amazon-coupons/'],
    ['Amazon', '/ar/amazon-coupons/'],
    ['Amazon', 'javascript:alert(1)'],
  ])('does not exempt unverified label %s at %s', async (label, url) => {
    const { strapi } = harness();
    const link = { label, url };
    await verifyManualFooterStoreNames(strapi, uid, [entry([link])], 'en');
    expect(manualFooterStoreName(link)).toBeUndefined();
  });

  it('rejects ambiguous slugs, but accepts identical draft/published rows', async () => {
    for (const [stores, expected] of [
      [[amazon, { ...amazon }], 'Amazon'],
      [[amazon, { ...amazon, documentId: 'other' }], undefined],
      [[amazon, { ...amazon, name: 'Different' }], undefined],
    ] as const) {
      const { strapi } = harness([...stores]);
      const link = { label: 'Amazon', url: '/amazon-coupons/' };
      await verifyManualFooterStoreNames(strapi, uid, [entry([link])], 'en');
      expect(manualFooterStoreName(link)).toBe(expected);
    }
  });

  it('does not override explicit relations or trust serialized evidence', async () => {
    const { strapi, findMany } = harness();
    const links = [
      { label: 'Amazon', url: '/amazon-coupons/', store: { documentId: 'other' } },
      { label: 'Amazon', url: '/amazon-coupons/', category: { documentId: 'category' } },
    ];
    await verifyManualFooterStoreNames(strapi, uid, [entry(links)], 'en');
    expect(findMany).not.toHaveBeenCalled();
    for (const link of links) expect(manualFooterStoreName(link)).toBeUndefined();
    const link = { label: 'Amazon', url: '/amazon-coupons/?from=footer#top' };
    await verifyManualFooterStoreNames(strapi, uid, [entry([link])], 'en');
    expect(manualFooterStoreName(link)).toBe('Amazon');
    expect(manualFooterStoreName(JSON.parse(JSON.stringify(link)))).toBeUndefined();
    link.url = '/other/';
    expect(manualFooterStoreName(link)).toBeUndefined();
  });

  it.each(['single', 'batch'])('runs verification through the %s translation loader', async (mode) => {
    const source = entry([{ label: 'Amazon', url: '/amazon-coupons/' }]);
    const { strapi } = harness([amazon], source);
    const loaded = mode === 'single'
      ? await loadPopulatedEntry(strapi, uid, 'footer-id', 'en')
      : (await loadPopulatedEntries(strapi, uid, ['footer-id'], 'en'))[0];
    expect(collectTranslatableLeaves(strapi, uid, loaded)[1].linkedStoreName).toBe('Amazon');
  });

  it('does no extra lookup for other types or target-language reads', async () => {
    const { strapi, findMany } = harness();
    const source = entry([{ label: 'Amazon', url: '/amazon-coupons/' }]);
    await verifyManualFooterStoreNames(strapi, uid, [source], 'ar');
    await verifyManualFooterStoreNames(strapi, 'api::homepage.homepage', [source], 'en');
    expect(findMany).not.toHaveBeenCalled();
  });
});
