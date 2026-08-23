import { describe, expect, it, vi } from 'vitest';

import {
  buildColumns,
  buildPopulate,
  csvCell,
  csvHeader,
  csvRow,
  exportPage,
  flattenEntry,
  relationDisplayField,
  resolveAdminEmails,
  resolveMerchantNames,
} from './csv-export';

/**
 * A schema the way Strapi hands it back from `strapi.getModel`: the
 * declared attributes plus the implicit audit attributes the loader appends.
 */
const MODELS: Record<string, any> = {
  'api::coupon.coupon': {
    uid: 'api::coupon.coupon',
    attributes: {
      title: { type: 'string' },
      content: { type: 'richtext' },
      couponType: { type: 'enumeration', enum: ['static', 'unique'] },
      checkoutMerchant: { type: 'customField', customField: 'global::checkout-merchant' },
      expiresAt: { type: 'datetime' },
      isForAffiliateBrand: { type: 'boolean' },
      workedCount: { type: 'integer' },
      meta: { type: 'json' },
      secret: { type: 'password' },
      uniqueCouponPool: {
        type: 'relation',
        relation: 'manyToOne',
        target: 'api::unique-coupon-pool.unique-coupon-pool',
      },
      stores: { type: 'relation', relation: 'manyToMany', target: 'api::store.store' },
      createdAt: { type: 'datetime' },
      updatedAt: { type: 'datetime' },
      publishedAt: { type: 'datetime' },
      createdBy: { type: 'relation', relation: 'oneToOne', target: 'admin::user' },
      updatedBy: { type: 'relation', relation: 'oneToOne', target: 'admin::user' },
      localizations: { type: 'relation', relation: 'oneToMany', target: 'api::coupon.coupon' },
    },
  },
  'api::store.store': {
    uid: 'api::store.store',
    attributes: {
      name: { type: 'string' },
      logo: { type: 'media', multiple: false },
      faqs: { type: 'component', component: 'shared.faq-item', repeatable: true },
      seo: { type: 'component', component: 'shared.seo', repeatable: false },
      orderedCoupons: { type: 'relation', relation: 'manyToMany', target: 'api::coupon.coupon' },
      createdAt: { type: 'datetime' },
      updatedAt: { type: 'datetime' },
    },
  },
  'shared.faq-item': {
    uid: 'shared.faq-item',
    attributes: { question: { type: 'string' }, answer: { type: 'text' } },
  },
  'shared.seo': {
    uid: 'shared.seo',
    attributes: {
      metaTitle: { type: 'string' },
      noIndex: { type: 'boolean' },
      ogImage: { type: 'media', multiple: false },
    },
  },
};

const getModel = (uid: string) => MODELS[uid];

describe('relationDisplayField', () => {
  it('shows offers by title, admin users by email and everything else by name', () => {
    expect(relationDisplayField('api::coupon.coupon')).toBe('title');
    expect(relationDisplayField('api::deal.deal')).toBe('title');
    expect(relationDisplayField('admin::user')).toBe('email');
    expect(relationDisplayField('api::store.store')).toBe('name');
    expect(relationDisplayField('api::unique-coupon-pool.unique-coupon-pool')).toBe('name');
  });
});

describe('buildColumns', () => {
  it('derives a stable header from the schema: ids, attributes in order, then the audit trail', () => {
    const headers = buildColumns('api::coupon.coupon', getModel).map((c) => c.header);
    expect(headers).toEqual([
      'id',
      'documentId',
      'title',
      'content',
      'couponType',
      'checkoutMerchant',
      'expiresAt',
      'isForAffiliateBrand',
      'workedCount',
      'meta',
      'uniqueCouponPool',
      'stores',
      'createdAt',
      'updatedAt',
      'publishedAt',
      'createdBy',
      'updatedBy',
    ]);
  });

  it('never exports passwords or the localizations self-relation', () => {
    const headers = buildColumns('api::coupon.coupon', getModel).map((c) => c.header);
    expect(headers).not.toContain('secret');
    expect(headers.some((h) => h.startsWith('localizations'))).toBe(false);
  });

  it('flattens single components, expands media, and keeps repeatable components as one JSON cell', () => {
    const headers = buildColumns('api::store.store', getModel).map((c) => c.header);
    expect(headers).toEqual([
      'id',
      'documentId',
      'name',
      'logo.url',
      'logo.name',
      'logo.alternativeText',
      'faqs',
      'seo.metaTitle',
      'seo.noIndex',
      'seo.ogImage.url',
      'seo.ogImage.name',
      'seo.ogImage.alternativeText',
      'orderedCoupons',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('throws for an unknown model instead of exporting an empty header', () => {
    expect(() => buildColumns('api::nope.nope', getModel)).toThrow(/unknown model/);
  });
});

describe('buildPopulate', () => {
  it('selects only display fields on relations and file fields on media, recursing into components', () => {
    expect(buildPopulate('api::store.store', getModel)).toEqual({
      logo: { fields: ['url', 'name', 'alternativeText'] },
      // Nothing inside faq-item to populate, so the component itself is
      // `true` — `{ populate: true }` is an invalid nested populate in Strapi.
      faqs: true,
      seo: { populate: { ogImage: { fields: ['url', 'name', 'alternativeText'] } } },
      orderedCoupons: { fields: ['title', 'documentId'] },
    });
  });

  it('populates audit users by name and email and skips localizations', () => {
    const populate = buildPopulate('api::coupon.coupon', getModel) as Record<string, any>;
    // admin::user.email is private and the document service rejects it in a
    // nested `fields` ("Invalid key email"); emails come from resolveAdminEmails.
    expect(populate.createdBy).toEqual({ fields: ['firstname', 'lastname', 'username'] });
    expect(populate.stores).toEqual({ fields: ['name', 'documentId'] });
    expect(populate.uniqueCouponPool).toEqual({ fields: ['name', 'documentId'] });
    expect(populate).not.toHaveProperty('localizations');
    expect(populate).not.toHaveProperty('title');
  });

  it('returns true for a schema with nothing to populate', () => {
    expect(buildPopulate('shared.faq-item', getModel)).toBe(true);
  });
});

describe('flattenEntry', () => {
  const columns = buildColumns('api::coupon.coupon', getModel);
  const cell = (row: string[], header: string) =>
    row[columns.findIndex((c) => c.header === header)];

  it('renders every kind of value as text, empty for null', () => {
    const row = flattenEntry(columns, {
      id: 7,
      documentId: 'abc',
      title: 'Flat 50% off',
      content: null,
      couponType: 'static',
      checkoutMerchant: 'store:s1',
      expiresAt: '2026-09-01T00:00:00.000Z',
      isForAffiliateBrand: false,
      workedCount: 0,
      meta: { a: [1, 2] },
      uniqueCouponPool: null,
      stores: [
        { documentId: 's1', name: 'Amazon' },
        { documentId: 's2', name: 'Flipkart' },
      ],
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
      createdBy: { id: 1, firstname: 'Vicky', lastname: 'Kumar' },
      updatedBy: { id: 2, username: 'ops' },
    }, {
      merchantNames: new Map([['store:s1', 'Amazon']]),
      adminEmails: new Map([[1, 'v@example.com'], [2, 'ops@example.com']]),
    });

    expect(cell(row, 'id')).toBe('7');
    expect(cell(row, 'title')).toBe('Flat 50% off');
    expect(cell(row, 'content')).toBe('');
    expect(cell(row, 'checkoutMerchant')).toBe('Amazon (store)');
    expect(cell(row, 'isForAffiliateBrand')).toBe('false');
    expect(cell(row, 'workedCount')).toBe('0');
    expect(cell(row, 'meta')).toBe('{"a":[1,2]}');
    expect(cell(row, 'uniqueCouponPool')).toBe('');
    expect(cell(row, 'stores')).toBe('Amazon | Flipkart');
    expect(cell(row, 'createdAt')).toBe('2026-08-01T10:00:00.000Z');
    expect(cell(row, 'createdBy')).toBe('Vicky Kumar <v@example.com>');
    expect(cell(row, 'updatedBy')).toBe('ops@example.com');
    expect(cell(row, 'publishedAt')).toBe('');
  });

  it('falls back to name, then username, when an admin email is unknown', () => {
    const row = flattenEntry(columns, {
      createdBy: { id: 9, firstname: 'Solo' },
      updatedBy: { id: 10, username: 'legacy-bot' },
    });
    expect(cell(row, 'createdBy')).toBe('Solo');
    expect(cell(row, 'updatedBy')).toBe('legacy-bot');
  });

  it('keeps the raw merchant reference when it cannot be resolved', () => {
    const row = flattenEntry(columns, { checkoutMerchant: 'brand:gone' }, {
      merchantNames: new Map(),
    });
    expect(cell(row, 'checkoutMerchant')).toBe('brand:gone');
    expect(cell(flattenEntry(columns, { checkoutMerchant: null }), 'checkoutMerchant')).toBe('');
  });

  it('never emits documentId columns for relations — editors read names, not ids', () => {
    expect(columns.some((c) => c.header.endsWith('.documentId'))).toBe(false);
  });

  it('reads component paths, media fields and ordered relations in join order', () => {
    const storeColumns = buildColumns('api::store.store', getModel);
    const pick = (row: string[], header: string) =>
      row[storeColumns.findIndex((c) => c.header === header)];
    const row = flattenEntry(storeColumns, {
      name: 'Amazon',
      logo: { url: 'https://cdn/x.png', name: 'x.png', alternativeText: 'Amazon logo' },
      faqs: [{ id: 1, question: 'Q?', answer: 'A.' }],
      seo: { metaTitle: 'Amazon coupons', noIndex: true, ogImage: null },
      orderedCoupons: [{ documentId: 'c9', title: 'Second' }, { documentId: 'c1', title: 'First' }],
    });
    expect(pick(row, 'logo.url')).toBe('https://cdn/x.png');
    expect(pick(row, 'logo.alternativeText')).toBe('Amazon logo');
    expect(pick(row, 'faqs')).toBe('[{"id":1,"question":"Q?","answer":"A."}]');
    expect(pick(row, 'seo.metaTitle')).toBe('Amazon coupons');
    expect(pick(row, 'seo.noIndex')).toBe('true');
    expect(pick(row, 'seo.ogImage.url')).toBe('');
    expect(pick(row, 'orderedCoupons')).toBe('Second | First');
  });
});

describe('CSV encoding', () => {
  it('quotes commas, quotes and line breaks per RFC 4180 and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"');
  });

  it('neutralises spreadsheet formulas but leaves plain numbers alone', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+91 98')).toBe("'+91 98");
    expect(csvCell('@mention')).toBe("'@mention");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('-5.25')).toBe('-5.25');
    expect(csvCell('+7')).toBe('+7');
    expect(csvCell('- not a number')).toBe("'- not a number");
  });

  it('terminates rows with CRLF and writes the header from column names', () => {
    expect(csvRow(['a', 'b,c'])).toBe('a,"b,c"\r\n');
    const columns = buildColumns('shared.faq-item', getModel);
    expect(csvHeader(columns)).toBe('id,documentId,question,answer\r\n');
  });
});

function strapiDouble(rows: any[], total: number) {
  const findMany = vi.fn(async () => rows);
  const count = vi.fn(async () => total);
  const merchantFindMany = vi.fn(async ({ filters }: any) =>
    (filters?.documentId?.$in ?? []).map((documentId: string) => ({
      documentId,
      name: `Merchant ${documentId}`,
    })),
  );
  const adminFindMany = vi.fn(async ({ where }: any) =>
    (where?.id?.$in ?? []).map((id: number) => ({ id, email: `user${id}@example.com` })),
  );
  const strapi = {
    getModel,
    documents: vi.fn((uid: string) =>
      uid === 'api::coupon.coupon'
        ? { findMany, count }
        : { findMany: merchantFindMany },
    ),
    db: { query: vi.fn(() => ({ findMany: adminFindMany })) },
  } as any;
  return { strapi, findMany, count, merchantFindMany, adminFindMany };
}

describe('resolveAdminEmails', () => {
  it('looks up every referenced admin id once through the Query Engine', async () => {
    const { strapi, adminFindMany } = strapiDouble([], 0);
    const columns = buildColumns('api::coupon.coupon', getModel);
    const emails = await resolveAdminEmails(strapi, columns, [
      { createdBy: { id: 1 }, updatedBy: { id: 2 } },
      { createdBy: { id: 2 }, updatedBy: null },
    ]);
    expect(strapi.db.query).toHaveBeenCalledWith('admin::user');
    expect(adminFindMany).toHaveBeenCalledTimes(1);
    expect(adminFindMany).toHaveBeenCalledWith({
      where: { id: { $in: [1, 2] } },
      select: ['id', 'email'],
    });
    expect(emails.get(1)).toBe('user1@example.com');
    expect(emails.get(2)).toBe('user2@example.com');
  });

  it('skips the query when no row carries an audit user', async () => {
    const { strapi, adminFindMany } = strapiDouble([], 0);
    const columns = buildColumns('api::coupon.coupon', getModel);
    await resolveAdminEmails(strapi, columns, [{ createdBy: null }]);
    expect(adminFindMany).not.toHaveBeenCalled();
  });
});

describe('resolveMerchantNames', () => {
  it('looks each kind up once and keys the result by the stored reference', async () => {
    const { strapi, merchantFindMany } = strapiDouble([], 0);
    const names = await resolveMerchantNames(strapi, [
      { checkoutMerchant: 'store:s1' },
      { checkoutMerchant: 'store:s1' },
      { checkoutMerchant: 'brand:b2' },
      { checkoutMerchant: 'garbage' },
      {},
    ]);
    expect(merchantFindMany).toHaveBeenCalledTimes(2);
    expect(names.get('store:s1')).toBe('Merchant s1');
    expect(names.get('brand:b2')).toBe('Merchant b2');
    expect(names.has('garbage')).toBe(false);
  });

  it('issues no query when nothing references a merchant', async () => {
    const { strapi, merchantFindMany } = strapiDouble([], 0);
    await resolveMerchantNames(strapi, [{ checkoutMerchant: null }]);
    expect(merchantFindMany).not.toHaveBeenCalled();
  });
});

describe('exportPage', () => {
  it('reads one id-ordered page with the derived populate and returns header + lines', async () => {
    const { strapi, findMany, count } = strapiDouble(
      [
        {
          id: 1,
          documentId: 'a',
          title: 'One',
          checkoutMerchant: 'store:s1',
          stores: [],
          createdBy: { id: 4, firstname: 'Vicky', lastname: 'Kumar' },
        },
        { id: 2, documentId: 'b', title: 'Two, with comma', stores: [{ documentId: 's1', name: 'Amazon' }] },
      ],
      501,
    );

    const page = await exportPage(strapi, { uid: 'api::coupon.coupon', page: 3, pageSize: 250 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        start: 500,
        limit: 250,
        sort: 'id:asc',
        populate: expect.objectContaining({ stores: { fields: ['name', 'documentId'] } }),
      }),
    );
    expect(count).toHaveBeenCalledTimes(1);
    expect(page).toMatchObject({
      uid: 'api::coupon.coupon',
      page: 3,
      pageSize: 250,
      total: 501,
      pageCount: 3,
      rowCount: 2,
    });
    expect(page.header.startsWith('id,documentId,title,')).toBe(true);
    expect(page.header.endsWith('\r\n')).toBe(true);
    const lines = page.lines.split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('1,a,One,')).toBe(true);
    expect(lines[0]).toContain(',Merchant s1 (store),');
    expect(lines[0]).toContain('Vicky Kumar <user4@example.com>');
    expect(lines[1].startsWith('2,b,"Two, with comma",')).toBe(true);
    expect(lines[1]).toContain(',Amazon,');
  });

  it('reports one page for an empty collection', async () => {
    const { strapi } = strapiDouble([], 0);
    const page = await exportPage(strapi, { uid: 'api::coupon.coupon', page: 1, pageSize: 100 });
    expect(page).toMatchObject({ total: 0, pageCount: 1, rowCount: 0, lines: '' });
  });
});
