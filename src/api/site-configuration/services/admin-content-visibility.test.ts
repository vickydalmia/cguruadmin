import { describe, expect, it, vi } from 'vitest';

import { INDIA_DEFAULT_CONFIGURATION } from './country-registry';
import {
  filterContentManagerInitBody,
  hiddenAdminContentTypeUids,
} from './admin-content-visibility';

describe('country-aware Content Manager visibility', () => {
  it('hides disabled feature types and their supporting editor collections', () => {
    const hidden = hiddenAdminContentTypeUids(
      {
        ...INDIA_DEFAULT_CONFIGURATION,
        couponsEnabled: false,
        careersEnabled: false,
        privacyPolicyEnabled: false,
      },
      { dealTemplate: true, independenceDayTemplate: true },
    );

    expect([...hidden]).toEqual(expect.arrayContaining([
      'api::coupon.coupon',
      'api::unique-code.unique-code',
      'api::unique-coupon-pool.unique-coupon-pool',
      'api::career-page.career-page',
      'api::job.job',
      'api::privacy-policy-page.privacy-policy-page',
    ]));
    expect(hidden.has('api::homepage.homepage')).toBe(false);
    expect(hidden.has('api::store.store')).toBe(false);
  });

  it('derives campaign singleton visibility from template ownership', () => {
    const hidden = hiddenAdminContentTypeUids(
      INDIA_DEFAULT_CONFIGURATION,
      { dealTemplate: false, independenceDayTemplate: true },
    );

    expect(hidden.has('api::deal-of-the-day-page.deal-of-the-day-page')).toBe(true);
    expect(
      hidden.has(
        'api::independence-day-sale-page.independence-day-sale-page',
      ),
    ).toBe(false);
  });

  it('shows an enabled feature in Content Manager even while its content is incomplete', () => {
    const hidden = hiddenAdminContentTypeUids(
      {
        ...INDIA_DEFAULT_CONFIGURATION,
        countryCode: 'US',
        aboutEnabled: true,
      },
      { dealTemplate: true, independenceDayTemplate: true },
    );

    expect(hidden.has('api::about-page.about-page')).toBe(false);
  });

  it('hides links without removing the registered content schemas', async () => {
    const findFirst = vi.fn(async () => null);
    const findMany = vi.fn(async ({ filters }: any) =>
      filters?.pageTemplate === 'dealTemplate'
        ? [{ documentId: 'owner-1', slug: 'daily-specials' }]
        : [],
    );
    const strapi = {
      documents: vi.fn(() => ({ findFirst, findMany })),
    } as any;
    const body = {
      data: {
        fieldSizes: { string: 6 },
        contentTypes: [
          { uid: 'api::store.store' },
          { uid: 'api::deal-of-the-day-page.deal-of-the-day-page' },
          {
            uid: 'api::independence-day-sale-page.independence-day-sale-page',
          },
        ],
      },
    };

    const filtered = await filterContentManagerInitBody(strapi, body);

    expect(filtered.data.fieldSizes).toEqual(body.data.fieldSizes);
    expect(filtered.data.contentTypes).toEqual([
      { uid: 'api::store.store' },
      { uid: 'api::deal-of-the-day-page.deal-of-the-day-page' },
      {
        uid: 'api::independence-day-sale-page.independence-day-sale-page',
        isDisplayed: false,
      },
    ]);
    expect(body.data.contentTypes).toHaveLength(3);
  });
});
