import { describe, expect, it, vi } from 'vitest';

import {
  findMerchantByRef,
  searchMerchants,
  withSelectedOption,
  type MerchantOption,
} from './merchant-options';

const STORE_URL = '/content-manager/collection-types/api::store.store';
const BRAND_URL = '/content-manager/collection-types/api::brand.brand';

const page = (results: unknown[], pageCount = 1) => ({
  data: { results, pagination: { pageCount } },
});

/** Answers by whichever collection-type URL the caller asked for. */
const clientWith = (
  responses: Record<string, unknown>,
  { failOn }: { failOn?: string } = {},
) => {
  const urls: string[] = [];
  const get = vi.fn(async (url: string) => {
    urls.push(url);
    if (failOn && url.startsWith(failOn)) throw new Error('403');
    const key = Object.keys(responses).find((prefix) => url.startsWith(prefix));
    return key ? responses[key] : page([]);
  });
  return { get, urls };
};

describe('searchMerchants', () => {
  it('returns Stores before Brands, each tagged with its kind', () => {
    const { get } = clientWith({
      [STORE_URL]: page([{ documentId: 's1', name: 'Amazon' }]),
      [BRAND_URL]: page([{ documentId: 'b1', name: 'Nike' }]),
    });

    return searchMerchants({ get }, '', 1).then((result) => {
      expect(result.options).toEqual([
        {
          value: 'store:s1',
          kind: 'store',
          kindLabel: 'Store',
          documentId: 's1',
          name: 'Amazon',
        },
        {
          value: 'brand:b1',
          kind: 'brand',
          kindLabel: 'Brand',
          documentId: 'b1',
          name: 'Nike',
        },
      ]);
    });
  });

  it('does NOT re-sort across the two sources', async () => {
    // A merged alphabetical list would reshuffle rows the editor is already
    // looking at every time "load more" appends a page. Two stable blocks.
    const { get } = clientWith({
      [STORE_URL]: page([{ documentId: 's1', name: 'Zara' }]),
      [BRAND_URL]: page([{ documentId: 'b1', name: 'Adidas' }]),
    });
    const result = await searchMerchants({ get }, '', 1);
    expect(result.options.map((option) => option.name)).toEqual([
      'Zara',
      'Adidas',
    ]);
  });

  it('passes the search term to both sources as a name filter', async () => {
    const { get, urls } = clientWith({});
    await searchMerchants({ get }, 'nik', 1);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url).toContain('filters%5Bname%5D%5B%24containsi%5D=nik');
      expect(url).toContain('sort=name%3AASC');
    }
  });

  it('omits the filter entirely for an empty search', async () => {
    const { get, urls } = clientWith({});
    await searchMerchants({ get }, '', 1);
    for (const url of urls) expect(url).not.toContain('filters');
  });

  it('reports more items when EITHER source has another page', async () => {
    const { get } = clientWith({
      [STORE_URL]: page([{ documentId: 's1', name: 'Amazon' }], 1),
      [BRAND_URL]: page([{ documentId: 'b1', name: 'Nike' }], 4),
    });
    await expect(searchMerchants({ get }, '', 1)).resolves.toMatchObject({
      hasMore: true,
    });
  });

  it('reports no more items when both sources are exhausted', async () => {
    const { get } = clientWith({
      [STORE_URL]: page([], 1),
      [BRAND_URL]: page([], 1),
    });
    await expect(searchMerchants({ get }, '', 1)).resolves.toMatchObject({
      hasMore: false,
    });
  });

  it('keeps one source usable when the other is forbidden', async () => {
    // A role without Brand read must still be able to pick a Store, rather
    // than face an empty dropdown.
    const { get } = clientWith(
      { [STORE_URL]: page([{ documentId: 's1', name: 'Amazon' }]) },
      { failOn: BRAND_URL },
    );
    const result = await searchMerchants({ get }, '', 1);
    expect(result.options.map((option) => option.value)).toEqual(['store:s1']);
  });

  it('skips rows with no documentId and labels nameless ones', async () => {
    const { get } = clientWith({
      [STORE_URL]: page([{ name: 'No id' }, { documentId: 's2', name: '  ' }]),
    });
    const result = await searchMerchants({ get }, '', 1);
    expect(result.options).toHaveLength(1);
    expect(result.options[0]).toMatchObject({
      value: 'store:s2',
      name: '(untitled store)',
    });
  });
});

describe('findMerchantByRef', () => {
  it('resolves a stored reference by documentId', async () => {
    const { get, urls } = clientWith({
      [BRAND_URL]: page([{ documentId: 'b1', name: 'Nike' }]),
    });
    await expect(
      findMerchantByRef({ get }, { kind: 'brand', documentId: 'b1' }),
    ).resolves.toMatchObject({ value: 'brand:b1', name: 'Nike' });
    expect(urls[0]).toContain('filters%5BdocumentId%5D%5B%24eq%5D=b1');
  });

  it('returns null when the target is gone', async () => {
    // The caller renders this as a visible warning — a silently blank dropdown
    // reads as "no merchant set" and would be saved back as exactly that.
    const { get } = clientWith({ [STORE_URL]: page([]) });
    await expect(
      findMerchantByRef({ get }, { kind: 'store', documentId: 'gone' }),
    ).resolves.toBeNull();
  });

  it('returns null when the lookup fails', async () => {
    const { get } = clientWith({}, { failOn: STORE_URL });
    await expect(
      findMerchantByRef({ get }, { kind: 'store', documentId: 's1' }),
    ).resolves.toBeNull();
  });
});

describe('withSelectedOption', () => {
  const option = (value: string): MerchantOption => ({
    value,
    kind: 'store',
    kindLabel: 'Store',
    documentId: value.split(':')[1],
    name: value,
  });

  it('prepends a selection that is not on the current page', () => {
    // Without this the Combobox renders the saved merchant as an empty box.
    const result = withSelectedOption([option('store:a')], option('store:z'));
    expect(result.map((item) => item.value)).toEqual(['store:z', 'store:a']);
  });

  it('does not duplicate a selection already in the list', () => {
    const result = withSelectedOption(
      [option('store:a'), option('store:b')],
      option('store:a'),
    );
    expect(result.map((item) => item.value)).toEqual(['store:a', 'store:b']);
  });

  it('returns a copy when there is no selection', () => {
    const options = [option('store:a')];
    const result = withSelectedOption(options, null);
    expect(result).toEqual(options);
    expect(result).not.toBe(options);
  });
});
