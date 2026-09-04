import { describe, expect, it } from 'vitest';
import {
  buildLocalizedData,
  collectRelationTargets,
  collectTranslatableLeaves,
  resolveRelationDependencies,
  resolveRelationExistence,
} from './field-map';
import { sourceContentHash } from './source-hash';

// Minimal schema registry double: one localized taxonomy type with the real
// shapes that matter — localized scalars, a localized component with
// copy-only subfields + media + boolean, a repeatable component, an
// owner-side relation, an inverse relation, and non-localized fields.
const MODELS: Record<string, any> = {
  'api::store.store': {
    uid: 'api::store.store',
    kind: 'collectionType',
    pluginOptions: { i18n: { localized: true } },
    attributes: {
      name: {
        type: 'string',
        pluginOptions: { i18n: { localized: true } },
      },
      tagline: {
        type: 'string',
        pluginOptions: { i18n: { localized: true }, translation: { identity: true } },
      },
      slug: { type: 'string' },
      websiteUrl: { type: 'text' },
      code: { type: 'string' },
      affiliateLink: { type: 'text' },
      shortDescription: {
        type: 'text',
        maxLength: 200,
        pluginOptions: { i18n: { localized: true } },
      },
      description: {
        type: 'richtext',
        pluginOptions: { i18n: { localized: true } },
      },
      isVerified: { type: 'boolean' },
      logo: { type: 'media', multiple: false },
      seo: {
        type: 'component',
        component: 'shared.seo',
        repeatable: false,
        pluginOptions: { i18n: { localized: true } },
      },
      faqs: {
        type: 'component',
        component: 'shared.faq-item',
        repeatable: true,
        pluginOptions: { i18n: { localized: true } },
      },
      topPickCoupons: {
        type: 'relation',
        relation: 'manyToMany',
        target: 'api::coupon.coupon',
      },
      coupons: {
        type: 'relation',
        relation: 'manyToMany',
        target: 'api::coupon.coupon',
        mappedBy: 'stores',
      },
    },
  },
  'shared.seo': {
    uid: 'shared.seo',
    attributes: {
      metaTitle: { type: 'string', maxLength: 70 },
      metaDescription: { type: 'text', maxLength: 170 },
      canonicalUrl: { type: 'string' },
      noIndex: { type: 'boolean' },
      ogImage: { type: 'media', multiple: false },
    },
  },
  'shared.faq-item': {
    uid: 'shared.faq-item',
    attributes: {
      question: { type: 'string' },
      answer: { type: 'text' },
    },
  },
  'api::coupon.coupon': {
    uid: 'api::coupon.coupon',
    kind: 'collectionType',
    pluginOptions: { i18n: { localized: true } },
    attributes: {
      stores: {
        type: 'relation',
        relation: 'manyToMany',
        target: 'api::store.store',
      },
    },
  },
};

function fakeStrapi(arRows: Record<string, string[]> = {}) {
  return {
    getModel: (uid: string) => MODELS[uid],
    db: {
      query: (uid: string) => ({
        findMany: async ({ where }: any) => {
          const present = new Set(arRows[uid] ?? []);
          return (where.documentId.$in as string[])
            .filter((id) => present.has(id))
            .map((documentId) => ({ documentId }));
        },
      }),
    },
  } as any;
}

const ENTRY = {
  id: 7,
  documentId: 'store-1',
  name: 'Amazon',
  slug: 'amazon',
  websiteUrl: 'https://www.amazon.ae/',
  code: 'SAVE20',
  affiliateLink: 'https://tracking.example/amazon?campaign=ae',
  tagline: 'Golden Scent',
  shortDescription: 'Top online store',
  description: '<p>Shop <strong>everything</strong></p>',
  isVerified: true,
  logo: { id: 11, url: '/l.png' },
  seo: {
    id: 3,
    metaTitle: 'Amazon Coupons',
    metaDescription: 'Save with codes',
    canonicalUrl: 'https://x/amazon/',
    noIndex: false,
    ogImage: { id: 12 },
  },
  faqs: [
    { id: 4, question: 'How?', answer: 'Copy the code.' },
    { id: 5, question: 'When?', answer: 'Any time.' },
  ],
  topPickCoupons: [
    { id: 21, documentId: 'coupon-a' },
    { id: 22, documentId: 'coupon-b' },
  ],
  coupons: [{ id: 21, documentId: 'coupon-a' }],
};

describe('collectTranslatableLeaves', () => {
  it('collects localized text (with budgets), walks components, skips copy-only subfields', () => {
    const leaves = collectTranslatableLeaves(fakeStrapi(), 'api::store.store', ENTRY);
    const byPath = new Map(leaves.map((leaf) => [leaf.path, leaf]));

    expect([...byPath.keys()].sort()).toEqual([
      'description',
      'faqs.0.answer',
      'faqs.0.question',
      'faqs.1.answer',
      'faqs.1.question',
      'name',
      'seo.metaDescription',
      'seo.metaTitle',
      'shortDescription',
      'tagline',
    ]);
    // Only the actual entity name gets the proper-name exemption. A schema
    // flag on promotional copy cannot make it legal to retain English.
    expect(byPath.get('tagline')?.identity).toBeUndefined();
    expect(byPath.get('name')?.identity).toBe(true);
    // Non-localized scalars, the shared slug, URLs and media never leak in.
    expect(byPath.has('slug')).toBe(false);
    expect(byPath.has('websiteUrl')).toBe(false);
    expect(byPath.has('code')).toBe(false);
    expect(byPath.has('affiliateLink')).toBe(false);
    expect(byPath.has('seo.canonicalUrl')).toBe(false);
    // Budgets derive from schema maxLength × 0.95.
    expect(byPath.get('seo.metaTitle')?.maxLength).toBe(66);
    expect(byPath.get('shortDescription')?.maxLength).toBe(190);
    expect(byPath.get('seo.metaTitle')?.validationMaxLength).toBe(70);
    expect(byPath.get('shortDescription')?.validationMaxLength).toBe(200);
    expect(byPath.get('description')?.kind).toBe('richtext');
  });

  it('hashes leaves stably regardless of collection order', () => {
    const leaves = collectTranslatableLeaves(fakeStrapi(), 'api::store.store', ENTRY);
    const reversed = [...leaves].reverse();
    expect(sourceContentHash(leaves)).toBe(sourceContentHash(reversed));
    const edited = leaves.map((leaf) =>
      leaf.path === 'name' ? { ...leaf, value: 'Amazon AE' } : leaf,
    );
    expect(sourceContentHash(edited)).not.toBe(sourceContentHash(leaves));
    expect(sourceContentHash(leaves, 'writer-v1')).not.toBe(
      sourceContentHash(leaves, 'writer-v2'),
    );
    expect(
      sourceContentHash(
        leaves.map((leaf) =>
          leaf.path === 'shortDescription'
            ? { ...leaf, maxLength: (leaf.maxLength ?? 1) - 1 }
            : leaf,
        ),
      ),
    ).not.toBe(sourceContentHash(leaves));
  });
});

describe('relation collection and existence', () => {
  it('collects owner-side relation targets only', () => {
    const targets = collectRelationTargets(fakeStrapi(), 'api::store.store', ENTRY);
    expect(targets).toEqual([
      { targetUid: 'api::coupon.coupon', documentIds: ['coupon-a', 'coupon-b'] },
    ]);
  });

  it('marks localized targets present only when the locale row exists', async () => {
    const strapi = fakeStrapi({ 'api::coupon.coupon': ['coupon-a'] });
    const existence = await resolveRelationExistence(
      strapi,
      [{ targetUid: 'api::coupon.coupon', documentIds: ['coupon-a', 'coupon-b'] }],
      'ar',
    );
    expect(existence.present.has('api::coupon.coupon:coupon-a')).toBe(true);
    expect(existence.present.has('api::coupon.coupon:coupon-b')).toBe(false);
  });

  it('blocks offer taxonomy but treats entity forward curation as repairable', async () => {
    const strapi = fakeStrapi();
    const offer = await resolveRelationDependencies(
      strapi,
      'api::coupon.coupon',
      { stores: [{ documentId: 'store-1' }] },
      'ar',
    );
    const entity = await resolveRelationDependencies(
      strapi,
      'api::store.store',
      ENTRY,
      'ar',
    );

    expect(offer.required).toEqual([
      expect.objectContaining({ path: 'stores', documentId: 'store-1', required: true }),
    ]);
    expect(entity.required).toEqual([]);
    expect(entity.optional).toHaveLength(2);
  });
});

describe('buildLocalizedData', () => {
  it('assembles the locale payload: translated text, copied subfields, media ids, ordered relation sets, no row ids', async () => {
    const strapi = fakeStrapi({ 'api::coupon.coupon': ['coupon-a'] });
    const existence = await resolveRelationExistence(
      strapi,
      collectRelationTargets(strapi, 'api::store.store', ENTRY),
      'ar',
    );
    const translations = new Map<string, string>([
      ['name', 'أمازون'],
      ['tagline', 'Golden Scent'],
      ['shortDescription', 'متجر إلكتروني رائد'],
      ['description', '<p>تسوّق <strong>كل شيء</strong></p>'],
      ['seo.metaTitle', 'كوبونات أمازون'],
      ['seo.metaDescription', 'وفّر باستخدام أكواد الخصم'],
      ['faqs.0.question', 'كيف؟'],
      ['faqs.0.answer', 'انسخ الكود.'],
      ['faqs.1.question', 'متى؟'],
      ['faqs.1.answer', 'في أي وقت.'],
    ]);
    const plan = buildLocalizedData(
      strapi,
      'api::store.store',
      ENTRY,
      translations,
      existence,
    );

    expect(plan.data.name).toBe('أمازون');
    expect(plan.data.shortDescription).toBe('متجر إلكتروني رائد');
    // Non-localized top-level attributes are NOT in the payload — Strapi's
    // own i18n sync owns them, and echoing them back risks loops.
    expect('slug' in plan.data).toBe(false);
    expect('websiteUrl' in plan.data).toBe(false);
    expect('code' in plan.data).toBe(false);
    expect('affiliateLink' in plan.data).toBe(false);
    expect('isVerified' in plan.data).toBe(false);
    expect('logo' in plan.data).toBe(false);
    // Inverse relations are never written; owner side becomes an ordered
    // set with the missing ar target dropped and reported.
    expect('coupons' in plan.data).toBe(false);
    expect(plan.data.topPickCoupons).toEqual({
      set: [{ documentId: 'coupon-a' }],
    });
    expect(plan.skippedRelations).toEqual([
      {
        path: 'topPickCoupons',
        targetUid: 'api::coupon.coupon',
        documentId: 'coupon-b',
      },
    ]);

    const seo = plan.data.seo as Record<string, unknown>;
    expect(seo.metaTitle).toBe('كوبونات أمازون');
    expect(seo.metaDescription).toBe('وفّر باستخدام أكواد الخصم');
    expect(seo.canonicalUrl).toBe('https://x/amazon/');
    expect(seo.noIndex).toBe(false);
    expect(seo.ogImage).toBe(12);
    // Component row ids are stripped so Strapi creates the locale's own rows
    // instead of stealing the source's.
    expect('id' in seo).toBe(false);

    const faqs = plan.data.faqs as Array<Record<string, unknown>>;
    expect(faqs).toHaveLength(2);
    expect(faqs[0]).toEqual({ question: 'كيف؟', answer: 'انسخ الكود.' });
    expect(faqs[1]).toEqual({ question: 'متى؟', answer: 'في أي وقت.' });
  });

  it('refuses to copy English when a translated path is missing', () => {
    expect(() =>
      buildLocalizedData(
        fakeStrapi(),
        'api::store.store',
        ENTRY,
        new Map([
          ['name', 'أمازون'],
          ['tagline', 'Golden Scent'],
        ]),
        { present: new Set() },
      ),
    ).toThrow(/TRANSLATION_QUALITY_GATE_FAILED.*shortDescription/);
  });
});
