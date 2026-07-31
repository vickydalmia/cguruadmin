import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_RELATION_SEARCH_FIELDS,
  applyAdminRelationSearchFields,
  groupAdminRelationSearchFields,
} from './content-manager-relation-search';

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

describe('ADMIN_RELATION_SEARCH_FIELDS', () => {
  it('covers every Homepage and Deal-of-the-Day component relation', () => {
    const actual = [
      ...componentRelations('home'),
      ...componentRelations('deal-day'),
    ].sort((a, b) => relationKey(a).localeCompare(relationKey(b)));
    const configured = ADMIN_RELATION_SEARCH_FIELDS
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

    expect(actual).toHaveLength(21);
    expect(configured).toEqual(actual);
  });

  it('uses title for offers and name for directory entities', () => {
    const expectedByTarget: Record<string, 'name' | 'title'> = {
      'api::coupon.coupon': 'title',
      'api::deal.deal': 'title',
      'api::store.store': 'name',
      'api::brand.brand': 'name',
      'api::category.category': 'name',
      'api::bank.bank': 'name',
    };

    for (const relation of ADMIN_RELATION_SEARCH_FIELDS) {
      expect(relation.mainField).toBe(expectedByTarget[relation.targetUid]);
    }
  });

  it('retains the existing header relation-search configuration', () => {
    expect(
      ADMIN_RELATION_SEARCH_FIELDS.filter(({ sourceUid }) =>
        sourceUid.startsWith('header.'),
      ),
    ).toEqual([
      {
        sourceUid: 'header.coupon-notification',
        field: 'coupon',
        targetUid: 'api::coupon.coupon',
        mainField: 'title',
      },
      {
        sourceUid: 'header.product-deal-notification',
        field: 'productDeal',
        targetUid: 'api::deal.deal',
        mainField: 'title',
      },
    ]);
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
});

describe('groupAdminRelationSearchFields', () => {
  it('groups multiple relation pickers without losing their main fields', () => {
    const fields = groupAdminRelationSearchFields().get(
      'home.popular-searches',
    );

    expect(fields?.map(({ field, mainField }) => [field, mainField])).toEqual([
      ['stores', 'name'],
      ['brands', 'name'],
      ['categories', 'name'],
      ['banks', 'name'],
    ]);
  });
});
