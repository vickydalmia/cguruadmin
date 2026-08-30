import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyAdminRelationSearchFields,
  getAdminRelationSearchFields,
  groupAdminRelationSearchFields,
  LIVE_OFFER_PICKER_DESCRIPTION,
} from './content-manager-relation-search';

/** All real component schemas, shaped like the loaded `strapi.components`. */
function schemaStrapi(): any {
  const components: Record<string, any> = {};
  const componentsDir = path.join(process.cwd(), 'src', 'components');
  for (const namespace of readdirSync(componentsDir)) {
    const dir = path.join(componentsDir, namespace);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      components[`${namespace}.${file.slice(0, -'.json'.length)}`] = JSON.parse(
        readFileSync(path.join(dir, file), 'utf8'),
      );
    }
  }
  return { components };
}

type SchemaRelation = {
  sourceUid: string;
  field: string;
  targetUid: string;
};

function componentRelations(namespace: 'deal-day' | 'home'): SchemaRelation[] {
  const directory = path.join(process.cwd(), 'src', 'components', namespace);
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      const schema = JSON.parse(
        readFileSync(path.join(directory, file), 'utf8'),
      ) as { attributes?: Record<string, { type?: string; target?: string }> };
      const sourceUid = `${namespace}.${file.slice(0, -'.json'.length)}`;
      return Object.entries(schema.attributes ?? {}).flatMap(
        ([field, attribute]) =>
          attribute.type === 'relation' && typeof attribute.target === 'string'
            ? [{ sourceUid, field, targetUid: attribute.target }]
            : [],
      );
    });
}

const relationKey = (
  relation: Pick<SchemaRelation, 'field' | 'sourceUid'>,
) => `${relation.sourceUid}.${relation.field}`;

describe('getAdminRelationSearchFields', () => {
  it('covers every Homepage and Deal-of-the-Day component relation', () => {
    const actual = [
      ...componentRelations('home'),
      ...componentRelations('deal-day'),
    ].sort((a, b) => relationKey(a).localeCompare(relationKey(b)));
    const configured = getAdminRelationSearchFields(schemaStrapi())
      .filter(
        ({ sourceUid }) =>
          sourceUid.startsWith('home.') ||
          sourceUid.startsWith('deal-day.'),
      )
      .map(({ sourceUid, field, targetUid }) => ({
        sourceUid,
        field,
        targetUid,
      }))
      .sort((a, b) => relationKey(a).localeCompare(relationKey(b)));

    expect(actual).toHaveLength(22);
    expect(configured).toEqual(actual);
  });

  it('uses title for offers and name for directory entities', () => {
    const derived = getAdminRelationSearchFields(schemaStrapi());
    expect(derived.length).toBeGreaterThan(0);

    const expectedByTarget: Record<string, 'name' | 'title'> = {
      'api::coupon.coupon': 'title',
      'api::deal.deal': 'title',
      'api::store.store': 'name',
      'api::brand.brand': 'name',
      'api::category.category': 'name',
      'api::bank.bank': 'name',
    };

    for (const relation of derived) {
      expect(relation.mainField).toBe(expectedByTarget[relation.targetUid]);
    }
  });

  it('pins the header and navigation pickers the static list used to miss', () => {
    const derived = getAdminRelationSearchFields(schemaStrapi()).map(
      ({ sourceUid, field, mainField }) => ({ sourceUid, field, mainField }),
    );

    expect(derived).toEqual(
      expect.arrayContaining([
        { sourceUid: 'home.hero-product', field: 'coupon', mainField: 'title' },
        { sourceUid: 'header.coupon-notification', field: 'coupon', mainField: 'title' },
        { sourceUid: 'header.product-deal-notification', field: 'productDeal', mainField: 'title' },
        { sourceUid: 'header.search-top-store', field: 'store', mainField: 'name' },
        { sourceUid: 'nav.link', field: 'store', mainField: 'name' },
        { sourceUid: 'nav.link', field: 'category', mainField: 'name' },
        { sourceUid: 'nav.category-section', field: 'category', mainField: 'name' },
      ]),
    );
  });
});

describe('applyAdminRelationSearchFields', () => {
  it('changes only the configured edit mainField', () => {
    const metadatas = {
      stores: {
        edit: { description: 'Choose stores', mainField: 'id' },
        list: { label: 'Stores' },
      },
      heading: {
        edit: { description: 'Unrelated field' },
      },
    };

    expect(
      applyAdminRelationSearchFields(metadatas, [
        { field: 'stores', mainField: 'name' },
      ]),
    ).toEqual({
      metadatas: {
        stores: {
          edit: { description: 'Choose stores', mainField: 'name' },
          list: { label: 'Stores' },
        },
        heading: {
          edit: { description: 'Unrelated field' },
        },
      },
      changedFields: ['stores'],
    });
    expect(metadatas.stores.edit.mainField).toBe('id');
  });

  it('is a no-op when every mainField is already correct', () => {
    expect(
      applyAdminRelationSearchFields(
        {
          coupon: {
            edit: { mainField: 'title' },
          },
        },
        [{ field: 'coupon', mainField: 'title' }],
      ),
    ).toBeNull();
  });

  it('fills the live-filter description only when the field has none', () => {
    expect(
      applyAdminRelationSearchFields(
        {
          deal: { edit: { mainField: 'title' } },
          coupon: { edit: { mainField: 'title', description: 'Hand-authored' } },
        },
        [
          {
            field: 'deal',
            mainField: 'title',
            description: LIVE_OFFER_PICKER_DESCRIPTION,
          },
          {
            field: 'coupon',
            mainField: 'title',
            description: LIVE_OFFER_PICKER_DESCRIPTION,
          },
        ],
      ),
    ).toEqual({
      metadatas: {
        deal: {
          edit: {
            mainField: 'title',
            description: LIVE_OFFER_PICKER_DESCRIPTION,
          },
        },
        coupon: { edit: { mainField: 'title', description: 'Hand-authored' } },
      },
      changedFields: ['deal'],
    });
  });
});

describe('groupAdminRelationSearchFields', () => {
  it('groups multiple relation pickers without losing their main fields', () => {
    const fields = groupAdminRelationSearchFields(
      getAdminRelationSearchFields(schemaStrapi()),
    ).get('home.popular-searches');

    expect(fields?.map(({ field, mainField }) => [field, mainField])).toEqual([
      ['stores', 'name'],
      ['brands', 'name'],
      ['categories', 'name'],
      ['banks', 'name'],
    ]);
  });
});
