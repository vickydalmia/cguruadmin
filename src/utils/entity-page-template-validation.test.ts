import { describe, expect, it, vi } from 'vitest';

import {
  isEntityTemplateUid,
  validateUniqueEntityPageTemplate,
} from './entity-page-template-validation';

function strapiHarness(
  ownersByUid: Record<string, any[]>,
  sourcesByUid: Record<string, any> = {},
) {
  return {
    documents: vi.fn((uid: string) => ({
      findMany: vi.fn(async () => ownersByUid[uid] ?? []),
      findOne: vi.fn(async () => sourcesByUid[uid] ?? null),
    })),
  } as any;
}

describe('validateUniqueEntityPageTemplate', () => {
  it('applies only to the four entity collections', () => {
    expect(isEntityTemplateUid('api::category.category')).toBe(true);
    expect(isEntityTemplateUid('api::store.store')).toBe(true);
    expect(isEntityTemplateUid('api::coupon.coupon')).toBe(false);
  });

  it('ignores writes that do not assign a campaign template', async () => {
    const strapi = strapiHarness({
      'api::category.category': [
        { documentId: 'other', slug: 'deal-of-the-day', pageTemplate: 'dealTemplate' },
      ],
    });
    await expect(
      validateUniqueEntityPageTemplate(strapi, { pageTemplate: 'default' }, 'doc-1'),
    ).resolves.toBeUndefined();
    await expect(
      validateUniqueEntityPageTemplate(strapi, { name: 'No template change' }, 'doc-1'),
    ).resolves.toBeUndefined();
  });

  it('rejects a second owner of the same campaign template', async () => {
    const strapi = strapiHarness({
      'api::category.category': [
        { documentId: 'other', slug: 'deal-of-the-day', pageTemplate: 'dealTemplate' },
      ],
    });
    await expect(
      validateUniqueEntityPageTemplate(
        strapi,
        { pageTemplate: 'dealTemplate' },
        'doc-1',
      ),
    ).rejects.toThrowError(/already assigned/u);
  });

  it('allows the current owner to re-save its own template', async () => {
    const strapi = strapiHarness({
      'api::category.category': [
        { documentId: 'doc-1', slug: 'deal-of-the-day', pageTemplate: 'dealTemplate' },
      ],
    });
    await expect(
      validateUniqueEntityPageTemplate(
        strapi,
        { pageTemplate: 'dealTemplate' },
        'doc-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects a clone even when its source document owns the template', async () => {
    const strapi = strapiHarness({
      'api::category.category': [
        { documentId: 'doc-1', slug: 'deal-of-the-day', pageTemplate: 'dealTemplate' },
      ],
    });
    await expect(
      validateUniqueEntityPageTemplate(
        strapi,
        { pageTemplate: 'dealTemplate' },
        'doc-1',
        'clone',
      ),
    ).rejects.toThrowError(/already assigned/u);
  });

  it('checks an inherited template when a clone payload omits the field', async () => {
    const uid = 'api::category.category';
    const strapi = strapiHarness(
      {
        [uid]: [
          { documentId: 'doc-1', slug: 'deal-of-the-day', pageTemplate: 'dealTemplate' },
        ],
      },
      { [uid]: { documentId: 'doc-1', pageTemplate: 'dealTemplate' } },
    );
    await expect(
      validateUniqueEntityPageTemplate(strapi, {}, 'doc-1', 'clone', uid),
    ).rejects.toThrowError(/already assigned/u);
  });
});
