import { describe, expect, it, vi } from 'vitest';
import { TEXT_FIELD_RULES } from './text-field-rules';
import {
  isBlankMedia,
  isBlankText,
  normaliseTextFields,
  requiresStoredRead,
  validateTextFields,
  validateTextFieldsForWrite,
} from './text-field-validation';

const COUPON = 'api::coupon.coupon';
const DEAL = 'api::deal.deal';
const STORE = 'api::store.store';
const BRAND = 'api::brand.brand';
const CATEGORY = 'api::category.category';
const BANK = 'api::bank.bank';

/** A payload that satisfies every requiredNonBlank coupon rule. */
const validCoupon = () => ({
  title: 'Flat 40% off',
  content: '<p>Terms apply.</p>',
  offerText: 'Flat 40% off',
  affiliateLink: 'https://example.com/go',
  stores: [{ documentId: 'store-1' }],
});

/**
 * A payload that satisfies every requiredNonBlank store rule. Shared by the
 * clone-merge cases so adding a store rule updates one fixture, not four
 * near-identical inline objects.
 */
const validStore = () => ({
  name: 'Amazon',
  shortDescription: 'Shop Amazon offers.',
  logo: { documentId: 'logo-1' },
  logoAlt: 'Amazon logo',
  websiteUrl: 'https://www.amazon.in',
  seo: {
    metaTitle: 'Amazon Coupons',
    metaDescription: 'Latest Amazon coupons.',
  },
});

const problemPaths = (fn: () => void): string[][] => {
  try {
    fn();
  } catch (err: any) {
    return err.details?.errors?.map((e: any) => e.path) ?? [];
  }
  throw new Error('expected to throw');
};

describe('rule table integrity', () => {
  it('never enables collapse on text or richtext fields', () => {
    // Collapsing a multi-paragraph description would destroy paragraph breaks
    // and show up as a live-site content regression.
    for (const rule of TEXT_FIELD_RULES) {
      if (rule.collapse) expect(rule.kind).toBe('string');
    }
  });

  it('covers both offer types and all four taxonomy types', () => {
    const uids = new Set(TEXT_FIELD_RULES.map((r) => r.uid));
    expect([...uids].sort()).toEqual(
      [BRAND, COUPON, DEAL, STORE, CATEGORY, BANK].sort()
    );
  });

  it('does not touch uid/slug fields', () => {
    expect(TEXT_FIELD_RULES.some((r) => r.field === 'slug')).toBe(false);
  });
});

describe('blank helpers', () => {
  it('treats absent, null, empty and whitespace-only strings as blank', () => {
    for (const value of [undefined, null, '', '   ', '\t\n ']) {
      expect(isBlankText(value)).toBe(true);
    }
    expect(isBlankText('a')).toBe(false);
    expect(isBlankText(0)).toBe(false);
  });

  it('treats cleared media widget shapes as blank', () => {
    for (const value of [undefined, null, [], { set: [] }, { connect: [] }]) {
      expect(isBlankMedia(value)).toBe(true);
    }
    expect(isBlankMedia(7)).toBe(false);
    expect(isBlankMedia({ set: [{ id: 3 }] })).toBe(false);
    expect(isBlankMedia([{ id: 3 }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('normaliseTextFields', () => {
  it('trims leading and trailing whitespace on string fields', () => {
    const data: any = { title: '  Flat 40% off  ' };
    normaliseTextFields(COUPON, 'update', data);
    expect(data.title).toBe('Flat 40% off');
  });

  it('collapses internal whitespace on `string` fields', () => {
    const data: any = { offerText: 'Flat   40%    off' };
    normaliseTextFields(COUPON, 'update', data);
    expect(data.offerText).toBe('Flat 40% off');
  });

  it('does NOT collapse internal whitespace on `text` fields', () => {
    // store.shortDescription is a textarea; paragraph breaks are content.
    const multiline = 'First paragraph.\n\nSecond paragraph.';
    const data: any = { shortDescription: `  ${multiline}  ` };
    normaliseTextFields(STORE, 'update', data);
    expect(data.shortDescription).toBe(multiline);
    expect(data.shortDescription).toContain('\n\n');
  });

  it('does NOT touch `richtext` fields at all', () => {
    // sanitizeRichtextData already trims these; collapsing HTML would be a
    // visible content regression on the live site.
    const html = '<p>One</p>\n\n<p>Two</p>';
    const data: any = { content: html };
    normaliseTextFields(COUPON, 'update', data);
    expect(data.content).toBe(html);
  });

  it('preserves newlines in a multi-paragraph brand shortDescription', () => {
    const body = 'Line one.\n\n  Line two indented.\nLine three.';
    const data: any = { shortDescription: body };
    normaliseTextFields(BRAND, 'update', data);
    expect(data.shortDescription).toBe(body);
  });

  it('maps a whitespace-only value to null rather than ""', () => {
    const data: any = { logoAlt: '   ' };
    normaliseTextFields(STORE, 'update', data);
    expect(data.logoAlt).toBeNull();
  });

  it('normalises inside the seo component', () => {
    const data: any = { seo: { metaTitle: '  Best   Deals  ' } };
    normaliseTextFields(STORE, 'update', data);
    expect(data.seo.metaTitle).toBe('Best Deals');
  });

  it('leaves absent fields absent (no key is invented)', () => {
    const data: any = { contentStatus: 'expired' };
    normaliseTextFields(COUPON, 'update', data);
    expect(Object.keys(data)).toEqual(['contentStatus']);
  });

  it('does not collapse a coupon code with an internal space', () => {
    const data: any = { code: '  SAVE 40  ' };
    normaliseTextFields(COUPON, 'update', data);
    expect(data.code).toBe('SAVE 40');
  });

  it('is idempotent', () => {
    const once: any = { title: '  Flat   40%  ' };
    normaliseTextFields(COUPON, 'update', once);
    const twice = { ...once };
    normaliseTextFields(COUPON, 'update', twice);
    expect(twice).toEqual(once);
  });

  it('ignores non-write actions and null data', () => {
    const data: any = { title: '  x  ' };
    normaliseTextFields(COUPON, 'findOne', data);
    expect(data.title).toBe('  x  ');
    expect(() => normaliseTextFields(COUPON, 'update', null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('validateTextFields — grandfathering', () => {
  it('skips an untouched required field on update even when stored is invalid', () => {
    // The legacy row has no content and no affiliateLink; the editor is only
    // fixing the title. Blocking that save would be worse than the bug.
    expect(() =>
      validateTextFields(COUPON, 'update', { title: 'New title' }, {
        content: null,
        affiliateLink: '',
      })
    ).not.toThrow();
  });

  it('lets the contentStatus cron tick over a legacy row untouched', () => {
    expect(() =>
      validateTextFields(COUPON, 'update', { contentStatus: 'expired' }, {
        title: '',
        content: null,
        affiliateLink: null,
        stores: [],
        banks: [],
        categories: [],
        brands: [],
      })
    ).not.toThrow();
  });

  it('lets the admin re-send unchanged legacy blank fields in a full form', () => {
    const fullForm = {
      title: 'Legacy coupon',
      content: null,
      affiliateLink: null,
      stores: [],
      banks: [],
      categories: [],
      brands: [],
    };
    expect(() =>
      validateTextFields(COUPON, 'update', fullForm, { ...fullForm })
    ).not.toThrow();
  });

  it('DOES reject when the payload blanks the field itself', () => {
    expect(problemPaths(() =>
      validateTextFields(COUPON, 'update', { affiliateLink: '' })
    )).toEqual([['affiliateLink']]);
  });

  it('rejects a whitespace-only value once normalisation has run', () => {
    const data: any = { affiliateLink: '   ' };
    normaliseTextFields(COUPON, 'update', data);
    expect(() => validateTextFields(COUPON, 'update', data)).toThrow(
      /Affiliate link is required/
    );
  });

  it('validates creates in full', () => {
    const paths = problemPaths(() => validateTextFields(COUPON, 'create', {}));
    expect(paths).toEqual([
      ['title'],
      ['content'],
      ['affiliateLink'],
      ['offerText'],
      ['stores'],
    ]);
  });

  it('accepts a complete create', () => {
    expect(() =>
      validateTextFields(COUPON, 'create', validCoupon())
    ).not.toThrow();
  });

  // Category and bank used to be the example here; both now carry rules, so
  // this needs a type the table genuinely does not cover.
  it('is a no-op for unrelated content types', () => {
    expect(() =>
      validateTextFields('api::redirect.redirect', 'create', {})
    ).not.toThrow();
  });
});

describe('validateTextFields — required fields', () => {
  it('requires coupon content (row 46)', () => {
    expect(problemPaths(() =>
      validateTextFields(COUPON, 'update', { content: null })
    )).toEqual([['content']]);
  });

  it('requires deal affiliateLink (row 82)', () => {
    expect(problemPaths(() =>
      validateTextFields(DEAL, 'update', { affiliateLink: '   ' })
    )).toEqual([['affiliateLink']]);
  });

  it('allows a Deal to omit sale price and MRP', () => {
    expect(() =>
      validateTextFields(DEAL, 'update', { salePrice: null, mrp: null })
    ).not.toThrow();
  });

  it('requires store shortDescription and logo (rows 93/94)', () => {
    expect(problemPaths(() =>
      validateTextFields(STORE, 'update', { shortDescription: '', logo: null })
    )).toEqual([['shortDescription'], ['logo']]);
  });

  it('requires store SEO title and description', () => {
    expect(problemPaths(() =>
      validateTextFields(STORE, 'update', { seo: { metaTitle: '  ' } })
    )).toEqual([
      ['seo', 'metaTitle'],
      ['seo', 'metaDescription'],
    ]);
  });

  it('skips store SEO entirely when the payload omits the component', () => {
    expect(() =>
      validateTextFields(STORE, 'update', { logoAlt: 'Amazon' })
    ).not.toThrow();
  });

  it('rejects a blank brand shortDescription that schema `required` lets through', () => {
    // brand.shortDescription has `required: true`, which compiles to notNil /
    // notNull only — "" passes core validation untouched.
    expect(problemPaths(() =>
      validateTextFields(BRAND, 'update', { shortDescription: '' })
    )).toEqual([['shortDescription']]);
  });

  it.each([STORE, BRAND, CATEGORY, BANK])(
    'allows %s to omit its optional website URL',
    (uid) => {
      expect(() =>
        validateTextFields(uid, 'update', { websiteUrl: '   ' })
      ).not.toThrow();
    },
  );

  it('does not duplicate brand SEO (owned by entity-field-validation)', () => {
    expect(() =>
      validateTextFields(BRAND, 'update', { seo: {} })
    ).not.toThrow();
  });

  it('accepts a store logo supplied as a connect patch', () => {
    expect(() =>
      validateTextFields(STORE, 'update', { logo: { set: [{ id: 12 }] } })
    ).not.toThrow();
  });

  it('rejects a disconnect-only patch that removes the stored logo', () => {
    expect(problemPaths(() =>
      validateTextFields(
        STORE,
        'update',
        { logo: { disconnect: [{ documentId: 'logo-1' }] } },
        { logo: { documentId: 'logo-1' } },
      )
    )).toEqual([['logo']]);
  });

  it('treats an empty connect patch as a no-op when a logo is stored', () => {
    expect(() =>
      validateTextFields(
        STORE,
        'update',
        { logo: { connect: [] } },
        { logo: { documentId: 'logo-1' } },
      )
    ).not.toThrow();
  });

  it('reports every problem at once with string-array paths', () => {
    try {
      validateTextFields(COUPON, 'create', {});
      throw new Error('expected to throw');
    } catch (err: any) {
      expect(err.name).toBe('ValidationError');
      expect(err.details.errors.length).toBe(5);
      for (const e of err.details.errors) {
        expect(Array.isArray(e.path)).toBe(true);
        expect(e.path.every((p: unknown) => typeof p === 'string')).toBe(true);
        expect(e.name).toBe('ValidationError');
      }
      expect(err.details.problems[0]).toMatch(/^title: /);
    }
  });
});

// ---------------------------------------------------------------------------

describe('validateTextFields — clone merge base', () => {
  it('accepts an empty coupon clone when required fields and taxonomy are inherited', () => {
    expect(() =>
      validateTextFields(COUPON, 'clone', {}, validCoupon())
    ).not.toThrow();
  });

  it('inherits nested SEO and media for an empty store clone', () => {
    expect(() =>
      validateTextFields(
        STORE,
        'clone',
        {},
        validStore(),
      )
    ).not.toThrow();
  });

  it('merges a partial nested SEO override over inherited clone fields', () => {
    expect(() =>
      validateTextFields(
        STORE,
        'clone',
        { seo: { metaTitle: 'Amazon Offers' } },
        validStore(),
      )
    ).not.toThrow();
  });

  it('does not inherit nested SEO when the clone explicitly clears the component', () => {
    expect(problemPaths(() =>
      validateTextFields(
        STORE,
        'clone',
        { seo: null },
        validStore(),
      )
    )).toEqual([
      ['seo', 'metaTitle'],
      ['seo', 'metaDescription'],
    ]);
  });

  it('still rejects an explicit clone override that clears inherited data', () => {
    expect(problemPaths(() =>
      validateTextFields(
        STORE,
        'clone',
        { logo: { disconnect: [{ documentId: 'logo-1' }] } },
        validStore(),
      )
    )).toEqual([['logo']]);
  });

  it('resolves clone taxonomy patches against the source relations', () => {
    const stored = {
      ...validCoupon(),
      stores: [{ documentId: 'store-1' }],
      banks: [],
      categories: [],
      brands: [],
    };
    expect(problemPaths(() =>
      validateTextFields(
        COUPON,
        'clone',
        { stores: { disconnect: [{ documentId: 'store-1' }] } },
        stored,
      )
    )).toEqual([['stores']]);
  });
});

// ---------------------------------------------------------------------------

describe('validateTextFields — offer taxonomy (row 48)', () => {
  const complete = () => ({ ...validCoupon(), stores: [] });

  it('skips entirely on update when the payload mentions no relations', () => {
    expect(() =>
      validateTextFields(COUPON, 'update', { title: 'x' }, {
        stores: [],
        banks: [],
        categories: [],
        brands: [],
      })
    ).not.toThrow();
  });

  it('rejects a create with no taxonomy at all', () => {
    expect(problemPaths(() =>
      validateTextFields(COUPON, 'create', { ...complete(), stores: undefined })
    )).toContainEqual(['stores']);
  });

  it('accepts a create with a single category', () => {
    expect(() =>
      validateTextFields(COUPON, 'create', {
        ...validCoupon(),
        stores: undefined,
        categories: [{ documentId: 'cat-1' }],
      })
    ).not.toThrow();
  });

  it('rejects disconnecting the last taxonomy', () => {
    const stored = {
      stores: [{ documentId: 'store-1' }],
      banks: [],
      categories: [],
      brands: [],
    };
    expect(problemPaths(() =>
      validateTextFields(
        COUPON,
        'update',
        { stores: { disconnect: [{ documentId: 'store-1' }] } },
        stored
      )
    )).toEqual([['stores']]);
  });

  it('grandfathers an unchanged full-form re-send of an orphaned offer', () => {
    const relations = {
      stores: [],
      banks: [],
      categories: [],
      brands: [],
    };
    expect(() =>
      validateTextFields(COUPON, 'update', relations, relations)
    ).not.toThrow();
  });

  it('allows disconnecting a store when a stored category remains', () => {
    // Rule 4: an untouched key contributes its STORED count, never zero.
    const stored = {
      stores: [{ documentId: 'store-1' }],
      banks: [],
      categories: [{ documentId: 'cat-1' }],
      brands: [],
    };
    expect(() =>
      validateTextFields(
        COUPON,
        'update',
        { stores: { disconnect: [{ documentId: 'store-1' }] } },
        stored
      )
    ).not.toThrow();
  });

  it('allows swapping the last store for a bank in one payload', () => {
    const stored = {
      stores: [{ documentId: 'store-1' }],
      banks: [],
      categories: [],
      brands: [],
    };
    expect(() =>
      validateTextFields(
        COUPON,
        'update',
        {
          stores: { disconnect: [{ documentId: 'store-1' }] },
          banks: { connect: [{ documentId: 'bank-1' }] },
        },
        stored
      )
    ).not.toThrow();
  });

  it('honours the `set` shape', () => {
    const stored = { stores: [{ documentId: 'store-1' }] };
    expect(problemPaths(() =>
      validateTextFields(COUPON, 'update', { stores: { set: [] } }, stored)
    )).toEqual([['stores']]);
    expect(() =>
      validateTextFields(
        COUPON,
        'update',
        { stores: { set: [{ documentId: 'store-2' }] } },
        stored
      )
    ).not.toThrow();
  });

  it('honours a bare array (REST / seed shape)', () => {
    expect(problemPaths(() =>
      validateTextFields(COUPON, 'update', { stores: [] }, { stores: [{ documentId: 's' }] })
    )).toEqual([['stores']]);
  });

  it('applies to deals as well as coupons', () => {
    expect(problemPaths(() =>
      validateTextFields(
        DEAL,
        'update',
        { brands: [] },
        { brands: [{ documentId: 'brand-1' }] },
      )
    )).toEqual([['brands']]);
  });

  it('does not apply to stores or brands', () => {
    expect(() =>
      validateTextFields(STORE, 'update', { coupons: [] })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('validateTextFields — STRICT (clean as you touch)', () => {
  it('STRICT blocks a dirty untouched required field on update', () => {
    // Editor only changes the title; the legacy blank affiliateLink is
    // untouched (absent from the payload) but must still block the save.
    expect(problemPaths(() =>
      validateTextFields(
        COUPON,
        'update',
        { title: 'New title' },
        { ...validCoupon(), title: 'Old title', affiliateLink: '' },
        true,
      )
    )).toEqual([['affiliateLink']]);
  });

  it('NON-strict leaves the same dirty untouched required field alone (cron path)', () => {
    expect(() =>
      validateTextFields(
        COUPON,
        'update',
        { title: 'New title' },
        {
          title: 'Old title',
          content: '<p>x</p>',
          affiliateLink: '',
          stores: [{ documentId: 'store-1' }],
        },
        false,
      )
    ).not.toThrow();
  });

  it('STRICT blocks an orphaned offer even when taxonomy is untouched', () => {
    expect(problemPaths(() =>
      validateTextFields(
        COUPON,
        'update',
        { title: 'New title' },
        {
          ...validCoupon(),
          title: 'Old title',
          stores: [],
          banks: [],
          categories: [],
          brands: [],
        },
        true,
      )
    )).toEqual([['stores']]);
  });

  it('STRICT blocks a dirty untouched media field', () => {
    // Otherwise-complete stored row so the only dirty field is the media one.
    expect(problemPaths(() =>
      validateTextFields(
        STORE,
        'update',
        { name: 'Amazon India' },
        { ...validStore(), logo: null },
        true,
      )
    )).toEqual([['logo']]);
  });

  it('STRICT passes when the whole effective record is clean', () => {
    expect(() =>
      validateTextFields(
        COUPON,
        'update',
        { title: 'New title' },
        {
          ...validCoupon(),
          title: 'Old title',
          banks: [],
          categories: [],
          brands: [],
        },
        true,
      )
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('requiresStoredRead / validateTextFieldsForWrite', () => {
  it('STRICT forces a stored read even for a non-required-field update', () => {
    expect(requiresStoredRead(COUPON, 'update', { contentStatus: 'expired' }, true)).toBe(true);
    expect(requiresStoredRead(COUPON, 'update', { contentStatus: 'expired' }, false)).toBe(false);
  });

  it('STRICT write fetches stored and blocks a dirty untouched required field', async () => {
    const findOne = vi.fn().mockResolvedValue({
      documentId: 'c1',
      title: 'Old',
      content: '<p>x</p>',
      affiliateLink: '',
      stores: [{ documentId: 'store-1' }],
      banks: [],
      categories: [],
      brands: [],
    });
    const strapi: any = { documents: () => ({ findOne }) };
    await expect(
      validateTextFieldsForWrite(strapi, COUPON, 'update', { title: 'New' }, 'c1', true)
    ).rejects.toThrow(/Affiliate link is required/);
    expect(findOne).toHaveBeenCalled();
  });

  it('NON-strict write leaves the same dirty untouched required field alone', async () => {
    const findOne = vi.fn().mockResolvedValue({
      documentId: 'c1',
      title: 'Old',
      content: '<p>x</p>',
      affiliateLink: '',
      stores: [{ documentId: 'store-1' }],
      banks: [],
      categories: [],
      brands: [],
    });
    const strapi: any = { documents: () => ({ findOne }) };
    await expect(
      validateTextFieldsForWrite(strapi, COUPON, 'update', { title: 'New' }, 'c1', false)
    ).resolves.toBeUndefined();
  });
});

describe('requiresStoredRead / validateTextFieldsForWrite (existing)', () => {
  it('needs no stored read for the contentStatus cron payload', () => {
    expect(requiresStoredRead(COUPON, 'update', { contentStatus: 'expired' })).toBe(false);
  });

  it('needs no stored read on create but compares required fields on entity updates', () => {
    expect(requiresStoredRead(COUPON, 'create', { stores: [] })).toBe(false);
    expect(requiresStoredRead(COUPON, 'clone', {})).toBe(true);
    expect(requiresStoredRead(STORE, 'update', { logo: null })).toBe(true);
  });

  it('needs a stored read when relations are touched', () => {
    expect(requiresStoredRead(COUPON, 'update', { banks: { disconnect: [] } })).toBe(true);
  });

  it('needs a stored read for full-form required fields so legacy blanks can be compared', () => {
    expect(requiresStoredRead(COUPON, 'update', { affiliateLink: null })).toBe(true);
    expect(requiresStoredRead(STORE, 'update', { seo: { metaTitle: null } })).toBe(true);
  });

  it('issues NO query for a cron-shaped update', async () => {
    const findOne = vi.fn();
    const strapi: any = { documents: () => ({ findOne }) };
    await validateTextFieldsForWrite(strapi, COUPON, 'update', {
      contentStatus: 'expired',
    });
    expect(findOne).not.toHaveBeenCalled();
  });

  it('fetches the stored relations and validates against them', async () => {
    const findOne = vi.fn().mockResolvedValue({
      documentId: 'c1',
      stores: [{ documentId: 'store-1' }],
      banks: [],
      categories: [],
      brands: [],
    });
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateTextFieldsForWrite(
        strapi,
        COUPON,
        'update',
        { stores: { disconnect: [{ documentId: 'store-1' }] } },
        'c1'
      )
    ).rejects.toThrow(/at least one Store, Bank, Category or Brand/);

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'c1',
        populate: expect.objectContaining({
          stores: { fields: ['documentId'] },
          brands: { fields: ['documentId'] },
        }),
      })
    );
  });

  it('fetches every clone-required field and relation before validation', async () => {
    const findOne = vi.fn().mockResolvedValue(validCoupon());
    const strapi: any = { documents: () => ({ findOne }) };

    await expect(
      validateTextFieldsForWrite(strapi, COUPON, 'clone', {}, 'c1')
    ).resolves.toBeUndefined();

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: 'c1',
        fields: expect.arrayContaining([
          'title',
          'content',
          'affiliateLink',
        ]),
        populate: expect.objectContaining({
          stores: { fields: ['documentId'] },
          banks: { fields: ['documentId'] },
          categories: { fields: ['documentId'] },
          brands: { fields: ['documentId'] },
        }),
      }),
    );
  });

  it('is a no-op for unrelated uids and non-write actions', async () => {
    const findOne = vi.fn();
    const strapi: any = { documents: () => ({ findOne }) };
    await validateTextFieldsForWrite(strapi, 'api::menu.menu', 'update', { x: 1 });
    await validateTextFieldsForWrite(strapi, COUPON, 'findOne', { stores: [] });
    expect(findOne).not.toHaveBeenCalled();
  });
});
