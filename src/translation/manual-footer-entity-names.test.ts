import { describe, expect, it, vi } from 'vitest';
import { verifyManualFooterEntityNames, manualFooterEntityName } from './manual-footer-entity-names';
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
function harness(stores = [amazon], footer = entry([]), entityUid = 'api::store.store') {
  const findMany = vi.fn().mockResolvedValue(stores);
  const strapi = {
    getModel: (model: string) => models[model] ?? { attributes: {} },
    documents: () => ({ findOne: vi.fn().mockResolvedValue(footer) }),
    db: { query: (model: string) => model === entityUid
      ? { findMany } : { findMany: vi.fn().mockResolvedValue(model === uid ? [footer] : []) } },
  } as any;
  return { strapi, findMany };
}

describe('manual footer entity-name verification', () => {
  it.each(['store', 'brand', 'category', 'bank'])('verifies manual links against %s records', async (kind) => {
    const entities = [
      { documentId: 'calo', slug: 'calo-coupons', name: 'CALO' },
      { documentId: 'samsung', slug: 'samsung-coupons', name: 'Samsung' },
    ];
    const source = entry(entities.map(({ name, slug }) => ({ label: name, url: `/${slug}/` })));
    const { strapi } = harness(entities, source, `api::${kind}.${kind}`);
    const loaded = await loadPopulatedEntry(strapi, uid, 'footer-id', 'en');
    const leaves = collectTranslatableLeaves(strapi, uid, loaded).filter((leaf) => leaf.path.endsWith('.label'));
    expect(leaves.map((leaf) => leaf.linkedEntityName)).toEqual(['CALO', 'Samsung']);
    expect(validateTranslatedBatch(leaves, Object.fromEntries(leaves.map((leaf) => [leaf.path, leaf.value])), /\p{Script=Arabic}/u)).toEqual([]);
  });

  it('rejects a slug shared by different entity types even with the same document ID and name', async () => {
    const { strapi } = harness();
    strapi.db.query = () => ({ findMany: vi.fn().mockResolvedValue([amazon]) });
    const link = { label: 'Amazon', url: '/amazon-coupons/' };
    await verifyManualFooterEntityNames(strapi, uid, [entry([link])], 'en');
    expect(manualFooterEntityName(link)).toBeUndefined();
  });

  it('verifies exact names by English slug without changing CMS content or adding relations', async () => {
    const link = { label: 'Amazon', url: '/amazon-coupons/' };
    const source = entry([link, { label: 'View All Stores', url: '/stores/' }]);
    const before = JSON.stringify(source);
    const { strapi, findMany } = harness();
    await verifyManualFooterEntityNames(strapi, uid, [source], 'en');
    expect(findMany).toHaveBeenCalledOnce();
    expect(findMany).toHaveBeenCalledWith({
      where: { locale: 'en', slug: { $in: ['amazon-coupons', 'stores'] } },
      select: ['documentId', 'slug', 'name'],
    });
    expect(JSON.stringify(source)).toBe(before);
    expect(link).not.toHaveProperty('store');
    const leaves = collectTranslatableLeaves(strapi, uid, source);
    expect(leaves.find((leaf) => leaf.path === 'sections.0.links.0.label')?.linkedEntityName).toBe('Amazon');
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
    await verifyManualFooterEntityNames(strapi, uid, [entry([link])], 'en');
    expect(manualFooterEntityName(link)).toBeUndefined();
  });

  it('rejects ambiguous slugs, but accepts identical draft/published rows', async () => {
    for (const [stores, expected] of [
      [[amazon, { ...amazon }], 'Amazon'],
      [[amazon, { ...amazon, documentId: 'other' }], undefined],
      [[amazon, { ...amazon, name: 'Different' }], undefined],
    ] as const) {
      const { strapi } = harness([...stores]);
      const link = { label: 'Amazon', url: '/amazon-coupons/' };
      await verifyManualFooterEntityNames(strapi, uid, [entry([link])], 'en');
      expect(manualFooterEntityName(link)).toBe(expected);
    }
  });

  it('does not override explicit relations or trust serialized evidence', async () => {
    const { strapi, findMany } = harness();
    const links = [
      { label: 'Amazon', url: '/amazon-coupons/', store: { documentId: 'other' } },
      { label: 'Amazon', url: '/amazon-coupons/', category: { documentId: 'category' } },
    ];
    await verifyManualFooterEntityNames(strapi, uid, [entry(links)], 'en');
    expect(findMany).not.toHaveBeenCalled();
    for (const link of links) expect(manualFooterEntityName(link)).toBeUndefined();
    const link = { label: 'Amazon', url: '/amazon-coupons/?from=footer#top' };
    await verifyManualFooterEntityNames(strapi, uid, [entry([link])], 'en');
    expect(manualFooterEntityName(link)).toBe('Amazon');
    expect(manualFooterEntityName(JSON.parse(JSON.stringify(link)))).toBeUndefined();
    link.url = '/other/';
    expect(manualFooterEntityName(link)).toBeUndefined();
  });

  it.each(['single', 'batch'])('runs verification through the %s translation loader', async (mode) => {
    const source = entry([{ label: 'Amazon', url: '/amazon-coupons/' }]);
    const { strapi } = harness([amazon], source);
    const loaded = mode === 'single'
      ? await loadPopulatedEntry(strapi, uid, 'footer-id', 'en')
      : (await loadPopulatedEntries(strapi, uid, ['footer-id'], 'en'))[0];
    expect(collectTranslatableLeaves(strapi, uid, loaded)[1].linkedEntityName).toBe('Amazon');
  });

  it('does no extra lookup for other types or target-language reads', async () => {
    const { strapi, findMany } = harness();
    const source = entry([{ label: 'Amazon', url: '/amazon-coupons/' }]);
    await verifyManualFooterEntityNames(strapi, uid, [source], 'ar');
    await verifyManualFooterEntityNames(strapi, 'api::homepage.homepage', [source], 'en');
    expect(findMany).not.toHaveBeenCalled();
  });
});
