import { describe, expect, it, vi } from 'vitest';
import { slugify } from '../constants/slugify';
import { toNameKey } from './identity-collisions';
import { IDENTITY_UIDS, type IdentityUid } from './identity-uids';
import { toRouteSlug, validateIdentity } from './identity-validation';

type Row = {
  documentId: string;
  name?: string;
  slug?: string;
  from?: string;
  to?: string;
  active?: boolean;
};
type Db = Partial<Record<IdentityUid | 'api::redirect.redirect', Row[]>>;

/**
 * Emulate Postgres LIKE, wildcards included — the whole point of the
 * "50% Off Store" case is that the DB hands back rows the JS pass must reject.
 */
function likeMatches(pattern: string, value: string): boolean {
  const source = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp(`^${source}$`, 'i').test(value);
}

function harness(db: Db = {}, stored: Row | null = null) {
  const findOne = vi.fn().mockResolvedValue(stored);
  const findMany = vi.fn();
  const queries: Array<{ uid: string; filters: any }> = [];

  const documents = vi.fn((uid: string) => ({
    findOne,
    findMany: (params: any) => {
      queries.push({ uid, filters: params?.filters });
      findMany(params);
      const rows = db[uid as keyof Db] ?? [];

      const nameFilter = params?.filters?.name?.$containsi;
      if (typeof nameFilter === 'string') {
        return Promise.resolve(
          rows.filter((row) =>
            likeMatches(`%${nameFilter}%`, row.name ?? '')
          )
        );
      }

      const slugFilter = (params?.filters?.$or ?? []).map(
        (clause: any) => String(clause?.slug?.$eqi ?? '').toLowerCase(),
      );
      if (slugFilter.length > 0) {
        return Promise.resolve(
          rows.filter((row) => slugFilter.includes((row.slug ?? '').toLowerCase()))
        );
      }

      if (params?.filters?.active === true) {
        return Promise.resolve(rows.filter((row) => row.active !== false));
      }

      return Promise.resolve(rows);
    },
  }));

  return { strapi: { documents } as any, findOne, findMany, queries };
}

const detailPaths = async (promise: Promise<unknown>): Promise<string[][]> => {
  try {
    await promise;
  } catch (error: any) {
    return error?.details?.errors?.map((e: any) => e.path) ?? [];
  }
  throw new Error('expected validateIdentity to reject');
};

describe('toRouteSlug', () => {
  it('mirrors the frontend namespace stripping', () => {
    expect(toRouteSlug('amazon', 'store')).toBe('amazon');
    expect(toRouteSlug('/amazon/', 'store')).toBe('amazon');
    expect(toRouteSlug('  amazon  ', 'store')).toBe('amazon');
    expect(toRouteSlug('stores/amazon', 'store')).toBe('amazon');
    expect(toRouteSlug('store/amazon', 'store')).toBe('amazon');
    expect(toRouteSlug('categories/deals', 'category')).toBe('deals');
    expect(toRouteSlug('Stores/amazon', 'store')).toBe('amazon');
    expect(toRouteSlug('STORE/Amazon', 'store')).toBe('Amazon');
    // Another type's namespace is NOT stripped — it is part of the route.
    expect(toRouteSlug('stores/amazon', 'bank')).toBe('stores/amazon');
    expect(toRouteSlug('', 'store')).toBe('');
    expect(toRouteSlug(undefined, 'store')).toBe('');
  });
});

describe('toNameKey', () => {
  it('folds case and surrounding whitespace only', () => {
    expect(toNameKey('  AMAZON ')).toBe('amazon');
    expect(toNameKey('Amazon')).toBe(toNameKey('amazon '));
    expect(toNameKey(null)).toBe('');
  });
});

describe('validateIdentity — grandfathering', () => {
  it('ignores a payload that touches neither name nor slug (the cron tick)', async () => {
    const { strapi, findOne, findMany } = harness({
      'api::store.store': [{ documentId: 's1', name: 'Amazon', slug: 'amazon' }],
    });

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'update',
        { contentStatus: 'expired' },
        's1'
      )
    ).resolves.toBeUndefined();

    // No stored read and no query: a partial write must cost nothing and can
    // never trip on a value it did not send.
    expect(findOne).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('lets a legacy duplicate name re-save when the payload leaves it unchanged', async () => {
    // Two stores already share a name in production. Editing one of them must
    // still work as long as the editor is not the one introducing the clash.
    const { strapi, findMany } = harness(
      {
        'api::store.store': [
          { documentId: 's1', name: 'Amazon', slug: 'amazon' },
          { documentId: 's2', name: 'amazon ', slug: 'amazon-in' },
        ],
      },
      { documentId: 's2', name: 'amazon ', slug: 'amazon-in' }
    );

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'update',
        { name: 'amazon ', slug: 'amazon-in', shortDescription: 'edited' },
        's2'
      )
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('lets a legacy cross-type slug collision re-save when the slug is unchanged', async () => {
    const { strapi, findMany } = harness(
      {
        'api::store.store': [{ documentId: 's1', name: 'Amazon', slug: 'amazon' }],
        'api::bank.bank': [{ documentId: 'b1', name: 'Amazon Pay', slug: 'amazon' }],
      },
      { documentId: 'b1', name: 'Amazon Pay', slug: 'amazon' }
    );

    await expect(
      validateIdentity(
        strapi,
        'api::bank.bank',
        'update',
        { name: 'Amazon Pay', slug: 'amazon', ratingCount: 12 },
        'b1'
      )
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('treats a namespaced stored slug as unchanged when it routes the same', async () => {
    // Stored "stores/amazon" and incoming "amazon" are the SAME public route,
    // so this is not an edit and must not be validated (or self-collide).
    const { strapi, findMany } = harness(
      { 'api::store.store': [{ documentId: 's1', name: 'Amazon', slug: 'stores/amazon' }] },
      { documentId: 's1', name: 'Amazon', slug: 'stores/amazon' }
    );

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'update',
        { name: 'Amazon', slug: 'amazon' },
        's1'
      )
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('is a no-op for content types outside the taxonomy', async () => {
    const { strapi, findOne, findMany } = harness();

    await expect(
      validateIdentity(strapi, 'api::coupon.coupon', 'update', { name: 'x', slug: 'y' }, 'c1')
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('validateIdentity — name uniqueness within a type', () => {
  it('rejects a duplicate name ignoring case and surrounding whitespace', async () => {
    const { strapi } = harness({
      'api::store.store': [{ documentId: 's1', name: '  AMAZON ', slug: 'amazon' }],
    });

    await expect(
      detailPaths(
        validateIdentity(strapi, 'api::store.store', 'create', {
          name: 'amazon',
          slug: 'amazon-two',
        })
      )
    ).resolves.toEqual([['name']]);
  });

  it('rejects a cross-type name collision because Deal routes share one namespace', async () => {
    const { strapi } = harness({
      'api::brand.brand': [{ documentId: 'b1', name: 'Amazon', slug: 'amazon-brand' }],
    });

    await expect(
      detailPaths(
        validateIdentity(strapi, 'api::store.store', 'create', {
          name: 'Amazon',
          slug: 'amazon-store',
        })
      )
    ).resolves.toEqual([['name']]);
  });

  it('excludes the row being edited even when the query hands it back', async () => {
    // Defensive: the middleware runs before the write, so a consistent read
    // cannot normally return self for a name that actually changed. It can if
    // the document service replays the check or serves a stale row — modelled
    // here by a stored name that disagrees with the row the query returns. The
    // editor must not be told they collide with themselves.
    const { strapi, findMany } = harness(
      { 'api::store.store': [{ documentId: 's1', name: 'Amazon Pay', slug: 'amazon' }] },
      { documentId: 's1', name: 'Amazon', slug: 'amazon' }
    );

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'update',
        { name: 'Amazon Pay', slug: 'amazon' },
        's1'
      )
    ).resolves.toBeUndefined();
    // The query really did run and really did return the self row.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { name: { $containsi: 'Amazon Pay' } } })
    );
  });

  it('excludes the edited row from the cross-type slug check too', async () => {
    const { strapi } = harness(
      { 'api::brand.brand': [{ documentId: 'b1', name: 'Nike', slug: 'nike' }] },
      { documentId: 'b1', name: 'Nike', slug: 'nike-old' }
    );

    await expect(
      validateIdentity(
        strapi,
        'api::brand.brand',
        'update',
        { name: 'Nike', slug: 'nike' },
        'b1'
      )
    ).resolves.toBeUndefined();
  });

  it('rejects distinct names that slugify to the same Deal route', async () => {
    // "50% Off Store" makes $containsi build LIKE '%50% Off Store%', which the
    // database happily matches against "50 Off Store". Confirming the hit in
    // JS is the only thing standing between this store and a bogus rejection.
    const { strapi, queries } = harness({
      'api::store.store': [
        { documentId: 's1', name: '50 Off Store', slug: 'fifty-off' },
        { documentId: 's2', name: '50-Off Store', slug: 'fifty-dash-off' },
      ],
    });

    await expect(
      detailPaths(
        validateIdentity(strapi, 'api::store.store', 'create', {
          name: '50% Off Store',
          slug: '50-off-store',
        })
      )
    ).resolves.toEqual([['name']]);

    // Prove the DB really did return the wildcard matches that JS discarded.
    const nameQuery = queries.find((q) => q.filters?.name);
    expect(nameQuery?.filters.name).toEqual({ $containsi: '50% Off Store' });
    expect(likeMatches('%50% Off Store%', '50 Off Store')).toBe(true);
  });

  it('still rejects a true duplicate of a wildcard-bearing name', async () => {
    const { strapi } = harness({
      'api::store.store': [{ documentId: 's1', name: '  50% off store  ', slug: 'legacy' }],
    });

    await expect(
      detailPaths(
        validateIdentity(strapi, 'api::store.store', 'create', {
          name: '50% Off Store',
          slug: '50-off-store',
        })
      )
    ).resolves.toEqual([['name']]);
  });
});

describe('validateIdentity — flat slug namespace (row 113)', () => {
  it('rejects a bank taking a store slug', async () => {
    const { strapi } = harness({
      'api::store.store': [{ documentId: 's1', name: 'Amazon', slug: 'amazon' }],
    });

    await expect(
      validateIdentity(strapi, 'api::bank.bank', 'create', {
        name: 'Amazon Pay',
        slug: 'amazon',
      })
    ).rejects.toThrow(/already used by the store "Amazon"/);
  });

  it.each(IDENTITY_UIDS)('checks %s against every other type', async (uid) => {
    const { strapi, queries } = harness();

    await validateIdentity(strapi, uid, 'create', { name: 'Fresh', slug: 'fresh' });

    expect(queries.filter((q) => q.filters?.$or).map((q) => q.uid)).toEqual([
      ...IDENTITY_UIDS,
      ...IDENTITY_UIDS,
    ]);
  });

  it('rejects an entity whose root would occupy another entity Deal-page URL', async () => {
    const { strapi } = harness({
      'api::category.category': [
        { documentId: 'c1', name: 'Mobile', slug: 'mobile' },
      ],
    });

    await expect(
      validateIdentity(strapi, 'api::store.store', 'create', {
        name: 'Mobile Deals',
        slug: 'mobile-deals',
      }),
    ).rejects.toThrow(/generated Product Deal page.*category "Mobile"/);
  });

  it('rejects an entity whose generated Deal-page URL is an entity root', async () => {
    const { strapi } = harness({
      'api::brand.brand': [
        { documentId: 'b1', name: 'Nike Deals', slug: 'nike-deals' },
      ],
    });

    await expect(
      validateIdentity(strapi, 'api::store.store', 'create', {
        name: 'Nike',
        slug: 'nike',
      }),
    ).rejects.toThrow(/generates.*nike-deals.*brand "Nike Deals"/);
  });

  it('rejects an entity whose own root equals its name-derived Deal route', async () => {
    const { strapi } = harness();

    await expect(
      validateIdentity(strapi, 'api::store.store', 'create', {
        name: 'Nike',
        slug: 'nike-deals',
      }),
    ).rejects.toThrow(/also the generated Product Deal URL/);
  });

  it('sees through a stored type namespace on the OTHER row', async () => {
    // "stores/amazon" routes as /amazon/ — a raw string comparison would miss
    // this and let the build break.
    const { strapi } = harness({
      'api::store.store': [{ documentId: 's1', name: 'Amazon', slug: 'stores/amazon' }],
    });

    await expect(
      validateIdentity(strapi, 'api::bank.bank', 'create', {
        name: 'Amazon Pay',
        slug: 'amazon',
      })
    ).rejects.toThrow(/stored as "stores\/amazon"/);
  });

  it('sees through a stored type namespace with legacy casing', async () => {
    const { strapi } = harness({
      'api::store.store': [
        { documentId: 's1', name: 'Amazon', slug: 'Stores/amazon' },
      ],
    });

    await expect(
      validateIdentity(strapi, 'api::bank.bank', 'create', {
        name: 'Amazon Pay',
        slug: 'amazon',
      }),
    ).rejects.toThrow(/stored as "Stores\/amazon"/);
  });

  it('sees through a type namespace on the INCOMING slug', async () => {
    const { strapi } = harness({
      'api::store.store': [{ documentId: 's1', name: 'Amazon', slug: 'amazon' }],
    });

    await expect(
      validateIdentity(strapi, 'api::brand.brand', 'create', {
        name: 'Amazon Brand',
        slug: 'brands/amazon',
      })
    ).rejects.toThrow(/\/amazon\//);
  });

  it('uses an exact filter so a slug cannot wildcard onto another row', async () => {
    const { strapi, queries } = harness();

    await validateIdentity(strapi, 'api::store.store', 'create', {
      name: 'Percent',
      slug: '50-off',
    });

    for (const query of queries.filter((q) => q.filters?.$or)) {
      expect(Array.isArray(query.filters.$or)).toBe(true);
      for (const clause of query.filters.$or) {
        expect(typeof clause.slug.$eqi).toBe('string');
        expect(clause.slug.$containsi).toBeUndefined();
      }
    }
  });

  it('allows a slug nobody else routes at', async () => {
    const { strapi } = harness({
      'api::store.store': [{ documentId: 's1', name: 'Amazon', slug: 'amazon' }],
      'api::bank.bank': [{ documentId: 'b1', name: 'HDFC', slug: 'hdfc' }],
    });

    await expect(
      validateIdentity(strapi, 'api::category.category', 'create', {
        name: 'Fashion',
        slug: 'fashion',
      })
    ).resolves.toBeUndefined();
  });
});

describe('validateIdentity — clone uniqueness', () => {
  const source = {
    documentId: 's1',
    name: 'Amazon',
    slug: 'amazon',
  };

  it('merges an empty clone payload and keeps the source in duplicate checks', async () => {
    const { strapi, findOne } = harness(
      { 'api::store.store': [source] },
      source,
    );

    await expect(
      detailPaths(
        validateIdentity(strapi, 'api::store.store', 'clone', {}, 's1'),
      ),
    ).resolves.toEqual([['slug'], ['name']]);
    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 's1' }),
    );
  });

  it('changing only the clone name still rejects the inherited source slug', async () => {
    const { strapi } = harness(
      { 'api::store.store': [source] },
      source,
    );

    await expect(
      detailPaths(
        validateIdentity(
          strapi,
          'api::store.store',
          'clone',
          { name: 'Amazon India' },
          's1',
        ),
      ),
    ).resolves.toEqual([['slug']]);
  });

  it('changing only the clone slug still rejects the inherited source name', async () => {
    const { strapi } = harness(
      { 'api::store.store': [source] },
      source,
    );

    await expect(
      detailPaths(
        validateIdentity(
          strapi,
          'api::store.store',
          'clone',
          { slug: 'amazon-india' },
          's1',
        ),
      ),
    ).resolves.toEqual([['name']]);
  });

  it('accepts a clone when both identity fields are unique', async () => {
    const { strapi } = harness(
      { 'api::store.store': [source] },
      source,
    );

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'clone',
        { name: 'Amazon India', slug: 'amazon-india' },
        's1',
      ),
    ).resolves.toBeUndefined();
  });
});

describe('validateIdentity — active redirect ownership', () => {
  it('rejects a new entity whose route is already claimed by an active redirect', async () => {
    const { strapi } = harness({
      'api::redirect.redirect': [
        {
          documentId: 'r1',
          from: '/Amazon/',
          to: '/new-amazon/',
          active: true,
        },
      ],
    });

    await expect(
      validateIdentity(strapi, 'api::store.store', 'create', {
        name: 'Amazon',
        slug: 'amazon',
      }),
    ).rejects.toThrow(/already claimed by the active redirect/);
  });

  it('ignores inactive redirects', async () => {
    const { strapi } = harness({
      'api::redirect.redirect': [
        {
          documentId: 'r1',
          from: '/amazon',
          to: '/new-amazon/',
          active: false,
        },
      ],
    });

    await expect(
      validateIdentity(strapi, 'api::store.store', 'create', {
        name: 'Amazon',
        slug: 'amazon',
      }),
    ).resolves.toBeUndefined();
  });

  it('grandfathers an unchanged entity slug even if a redirect now claims it', async () => {
    const { strapi, findMany } = harness(
      {
        'api::redirect.redirect': [
          {
            documentId: 'r1',
            from: '/amazon',
            to: '/new-amazon/',
            active: true,
          },
        ],
      },
      { documentId: 's1', name: 'Amazon', slug: 'amazon' },
    );

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'update',
        { name: 'Amazon', slug: 'amazon', shortDescription: 'Edited' },
        's1',
      ),
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('validateIdentity — reserved frontend routes', () => {
  it.each([
    'search',
    'api',
    'stores',
    'brands',
    'categories',
    'banks',
    'about-us',
    'careers',
    'coupon',
    'deal',
    'redeem-unavailable',
    '404',
    '500',
  ])('rejects the reserved slug %j', async (slug) => {
    const { strapi } = harness();

    await expect(
      validateIdentity(strapi, 'api::store.store', 'create', { name: 'X', slug })
    ).rejects.toThrow(/is reserved by/);
  });

  it('rejects a slug whose FIRST segment is reserved', async () => {
    const { strapi } = harness();

    await expect(
      validateIdentity(strapi, 'api::store.store', 'create', {
        name: 'X',
        slug: 'careers/engineering',
      })
    ).rejects.toThrow(/is reserved by/);
  });

  it('does not reserve a slug that merely starts with the same letters', async () => {
    const { strapi } = harness();

    await expect(
      validateIdentity(strapi, 'api::store.store', 'create', {
        name: 'Search Guru',
        slug: 'search-guru',
      })
    ).resolves.toBeUndefined();
  });

  it('reports the reserved collision on the slug field', async () => {
    const { strapi } = harness();

    await expect(
      detailPaths(
        validateIdentity(strapi, 'api::store.store', 'create', {
          name: 'Search',
          slug: 'search',
        })
      )
    ).resolves.toEqual([['slug']]);
  });
});

describe('validateIdentity — non-Latin name yields no slug (row 102)', () => {
  it('confirms the shared slugifier really produces an empty slug', () => {
    expect(slugify('日本ストア')).toBe('');
  });

  it('rejects the save and explains it on the name field', async () => {
    const { strapi } = harness();

    const promise = validateIdentity(strapi, 'api::store.store', 'create', {
      name: '日本ストア',
      slug: '',
    });

    await expect(promise).rejects.toThrow(/no characters a URL slug can use/);
  });

  it('puts the error on name, not slug, and quotes the offending name', async () => {
    const { strapi } = harness();

    await expect(
      detailPaths(
        validateIdentity(strapi, 'api::store.store', 'create', {
          name: '日本ストア',
          slug: '',
        })
      )
    ).resolves.toEqual([['name']]);

    await expect(
      validateIdentity(strapi, 'api::store.store', 'create', {
        name: '日本ストア',
        slug: '',
      })
    ).rejects.toThrow(/日本ストア/);
  });

  it('rejects a non-Latin name even when the entity-page slug is typed by hand', async () => {
    const { strapi } = harness();

    await expect(
      detailPaths(
        validateIdentity(strapi, 'api::store.store', 'create', {
          name: '日本ストア',
          slug: 'nihon-store',
        })
      )
    ).resolves.toEqual([['name']]);
  });

  it('does not run the empty-slug rule when the slug is untouched', async () => {
    // A legacy row with a bad slug must not block an unrelated name edit.
    const { strapi } = harness(
      { 'api::store.store': [{ documentId: 's1', name: 'Old', slug: '' }] },
      { documentId: 's1', name: 'Old', slug: '' }
    );

    await expect(
      validateIdentity(strapi, 'api::store.store', 'update', { name: 'Old Renamed' }, 's1')
    ).resolves.toBeUndefined();
  });

  it('accepts a non-Latin localized display name without changing route identity', async () => {
    const { strapi, findMany } = harness(
      {},
      { documentId: 's1', name: 'Al-Futtaim Automall', slug: 'al-futtaim-automall' },
    );

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'update',
        { name: 'الفطيم أوتومول' },
        's1',
        false,
        'ar',
      ),
    ).resolves.toBeUndefined();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'ar' }),
    );
  });
});

describe('validateIdentity — STRICT (clean as you touch)', () => {
  it('blocks the save on a dirty UNTOUCHED name (duplicate) when strict', async () => {
    // s2 is a migrated row whose name duplicates s1. The editor touches only a
    // third field, so name is absent from the payload — under strict it is read
    // from the row and the whole record must be clean, so the save is blocked.
    const { strapi } = harness(
      {
        'api::store.store': [
          { documentId: 's1', name: 'Amazon', slug: 'amazon' },
          { documentId: 's2', name: 'amazon ', slug: 'amazon-in' },
        ],
      },
      { documentId: 's2', name: 'amazon ', slug: 'amazon-in' },
    );

    await expect(
      detailPaths(
        validateIdentity(
          strapi,
          'api::store.store',
          'update',
          { shortDescription: 'edited' },
          's2',
          true,
        ),
      ),
    ).resolves.toEqual([['name']]);
  });

  it('lets the SAME dirty untouched name re-save when strict is false (cron path)', async () => {
    const { strapi, findOne, findMany } = harness(
      {
        'api::store.store': [
          { documentId: 's1', name: 'Amazon', slug: 'amazon' },
          { documentId: 's2', name: 'amazon ', slug: 'amazon-in' },
        ],
      },
      { documentId: 's2', name: 'amazon ', slug: 'amazon-in' },
    );

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'update',
        { shortDescription: 'edited' },
        's2',
        false,
      ),
    ).resolves.toBeUndefined();
    // Non-strict partial write touching no identity field must cost nothing.
    expect(findOne).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('blocks on a dirty UNTOUCHED slug that collides cross-type when strict', async () => {
    // The bank's stored slug already collides with a store's slug (a real flat-
    // route break). Editor touches only ratingCount; strict re-checks the slug.
    const { strapi } = harness(
      {
        'api::store.store': [{ documentId: 's1', name: 'Amazon', slug: 'amazon' }],
        'api::bank.bank': [{ documentId: 'b1', name: 'Amazon Pay', slug: 'amazon' }],
      },
      { documentId: 'b1', name: 'Amazon Pay', slug: 'amazon' },
    );

    await expect(
      validateIdentity(
        strapi,
        'api::bank.bank',
        'update',
        { ratingCount: 12 },
        'b1',
        true,
      ),
    ).rejects.toThrow(/already used by the store "Amazon"/);
  });

  it('blocks on a dirty UNTOUCHED slug that is a reserved route when strict', async () => {
    const { strapi } = harness(
      {},
      { documentId: 's1', name: 'Search Guru', slug: 'search' },
    );

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'update',
        { shortDescription: 'edited' },
        's1',
        true,
      ),
    ).rejects.toThrow(/is reserved by/);
  });

  it('still saves a fully clean untouched record when strict', async () => {
    const { strapi } = harness(
      { 'api::store.store': [{ documentId: 's1', name: 'Amazon', slug: 'amazon' }] },
      { documentId: 's1', name: 'Amazon', slug: 'amazon' },
    );

    await expect(
      validateIdentity(
        strapi,
        'api::store.store',
        'update',
        { shortDescription: 'edited' },
        's1',
        true,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('validateIdentity — error shape', () => {
  it('reports every problem at once with string-array paths', async () => {
    const { strapi } = harness({
      'api::store.store': [{ documentId: 's1', name: 'Search', slug: 'other' }],
    });

    let caught: any;
    try {
      await validateIdentity(strapi, 'api::store.store', 'create', {
        name: 'search',
        slug: 'search',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught?.name).toBe('ValidationError');
    expect(caught?.details?.errors).toEqual([
      expect.objectContaining({ path: ['slug'], name: 'ValidationError' }),
      expect.objectContaining({ path: ['name'], name: 'ValidationError' }),
    ]);
    for (const entry of caught.details.errors) {
      expect(Array.isArray(entry.path)).toBe(true);
      expect(entry.path.every((p: unknown) => typeof p === 'string')).toBe(true);
    }
    expect(caught?.details?.problems).toHaveLength(2);
  });
});
