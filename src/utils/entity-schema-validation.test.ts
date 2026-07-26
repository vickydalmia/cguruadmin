import { describe, expect, it } from 'vitest';
import store from '../api/store/content-types/store/schema.json';
import brand from '../api/brand/content-types/brand/schema.json';
import category from '../api/category/content-types/category/schema.json';
import bank from '../api/bank/content-types/bank/schema.json';

const ENTITY_SCHEMAS = { store, brand, category, bank } as const;

describe('entity schema editorial requirements', () => {
  it.each(Object.entries(ENTITY_SCHEMAS))(
    '%s keeps shortDescription required and makes websiteUrl optional',
    (_kind, schema) => {
      expect(schema.attributes.shortDescription.required).toBe(true);
      expect(schema.attributes.websiteUrl.required).not.toBe(true);
      expect(schema.attributes.websiteUrl.regex).toMatch(/https/);
    },
  );
});
