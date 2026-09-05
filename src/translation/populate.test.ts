import { describe, expect, it, vi } from 'vitest';
import { translationPopulate } from './populate';

describe('translationPopulate', () => {
  it('excludes inverse collections and keeps localized structure plus owner relations', () => {
    const schemas: Record<string, any> = {
      'api::store.store': {
        attributes: {
          name: { type: 'string', pluginOptions: { i18n: { localized: true } } },
          slug: { type: 'string' },
          logo: { type: 'media', multiple: false },
          coupons: {
            type: 'relation',
            relation: 'manyToMany',
            target: 'api::coupon.coupon',
            mappedBy: 'stores',
          },
          topPickCoupons: {
            type: 'relation',
            relation: 'manyToMany',
            target: 'api::coupon.coupon',
          },
          seo: {
            type: 'component',
            component: 'shared.seo',
            pluginOptions: { i18n: { localized: true } },
          },
        },
      },
      'shared.seo': {
        attributes: {
          metaTitle: { type: 'string' },
          shareImage: { type: 'media' },
          inverse: {
            type: 'relation',
            relation: 'oneToMany',
            target: 'api::coupon.coupon',
            mappedBy: 'seo',
          },
        },
      },
    };
    const strapi = { getModel: vi.fn((uid: string) => schemas[uid]) } as any;

    expect(translationPopulate(strapi, 'api::store.store')).toEqual({
      logo: true,
      topPickCoupons: true,
      seo: { populate: { shareImage: true } },
    });
    expect(strapi.getModel).toHaveBeenCalledTimes(2);
    expect(translationPopulate(strapi, 'api::store.store')).toBe(
      translationPopulate(strapi, 'api::store.store'),
    );
    expect(strapi.getModel).toHaveBeenCalledTimes(2);
  });

  it('builds dynamic-zone fragments without recursively populating relation targets', () => {
    const schemas: Record<string, any> = {
      'api::page.page': {
        attributes: {
          body: {
            type: 'dynamiczone',
            components: ['blocks.hero'],
            pluginOptions: { i18n: { localized: true } },
          },
        },
      },
      'blocks.hero': {
        attributes: {
          image: { type: 'media' },
          store: {
            type: 'relation',
            relation: 'manyToOne',
            target: 'api::store.store',
          },
        },
      },
    };
    const strapi = { getModel: vi.fn((uid: string) => schemas[uid]) } as any;

    expect(translationPopulate(strapi, 'api::page.page')).toEqual({
      body: {
        on: {
          'blocks.hero': { populate: { image: true, store: true } },
        },
      },
    });
  });
});
