import { describe, expect, it } from 'vitest';

import { humanizeField, pendingRequiredFields } from './pending-required';

const storeSchema = {
  attributes: {
    name: { type: 'string', required: true },
    shortDescription: { type: 'text', required: true },
    logo: { type: 'media', required: true },
    logoAlt: { type: 'string', required: true },
    websiteUrl: { type: 'string' },
    ratingAverage: { type: 'decimal' },
    seo: { type: 'component', component: 'shared.seo', repeatable: false },
    faqs: { type: 'component', component: 'shared.faq-item', repeatable: true },
  },
};

const components = {
  'shared.seo': {
    attributes: {
      metaTitle: { type: 'string', required: true },
      metaDescription: { type: 'text', required: true },
      canonicalUrl: { type: 'string' },
    },
  },
  'shared.faq-item': {
    attributes: { question: { type: 'string', required: true } },
  },
};

const completeStore = {
  name: 'Amazon',
  shortDescription: 'Shop Amazon offers.',
  logo: { id: 3 },
  logoAlt: 'Amazon logo',
  websiteUrl: 'https://www.amazon.in',
  seo: { metaTitle: 'Amazon Coupons', metaDescription: 'Latest coupons.' },
};

const paths = (values: Record<string, unknown>) =>
  pendingRequiredFields(storeSchema, components, values).map((p) => p.path);

describe('humanizeField', () => {
  it('turns camelCase attribute names into sentence case', () => {
    expect(humanizeField('websiteUrl')).toBe('Website url');
    expect(humanizeField('metaTitle')).toBe('Meta title');
    expect(humanizeField('name')).toBe('Name');
  });
});

describe('pendingRequiredFields', () => {
  it('reports nothing for a complete record', () => {
    expect(paths(completeStore)).toEqual([]);
  });

  it('reports every required field a legacy row is missing', () => {
    expect(paths({ name: 'Amazon' })).toEqual([
      ['shortDescription'],
      ['logo'],
      ['logoAlt'],
      ['seo', 'metaTitle'],
      ['seo', 'metaDescription'],
    ]);
  });

  it('does not report an optional website URL', () => {
    expect(paths({ ...completeStore, websiteUrl: null })).toEqual([]);
  });

  it('treats whitespace-only text as missing', () => {
    expect(paths({ ...completeStore, logoAlt: '   ' })).toEqual([['logoAlt']]);
  });

  it('never reports optional fields', () => {
    expect(paths({ ...completeStore, ratingAverage: null })).toEqual([]);
  });

  // 0 and false are real answers — flagging them would be wrong.
  it('treats 0 and false as present', () => {
    const schema = {
      attributes: {
        salePrice: { type: 'decimal', required: true },
        isVerified: { type: 'boolean', required: true },
      },
    };
    expect(
      pendingRequiredFields(schema, {}, { salePrice: 0, isVerified: false })
    ).toEqual([]);
  });

  it('treats cleared media widget shapes as missing', () => {
    for (const cleared of [null, [], { set: [] }, { connect: [] }]) {
      expect(paths({ ...completeStore, logo: cleared })).toEqual([['logo']]);
    }
    expect(paths({ ...completeStore, logo: { set: [{ id: 1 }] } })).toEqual([]);
  });

  it('reports required component fields at their real form path', () => {
    expect(paths({ ...completeStore, seo: { metaTitle: 'Only a title' } })).toEqual([
      ['seo', 'metaDescription'],
    ]);
  });

  it('reports required component fields when the component is absent entirely', () => {
    const { seo: _dropped, ...withoutSeo } = completeStore;
    expect(paths(withoutSeo)).toEqual([
      ['seo', 'metaTitle'],
      ['seo', 'metaDescription'],
    ]);
  });

  // Reporting "faqs #3 › question" from a panel that cannot scroll to that row
  // would be noise, so repeatables are deliberately out of scope.
  it('skips repeatable components', () => {
    expect(paths({ ...completeStore, faqs: [{ question: '' }] })).toEqual([]);
  });

  it('is a no-op without a schema', () => {
    expect(pendingRequiredFields(undefined, components, completeStore)).toEqual([]);
    expect(pendingRequiredFields({ attributes: {} }, components, {})).toEqual([]);
  });
});
