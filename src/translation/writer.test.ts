import { describe, expect, it, vi } from 'vitest';
import { inspectLocaleVersion } from './writer';

const STORE_UID = 'api::store.store';

function strapiWithTarget(target: any | null) {
  const schemas: Record<string, any> = {
    [STORE_UID]: {
      attributes: {
        name: {
          type: 'string',
          pluginOptions: { i18n: { localized: true } },
        },
        slug: { type: 'string' },
        related: {
          type: 'relation',
          target: STORE_UID,
          relation: 'manyToMany',
        },
      },
    },
  };
  const findOne = vi.fn(async () => target);
  return {
    getModel: vi.fn((uid: string) => schemas[uid]),
    plugin: vi.fn(() => ({
      service: vi.fn(() => () => ({
        populateDeep: vi.fn(() => ({ build: vi.fn(async () => ({})) })),
      })),
    })),
    documents: vi.fn(() => ({ findOne })),
    db: {
      query: vi.fn(() => ({
        findMany: vi.fn(async () => [{ documentId: 'related-1' }]),
      })),
    },
  } as any;
}

const source = {
  documentId: 'store-1',
  locale: 'en',
  name: 'English name',
  slug: 'store-one',
  related: [{ documentId: 'related-1' }],
};

describe('inspectLocaleVersion', () => {
  it('recognizes a fully current localized row without a document write', async () => {
    const strapi = strapiWithTarget({
      ...source,
      locale: 'ar',
      name: 'الاسم العربي',
    });

    await expect(
      inspectLocaleVersion(
        strapi,
        STORE_UID,
        'store-1',
        'ar',
        source,
        new Map([['name', 'الاسم العربي']]),
      ),
    ).resolves.toEqual({ current: true, skippedRelations: [] });
  });

  it('compares memory through the write mutators, so stored whitespace normalisation is current', async () => {
    // Provider output with a trailing space and a doubled space; the persisted
    // row went through normaliseTextFields (trim + collapse) on its write.
    // Comparing raw memory with the stored row made such rows "not current"
    // forever: rewritten and re-invalidated on every sweep.
    const strapi = strapiWithTarget({
      ...source,
      locale: 'ar',
      name: 'الاسم العربي',
    });

    await expect(
      inspectLocaleVersion(
        strapi,
        STORE_UID,
        'store-1',
        'ar',
        source,
        new Map([['name', ' الاسم  العربي ']]),
      ),
    ).resolves.toEqual({ current: true, skippedRelations: [] });
  });

  it('requires a write when the target row is absent', async () => {
    const strapi = strapiWithTarget(null);

    await expect(
      inspectLocaleVersion(
        strapi,
        STORE_UID,
        'store-1',
        'ar',
        source,
        new Map([['name', 'الاسم العربي']]),
      ),
    ).resolves.toMatchObject({ current: false });
  });

  it('requires a write when relations drift despite a current text hash', async () => {
    const strapi = strapiWithTarget({
      ...source,
      locale: 'ar',
      name: 'الاسم العربي',
      related: [],
    });

    await expect(
      inspectLocaleVersion(
        strapi,
        STORE_UID,
        'store-1',
        'ar',
        source,
        new Map([['name', 'الاسم العربي']]),
      ),
    ).resolves.toEqual({ current: false, skippedRelations: [] });
  });
});
