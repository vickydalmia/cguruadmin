import { describe, expect, it, vi } from 'vitest';
import type { Core } from '@strapi/strapi';
import {
  OG_IMAGE_MIN_HEIGHT,
  OG_IMAGE_MIN_WIDTH,
  warnUndersizedSeoOgImage,
} from './seo-og-image-validation';

type FileRow = { id: number; name: string; width: number | null; height: number | null };

const fakeStrapi = (files: FileRow[]) => {
  const warn = vi.fn();
  const strapi = {
    log: { debug: () => {}, info: () => {}, warn, error: () => {} },
    db: {
      query: (uid: string) => ({
        findMany: async ({ where }: any) =>
          uid === 'plugin::upload.file'
            ? files.filter((file) => where.id.$in.includes(file.id))
            : [],
      }),
    },
  } as unknown as Core.Strapi;
  return { strapi, warn };
};

describe('warnUndersizedSeoOgImage', () => {
  it('warns about an undersized ogImage but never throws', async () => {
    const { strapi, warn } = fakeStrapi([
      { id: 7, name: 'logo.png', width: 708, height: 152 },
    ]);
    const undersized = await warnUndersizedSeoOgImage(
      strapi,
      'api::store.store',
      'update',
      { seo: { ogImage: { id: 7 } } },
    );
    expect(undersized).toBe(1);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain(
      `${OG_IMAGE_MIN_WIDTH}×${OG_IMAGE_MIN_HEIGHT}`,
    );
  });

  it('accepts an image at or above 1200×630, in every media payload shape', async () => {
    const { strapi, warn } = fakeStrapi([
      { id: 9, name: 'banner.png', width: 1600, height: 840 },
    ]);
    for (const ogImage of [9, { id: 9 }, { set: [{ id: 9 }] }, [{ id: 9 }]]) {
      expect(
        await warnUndersizedSeoOgImage(strapi, 'api::store.store', 'update', {
          seo: { ogImage },
        }),
      ).toBe(0);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('checks the entity deal page component on taxonomy types only', async () => {
    const { strapi, warn } = fakeStrapi([
      { id: 3, name: 'small.png', width: 400, height: 400 },
    ]);
    expect(
      await warnUndersizedSeoOgImage(strapi, 'api::brand.brand', 'update', {
        entityDealPageSeo: { ogImage: 3 },
      }),
    ).toBe(1);
    expect(
      await warnUndersizedSeoOgImage(strapi, 'api::homepage.homepage', 'update', {
        entityDealPageSeo: { ogImage: 3 },
      }),
    ).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('ignores cleared images, untouched components, and non-write actions', async () => {
    const { strapi, warn } = fakeStrapi([]);
    expect(
      await warnUndersizedSeoOgImage(strapi, 'api::store.store', 'update', {
        seo: { ogImage: null },
      }),
    ).toBe(0);
    expect(
      await warnUndersizedSeoOgImage(strapi, 'api::store.store', 'update', {
        name: 'Amazon',
      }),
    ).toBe(0);
    expect(
      await warnUndersizedSeoOgImage(strapi, 'api::store.store', 'publish', {
        seo: { ogImage: 7 },
      }),
    ).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a file deleted mid-flight instead of failing', async () => {
    const { strapi, warn } = fakeStrapi([]);
    expect(
      await warnUndersizedSeoOgImage(strapi, 'api::store.store', 'update', {
        seo: { ogImage: 42 },
      }),
    ).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
