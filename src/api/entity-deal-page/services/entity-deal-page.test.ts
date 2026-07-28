import { describe, expect, it, vi } from 'vitest';

import createEntityDealPageService, {
  entityDealPagePath,
  entityDealPageSlug,
  parseEntityDealPageSlug,
  resolveEntityDealPageSeo,
} from './entity-deal-page';

describe('entity Deal-page URL contract', () => {
  it('derives and parses the generated flat route', () => {
    expect(entityDealPageSlug('mobile')).toBe('mobile-deals');
    expect(entityDealPagePath('mobile')).toBe('/mobile-deals/');
    expect(parseEntityDealPageSlug('/mobile-deals/')).toBe('mobile');
    expect(parseEntityDealPageSlug('mobile')).toBeNull();
    expect(parseEntityDealPageSlug('-deals')).toBeNull();
    expect(parseEntityDealPageSlug('categories/mobile-deals')).toBeNull();
  });
});

describe('resolveEntityDealPageSeo', () => {
  it('defaults every new page to noindex while retaining SEO fallbacks', () => {
    const seo = resolveEntityDealPageSeo({
      entity: { name: 'Mobile' },
      publicSlug: 'mobile',
      liveDealCount: 4,
    });

    expect(seo).toMatchObject({
      metaTitle: 'Mobile Deals & Offers',
      canonical: '/mobile-deals/',
      indexingEnabled: false,
      effectiveIndexable: false,
      noIndex: true,
      blockers: ['indexing-disabled'],
      ogTitle: 'Mobile Deals & Offers',
      ogDescription:
        'Discover the latest Mobile product deals, prices and offers on CouponzGuru.',
    });
  });

  it('allows indexing only when enabled, populated, conflict-free, and self-canonical', () => {
    const seo = resolveEntityDealPageSeo({
      entity: {
        name: 'Mobile',
        entityDealPageSeo: {
          indexingEnabled: true,
          canonicalUrl: '/mobile-deals',
        },
      },
      publicSlug: 'mobile',
      liveDealCount: 1,
    });

    expect(seo.canonical).toBe('/mobile-deals/');
    expect(seo.effectiveIndexable).toBe(true);
    expect(seo.noIndex).toBe(false);
    expect(seo.blockers).toEqual([]);
  });

  it('forces noindex when an enabled page is empty or points elsewhere', () => {
    const seo = resolveEntityDealPageSeo({
      entity: {
        name: 'Mobile',
        entityDealPageSeo: {
          indexingEnabled: true,
          canonicalUrl: '/other-deals/',
        },
      },
      publicSlug: 'mobile',
      liveDealCount: 0,
      routeConflict: true,
    });

    expect(seo.noIndex).toBe(true);
    expect(seo.blockers).toEqual([
      'no-live-deals',
      'canonical-not-self',
      'route-conflict',
    ]);
  });
});

describe('entity Deal-page settings write', () => {
  it('updates the hidden component without echoing an untouched populated image', async () => {
    const update = vi.fn().mockResolvedValue({});
    const strapi = {
      documents: vi.fn(() => ({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'store-1',
          entityDealPageSeo: {
            id: 12,
            indexingEnabled: false,
            metaTitle: 'Amazon deals',
            ogImage: { id: 99, documentId: 'file-99', url: '/share.webp' },
          },
        }),
        update,
      })),
    } as any;
    const service = createEntityDealPageService({ strapi });

    await service.updateSettings('store', 'store-1', {
      entityDealPageSeo: { indexingEnabled: true, unknown: 'ignored' },
    });

    expect(update).toHaveBeenCalledWith({
      documentId: 'store-1',
      data: {
        entityDealPageSeo: {
          id: 12,
          indexingEnabled: true,
          metaTitle: 'Amazon deals',
        },
      },
    });
  });
});
