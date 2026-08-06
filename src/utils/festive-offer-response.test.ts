import { describe, expect, it, vi } from 'vitest';

import { attachFestiveOffers } from './festive-offer-response';

const STORE = 'api::store.store';
const BRAND = 'api::brand.brand';

const FESTIVE_STORE = {
  documentId: 'flipkart1',
  festiveOfferTitle: 'Big Billion Days',
  festiveOfferDescription: '<p>Up to 80% off sitewide</p>',
};
const FESTIVE_BRAND = {
  documentId: 'nike1',
  festiveOfferTitle: 'Diwali Dhamaka',
  festiveOfferDescription: '<p>Flat 60% off</p>',
};

/**
 * A strapi double whose document service returns the rows each uid is seeded
 * with, after applying the `documentId.$in` + `isFestiveOffer` filter the real
 * query would. Records every call so the tests can assert the query COUNT —
 * the whole design goal is two queries regardless of offer count.
 */
const strapiWith = (rows: Record<string, any[]>) => {
  const calls: Array<{ uid: string; args: any }> = [];
  const warn = vi.fn();
  return {
    calls,
    warn,
    strapi: {
      log: { warn },
      documents: (uid: string) => ({
        findMany: async (args: any) => {
          calls.push({ uid, args });
          const wanted: string[] = args?.filters?.documentId?.$in ?? [];
          return (rows[uid] ?? []).filter((row) =>
            wanted.includes(row.documentId),
          );
        },
      }),
    } as any,
  };
};

const LIVE = {
  [STORE]: [FESTIVE_STORE],
  [BRAND]: [FESTIVE_BRAND],
};

describe('attachFestiveOffers', () => {
  it('attaches the merchant festive offer to a flat listing', async () => {
    const { strapi } = strapiWith(LIVE);
    const payload = [
      { title: 'Coupon A', checkoutMerchant: 'store:flipkart1' },
      { title: 'Coupon B', checkoutMerchant: 'brand:nike1' },
    ];

    await attachFestiveOffers(strapi, payload);

    expect(payload[0]).toEqual({
      title: 'Coupon A',
      festiveOffer: {
        title: 'Big Billion Days',
        descriptionHtml: '<p>Up to 80% off sitewide</p>',
      },
    });
    expect(payload[1]).toMatchObject({
      festiveOffer: { title: 'Diwali Dhamaka' },
    });
  });

  it('strips checkoutMerchant from the response either way', async () => {
    // The UI has no use for an opaque `store:<id>`; same tidy-up the sibling
    // walker does for `discountPrefix`.
    const { strapi } = strapiWith(LIVE);
    const payload = [
      { checkoutMerchant: 'store:flipkart1' },
      { checkoutMerchant: 'store:notfestive' },
      { checkoutMerchant: null },
    ];

    await attachFestiveOffers(strapi, payload);

    for (const node of payload) {
      expect(node).not.toHaveProperty('checkoutMerchant');
    }
    expect(payload[1]).not.toHaveProperty('festiveOffer');
    expect(payload[2]).not.toHaveProperty('festiveOffer');
  });

  it('walks a deeply nested homepage-shaped payload', async () => {
    const { strapi } = strapiWith(LIVE);
    const payload = {
      topOffers: {
        items: [{ coupon: { checkoutMerchant: 'store:flipkart1' } }],
      },
      exploreOffers: {
        tabs: [
          { offers: [{ checkoutMerchant: 'brand:nike1' }] },
          { offers: [{ checkoutMerchant: 'store:missing' }] },
        ],
      },
    };

    await attachFestiveOffers(strapi, payload);

    expect(payload.topOffers.items[0].coupon).toHaveProperty('festiveOffer');
    expect(payload.exploreOffers.tabs[0].offers[0]).toHaveProperty(
      'festiveOffer',
    );
    expect(payload.exploreOffers.tabs[1].offers[0]).not.toHaveProperty(
      'festiveOffer',
    );
  });

  it('issues at most two queries however many offers there are', async () => {
    // The point of the field is that one merchant edit restyles thousands of
    // offers — a per-offer lookup would be the wrong shape entirely.
    const { strapi, calls } = strapiWith(LIVE);
    const payload = Array.from({ length: 200 }, (_, index) => ({
      checkoutMerchant: index % 2 ? 'store:flipkart1' : 'brand:nike1',
    }));

    await attachFestiveOffers(strapi, payload);

    expect(calls).toHaveLength(2);
    expect(payload.every((node: any) => node.festiveOffer)).toBe(true);
  });

  it('queries only the kinds actually referenced', async () => {
    const { strapi, calls } = strapiWith(LIVE);
    await attachFestiveOffers(strapi, [{ checkoutMerchant: 'store:flipkart1' }]);
    expect(calls.map((call) => call.uid)).toEqual([STORE]);
  });

  it('de-duplicates merchant ids before querying', async () => {
    const { strapi, calls } = strapiWith(LIVE);
    await attachFestiveOffers(strapi, [
      { checkoutMerchant: 'store:flipkart1' },
      { checkoutMerchant: 'store:flipkart1' },
      { checkoutMerchant: 'store:flipkart1' },
    ]);
    expect(calls[0].args.filters.documentId.$in).toEqual(['flipkart1']);
  });

  it('raises the row limit past Strapi’s default of 25', async () => {
    // A campaign spanning more than 25 merchants would silently lose the rest.
    const { strapi, calls } = strapiWith(LIVE);
    const payload = Array.from({ length: 40 }, (_, index) => ({
      checkoutMerchant: `store:merchant${index}`,
    }));

    await attachFestiveOffers(strapi, payload);

    expect(calls[0].args.limit).toBe(40);
  });

  it('ignores a merchant whose title or description is blank', async () => {
    // The write pipeline requires both when the toggle is on; half a festive
    // offer renders worse than none.
    const { strapi } = strapiWith({
      [STORE]: [
        { documentId: 'noTitle', festiveOfferTitle: '  ', festiveOfferDescription: '<p>x</p>' },
        { documentId: 'noBody', festiveOfferTitle: 'Sale', festiveOfferDescription: null },
      ],
    });
    const payload = [
      { checkoutMerchant: 'store:noTitle' },
      { checkoutMerchant: 'store:noBody' },
    ];

    await attachFestiveOffers(strapi, payload);

    expect(payload[0]).not.toHaveProperty('festiveOffer');
    expect(payload[1]).not.toHaveProperty('festiveOffer');
  });

  it('filters on isFestiveOffer in the query itself', async () => {
    const { strapi, calls } = strapiWith(LIVE);
    await attachFestiveOffers(strapi, [{ checkoutMerchant: 'store:flipkart1' }]);
    expect(calls[0].args.filters.isFestiveOffer).toBe(true);
  });

  it('ignores a dangling or malformed reference', async () => {
    const { strapi } = strapiWith(LIVE);
    const payload = [
      { checkoutMerchant: 'store:deleted' },
      { checkoutMerchant: 'Flipkart' },
      { checkoutMerchant: 'bank:hdfc1' },
    ];

    await attachFestiveOffers(strapi, payload);

    for (const node of payload) expect(node).not.toHaveProperty('festiveOffer');
  });

  it('tolerates whitespace around a stored value', async () => {
    const { strapi } = strapiWith(LIVE);
    const payload = [{ checkoutMerchant: '  store:flipkart1  ' }];
    await attachFestiveOffers(strapi, payload);
    expect(payload[0]).toHaveProperty('festiveOffer');
  });

  it('does not query at all when the payload holds no offers', async () => {
    const { strapi, calls } = strapiWith(LIVE);
    await attachFestiveOffers(strapi, { menu: { links: [{ label: 'Stores' }] } });
    expect(calls).toHaveLength(0);
  });

  it('renders offers unstyled rather than failing the page when the lookup throws', async () => {
    // A missing campaign is a far better outcome than a 500 on the homepage.
    const warn = vi.fn();
    const strapi = {
      log: { warn },
      documents: () => ({
        findMany: async () => {
          throw new Error('connection reset');
        },
      }),
    } as any;
    const payload = [{ title: 'Coupon A', checkoutMerchant: 'store:flipkart1' }];

    await expect(attachFestiveOffers(strapi, payload)).resolves.toBeUndefined();

    expect(payload[0]).toEqual({ title: 'Coupon A' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[festive-offer]'));
  });

  it('ignores null and non-object payloads', async () => {
    const { strapi } = strapiWith(LIVE);
    await expect(attachFestiveOffers(strapi, null)).resolves.toBeUndefined();
    await expect(attachFestiveOffers(strapi, 'nope')).resolves.toBeUndefined();
  });
});
