import { describe, expect, it, vi } from 'vitest';

import { HOMEPAGE_IMAGE_RULES } from '../constants/homepage-images';
import { validateHomepageImages } from './homepage-image-validation';

function harness({
  current = {},
  files = [],
}: {
  current?: any;
  files?: any[];
} = {}) {
  const findOne = vi.fn().mockResolvedValue(current);
  const findMany = vi.fn().mockImplementation(async ({ where }: any) => {
    const ids = new Set(where.id.$in);
    return files.filter((file) => ids.has(file.id));
  });
  const query = vi.fn((uid: string) => {
    if (uid === 'api::homepage.homepage') return { findOne };
    if (uid === 'plugin::upload.file') return { findMany };
    throw new Error(`Unexpected query uid: ${uid}`);
  });

  return {
    strapi: { db: { query } } as any,
    findOne,
    findMany,
  };
}

describe('homepage image validation', () => {
  it('pins the hero slot to the new Figma image dimensions', () => {
    const heroRule = HOMEPAGE_IMAGE_RULES.find(
      (rule) => rule.path === 'hero.banners[].desktopImage'
    );

    expect(heroRule).toMatchObject({
      width: 1882,
      height: 781,
      display: [941, 390.5],
      required: true,
      validateExisting: true,
    });
  });

  it('accepts a 1882×781 hero image even when it is already attached', async () => {
    const file = {
      id: 11,
      name: 'new-hero.webp',
      width: 1882,
      height: 781,
    };
    const { strapi, findMany } = harness({
      current: { hero: { banners: [{ desktopImage: file }] } },
      files: [file],
    });

    await expect(
      validateHomepageImages(strapi, {
        hero: { banners: [{ desktopImage: file.id }] },
      })
    ).resolves.toBeUndefined();
    expect(findMany).toHaveBeenCalledOnce();
  });

  it('rejects an attached legacy hero image on the next homepage save', async () => {
    const file = {
      id: 12,
      name: 'legacy-hero.webp',
      width: 1664,
      height: 720,
    };
    const { strapi } = harness({
      current: { hero: { banners: [{ desktopImage: file }] } },
      files: [file],
    });

    const error = await validateHomepageImages(strapi, {
      hero: { banners: [{ desktopImage: file.id }] },
    }).catch((value) => value);

    expect(error.message).toContain('1882×781');
    expect(error.details.errors).toEqual([
      expect.objectContaining({
        path: ['hero', 'banners', 0, 'desktopImage'],
        message: expect.stringContaining(
          '"legacy-hero.webp" is 1664×720 px'
        ),
      }),
    ]);
  });

  it('still grandfathers unchanged legacy art in other homepage slots', async () => {
    const file = {
      id: 13,
      name: 'legacy-top-offer.webp',
      width: 400,
      height: 200,
    };
    const { strapi, findMany } = harness({
      current: { topOffers: { items: [{ banner: file }] } },
      files: [file],
    });

    await expect(
      validateHomepageImages(strapi, {
        topOffers: { items: [{ banner: file.id }] },
      })
    ).resolves.toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('reports a missing required hero image on the exact repeatable-row field', async () => {
    const { strapi, findOne } = harness();
    const error = await validateHomepageImages(strapi, {
      hero: { banners: [{ desktopImage: null }] },
    }).catch((value) => value);

    expect(error.details.errors[0]).toMatchObject({
      path: ['hero', 'banners', 0, 'desktopImage'],
      message: 'Hero slide desktop image is required (1882×781 px).',
    });
    expect(findOne).not.toHaveBeenCalled();
  });
});
