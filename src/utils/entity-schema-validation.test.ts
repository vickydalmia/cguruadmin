import { describe, expect, it } from 'vitest';
import store from '../api/store/content-types/store/schema.json';
import brand from '../api/brand/content-types/brand/schema.json';
import category from '../api/category/content-types/category/schema.json';
import bank from '../api/bank/content-types/bank/schema.json';
import job from '../api/job/content-types/job/schema.json';

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

// Slugs are deliberately plain `string` attributes — NOT `uid`. The uid type's
// admin input carried a Regenerate button that editors used to change live
// slugs, and its implicit uniqueness validator is replaced app-side
// (identity-validation for the taxonomies, job-slug-validation for jobs). The
// regexes are also what changed-field-validation's SLUG_PATTERN /
// JOB_SLUG_PATTERN mirror, so pin them exactly.
describe('slug attributes stay plain regex-validated strings', () => {
  it.each(Object.entries(ENTITY_SCHEMAS))(
    '%s slug is a required string with the shared taxonomy regex',
    (_kind, schema) => {
      expect(schema.attributes.slug).toEqual({
        type: 'string',
        required: true,
        regex: '^[a-z0-9]+([-.][a-z0-9]+)*$',
      });
    },
  );

  it('job slug is a required string whose regex forbids dots', () => {
    expect(job.attributes.slug).toEqual({
      type: 'string',
      required: true,
      regex: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    });
    const pattern = new RegExp(job.attributes.slug.regex);
    expect(pattern.test('senior-editor')).toBe(true);
    expect(pattern.test('v1.5-role')).toBe(false);
    expect(pattern.test('Bad_Slug')).toBe(false);
  });
});
