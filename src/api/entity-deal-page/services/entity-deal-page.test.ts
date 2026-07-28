import { describe, expect, it, vi } from 'vitest';

import createEntityDealPageService, {
  entityDealPagePath,
  entityDealPageSlug,
  parseEntityDealPageSlug,
  parseSettingsSort,
  resolveEntityDealPageSeo,
  settingsComparator,
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

  // An entity write goes through the ISR outbox, so a PATCH that changes
  // nothing would otherwise cost a page rebuild every time the settings screen
  // saves an untouched row.
  it('skips the write when the patch changes nothing', async () => {
    const update = vi.fn().mockResolvedValue({});
    const stored = {
      id: 12,
      indexingEnabled: true,
      metaTitle: 'Amazon deals',
      ogImage: { id: 99, documentId: 'file-99', url: '/share.webp' },
    };
    const strapi = {
      documents: vi.fn(() => ({
        findOne: vi.fn().mockResolvedValue({
          documentId: 'store-1',
          entityDealPageSeo: stored,
        }),
        update,
      })),
    } as any;
    const service = createEntityDealPageService({ strapi });

    const result = await service.updateSettings('store', 'store-1', {
      entityDealPageSeo: {
        indexingEnabled: true,
        metaTitle: 'Amazon deals',
        ogImage: 99,
      },
    });

    expect(update).not.toHaveBeenCalled();
    expect(result?.data.entityDealPageSeo).toMatchObject({
      indexingEnabled: true,
      metaTitle: 'Amazon deals',
    });
  });
});

describe('entity Deal-page public read', () => {
  function harness(dealRows: any[], matchedTotal: number) {
    const dealFindMany = vi.fn().mockResolvedValue(dealRows);
    const dealCount = vi.fn().mockResolvedValue(matchedTotal);

    const documents = vi.fn((uid: string) => {
      if (uid === 'api::deal.deal') {
        return { findMany: dealFindMany, count: dealCount };
      }
      if (uid === 'api::redirect.redirect') {
        return { findMany: vi.fn().mockResolvedValue([]) };
      }
      // Only the store collection owns the slug; the other three miss.
      return {
        findMany: vi.fn(async (options: any) => {
          const wantsDealSlug = JSON.stringify(options.filters).includes(
            'amazon-deals',
          );
          if (uid !== 'api::store.store' || wantsDealSlug) return [];
          return [{ documentId: 'store-1', slug: 'amazon', name: 'Amazon' }];
        }),
      };
    });

    return {
      strapi: {
        documents,
        contentType: vi.fn(() => ({})),
        contentAPI: { sanitize: { output: vi.fn(async (data: any) => data) } },
      } as any,
      dealFindMany,
      dealCount,
    };
  }

  it('paginates deals in the database instead of slicing in memory', async () => {
    const deal = {
      documentId: 'deal-1',
      contentStatus: 'published',
      salePrice: 100,
      affiliateLink: 'https://example.com/go',
      dealImage: { url: '/deal.webp' },
    };
    const { strapi, dealFindMany, dealCount } = harness([deal], 137);
    const service = createEntityDealPageService({ strapi });

    const result = await service.getPublicPage('amazon-deals', {
      page: 2,
      pageSize: 50,
    });

    expect(dealFindMany).toHaveBeenCalledTimes(1);
    expect(dealFindMany.mock.calls[0][0]).toMatchObject({
      start: 50,
      limit: 50,
    });
    expect(dealCount).toHaveBeenCalledTimes(1);
    expect(result?.data.pagination).toMatchObject({
      page: 2,
      pageSize: 50,
      total: 137,
      pageCount: 3,
    });
    expect(result?.data.deals).toHaveLength(1);
  });

  it('clamps a fractional page to an integer offset', async () => {
    const { strapi, dealFindMany } = harness([], 0);
    const service = createEntityDealPageService({ strapi });

    await service.getPublicPage('amazon-deals', { page: 2.9, pageSize: 10.7 });

    expect(dealFindMany.mock.calls[0][0]).toMatchObject({
      start: 10,
      limit: 10,
    });
  });

  // The SQL filter is a superset of isActionableProductDeal, so a non-zero
  // match count does not prove the page has anything to render.
  it('resolves the exact count when a page yields nothing actionable', async () => {
    const unsafe = {
      documentId: 'deal-1',
      contentStatus: 'published',
      salePrice: 100,
      affiliateLink: 'javascript:alert(1)',
      dealImage: { url: '/deal.webp' },
    };
    const { strapi, dealFindMany } = harness([unsafe], 3);
    const service = createEntityDealPageService({ strapi });

    const result = await service.getPublicPage('amazon-deals', {});

    expect(result?.data.deals).toHaveLength(0);
    // One paged read plus the reconciling scan.
    expect(dealFindMany).toHaveBeenCalledTimes(2);
    expect(result?.data.pagination.total).toBe(0);
    expect(result?.data.seo.blockers).toContain('no-live-deals');
  });
});

describe('settings sort', () => {
  const item = (
    name: string,
    liveDealCount: number,
    updatedAt?: string,
  ) => ({
    name,
    entityType: 'store',
    documentId: `doc-${name}`,
    liveDealCount,
    updatedAt,
  });

  it('defaults to name ascending and ignores unknown input', () => {
    const fallback = { field: 'name', desc: false };
    expect(parseSettingsSort(undefined)).toEqual(fallback);
    expect(parseSettingsSort('')).toEqual(fallback);
    expect(parseSettingsSort('salePrice:desc')).toEqual(fallback);
    expect(parseSettingsSort(42)).toEqual(fallback);
    // A malformed direction is not an error, just not descending.
    expect(parseSettingsSort('liveDealCount:sideways')).toEqual({
      field: 'liveDealCount',
      desc: false,
    });
  });

  it('parses the supported fields and directions', () => {
    expect(parseSettingsSort('liveDealCount:desc')).toEqual({
      field: 'liveDealCount',
      desc: true,
    });
    expect(parseSettingsSort('updatedAt:asc')).toEqual({
      field: 'updatedAt',
      desc: false,
    });
    expect(parseSettingsSort('name:DESC')).toEqual({ field: 'name', desc: true });
  });

  it('orders by live Deal count in both directions', () => {
    const items = [item('Bravo', 3), item('Alpha', 12), item('Charlie', 0)];

    expect(
      [...items].sort(settingsComparator({ field: 'liveDealCount', desc: true }))
        .map((row) => row.name),
    ).toEqual(['Alpha', 'Bravo', 'Charlie']);

    expect(
      [...items].sort(settingsComparator({ field: 'liveDealCount', desc: false }))
        .map((row) => row.name),
    ).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  // listSettings paginates AFTER sorting, so ties must resolve identically on
  // every request or offset pagination repeats one row and drops another.
  it('breaks ties deterministically regardless of input order', () => {
    const rows = [item('Zulu', 0), item('Alpha', 0), item('Mike', 0)];
    const sorted = (input: typeof rows) =>
      [...input]
        .sort(settingsComparator({ field: 'liveDealCount', desc: true }))
        .map((row) => row.name);

    expect(sorted(rows)).toEqual(['Alpha', 'Mike', 'Zulu']);
    expect(sorted([...rows].reverse())).toEqual(['Alpha', 'Mike', 'Zulu']);
  });

  it('sorts never-updated entities last when ascending', () => {
    const items = [
      item('Bravo', 1, '2026-07-01T00:00:00.000Z'),
      item('Alpha', 1, undefined),
      item('Charlie', 1, '2026-07-20T00:00:00.000Z'),
    ];

    expect(
      [...items].sort(settingsComparator({ field: 'updatedAt', desc: true }))
        .map((row) => row.name),
    ).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });
});
