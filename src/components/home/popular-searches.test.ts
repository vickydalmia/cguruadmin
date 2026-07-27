import { describe, expect, it } from 'vitest';
import schema from './popular-searches.json';

describe('home.popular-searches schema', () => {
  it('provides the switch and four searchable entity relation selectors', () => {
    expect(schema.attributes.enabled).toMatchObject({
      type: 'boolean',
      default: true,
    });
    expect(schema.attributes).not.toHaveProperty('links');
    expect(schema.attributes).toMatchObject({
      stores: {
        type: 'relation',
        relation: 'oneToMany',
        target: 'api::store.store',
      },
      brands: {
        type: 'relation',
        relation: 'oneToMany',
        target: 'api::brand.brand',
      },
      categories: {
        type: 'relation',
        relation: 'oneToMany',
        target: 'api::category.category',
      },
      banks: {
        type: 'relation',
        relation: 'oneToMany',
        target: 'api::bank.bank',
      },
    });
  });
});
