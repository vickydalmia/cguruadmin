import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// Exercise the installed Strapi endpoint definitions, not a copied predicate.
function documentEndpoints(extension: 'js' | 'mjs') {
  const file = resolve('node_modules/@strapi/content-manager/dist/admin/services', `documents.${extension}`);
  const source = readFileSync(file, 'utf8')
    .replace(/^import .*;$/gm, '')
    .replace(/^export \{.*\};$/gm, '');
  const contentManagerApi = {
    injectEndpoints: ({ endpoints }: any) => endpoints({ mutation: (value: any) => value, query: (value: any) => value }),
  };
  const context: any = {
    contentManagerApi, SINGLE_TYPES: 'single-types', stringify: () => '', exports: {},
    require: (name: string) => name.includes('collections') ? { SINGLE_TYPES: 'single-types' }
      : name.includes('api') ? { contentManagerApi } : { stringify: () => '' },
  };
  runInNewContext(`${source}\nglobalThis.endpoints = documentApi;`, context);
  return context.endpoints;
}

describe.each(['js', 'mjs'] as const)('Content Manager rejected saves (%s)', (extension) => {
  it.each(['single-types', 'collection-types'])('preserves the %s cache and form on validation failure', (collectionType) => {
    const endpoint = documentEndpoints(extension).updateDocument;
    const args = { collectionType, model: 'api::festival-page.festival-page', documentId: undefined };
    expect(endpoint.onQueryStarted).toBeUndefined();
    expect(endpoint.invalidatesTags(undefined, { status: 400, data: { error: { name: 'ValidationError' } } }, args)).toEqual([]);
    expect(endpoint.invalidatesTags(undefined, { status: 500 }, args)).toEqual([]);
  });
  it('still refetches the saved single type after a successful save', () => {
    const endpoint = documentEndpoints(extension).updateDocument;
    expect(endpoint.invalidatesTags({}, undefined, { collectionType: 'single-types', model: 'api::festival-page.festival-page' }))
      .toContainEqual({ type: 'Document', id: 'api::festival-page.festival-page' });
  });
});
