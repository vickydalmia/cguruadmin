import { describe, expect, it, vi } from 'vitest';
import { JOB_UID, validateJobSlug } from './job-slug-validation';

type Row = { documentId: string; slug: string; title?: string };

function harness(rows: Row[] = [], source: Row | null = null) {
  const findFirst = vi.fn((params: any) => {
    const eqi = String(params?.filters?.slug?.$eqi ?? '').toLowerCase();
    const ne = params?.filters?.documentId?.$ne;
    const hit =
      rows.find(
        (row) =>
          row.slug.toLowerCase() === eqi && (!ne || row.documentId !== ne),
      ) ?? null;
    return Promise.resolve(hit);
  });
  const findOne = vi.fn().mockResolvedValue(source);
  const documents = vi.fn(() => ({ findFirst, findOne }));
  return { strapi: { documents } as any, findFirst, findOne };
}

describe('validateJobSlug', () => {
  it('ignores other uids and never queries', async () => {
    const { strapi, findFirst } = harness([{ documentId: 'a', slug: 'editor' }]);
    await validateJobSlug(strapi, 'api::store.store', 'create', { slug: 'editor' });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('skips a partial update that does not touch slug', async () => {
    const { strapi, findFirst } = harness([{ documentId: 'a', slug: 'editor' }]);
    await validateJobSlug(strapi, JOB_UID, 'update', { isActive: false }, 'a');
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('leaves blank slugs to the schema required rule', async () => {
    const { strapi, findFirst } = harness();
    await validateJobSlug(strapi, JOB_UID, 'create', { slug: '   ' });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('accepts a create with an unused slug', async () => {
    const { strapi } = harness([{ documentId: 'a', slug: 'editor' }]);
    await expect(
      validateJobSlug(strapi, JOB_UID, 'create', { slug: 'designer' }),
    ).resolves.toBeUndefined();
  });

  it('rejects a create whose slug collides case-insensitively', async () => {
    const { strapi } = harness([
      { documentId: 'a', slug: 'Editor', title: 'Editor' },
    ]);
    await expect(
      validateJobSlug(strapi, JOB_UID, 'create', { slug: 'editor' }),
    ).rejects.toMatchObject({
      details: { errors: [{ path: ['slug'] }] },
    });
  });

  it('lets an update keep its own slug (self excluded)', async () => {
    const { strapi, findFirst } = harness([{ documentId: 'a', slug: 'editor' }]);
    await expect(
      validateJobSlug(strapi, JOB_UID, 'update', { slug: 'editor' }, 'a'),
    ).resolves.toBeUndefined();
    expect(findFirst).toHaveBeenCalledOnce();
  });

  it('rejects an update stealing another job’s slug', async () => {
    const { strapi } = harness([
      { documentId: 'a', slug: 'editor', title: 'Editor' },
      { documentId: 'b', slug: 'designer', title: 'Designer' },
    ]);
    await expect(
      validateJobSlug(strapi, JOB_UID, 'update', { slug: 'editor' }, 'b'),
    ).rejects.toThrow(/already used by the job "Editor"/);
  });

  it('rejects a clone that would inherit the source slug', async () => {
    // Strapi merges the omitted slug from the source after middleware, so an
    // un-edited clone is a guaranteed duplicate: the source stays in place and
    // must participate in the check.
    const { strapi, findOne } = harness(
      [{ documentId: 'a', slug: 'editor', title: 'Editor' }],
      { documentId: 'a', slug: 'editor' },
    );
    await expect(
      validateJobSlug(strapi, JOB_UID, 'clone', {}, 'a'),
    ).rejects.toThrow(/already used/);
    expect(findOne).toHaveBeenCalledOnce();
  });

  it('rejects a clone whose payload carries slug as an explicit undefined', async () => {
    // `{ slug: undefined }` is an own property, but Strapi strips it and
    // merges the source slug exactly like an omitted key — a programmatic
    // clone must not slip past the check on the hasOwnProperty technicality.
    const { strapi, findOne } = harness(
      [{ documentId: 'a', slug: 'editor', title: 'Editor' }],
      { documentId: 'a', slug: 'editor' },
    );
    await expect(
      validateJobSlug(strapi, JOB_UID, 'clone', { slug: undefined }, 'a'),
    ).rejects.toThrow(/already used/);
    expect(findOne).toHaveBeenCalledOnce();
  });

  it('accepts a clone whose payload provides a fresh slug', async () => {
    const { strapi, findOne } = harness([
      { documentId: 'a', slug: 'editor' },
    ]);
    await expect(
      validateJobSlug(strapi, JOB_UID, 'clone', { slug: 'editor-2' }, 'a'),
    ).resolves.toBeUndefined();
    expect(findOne).not.toHaveBeenCalled();
  });
});
