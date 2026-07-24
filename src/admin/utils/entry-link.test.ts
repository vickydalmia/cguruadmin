import { describe, expect, it } from 'vitest';

import {
  buildEntryEditPath,
  isLinkableCellType,
  pickForwardedSearch,
} from './entry-link';

describe('buildEntryEditPath', () => {
  it('builds the content-manager edit path without a basename', () => {
    expect(
      buildEntryEditPath('collection-types', 'api::coupon.coupon', 'abc123def456ghi789jkl012')
    ).toBe('/content-manager/collection-types/api::coupon.coupon/abc123def456ghi789jkl012');
  });

  it('leaves the uid separators unencoded so the href matches Strapi own routes', () => {
    expect(buildEntryEditPath('collection-types', 'plugin::upload.file', 'xyz')).toBe(
      '/content-manager/collection-types/plugin::upload.file/xyz'
    );
  });

  it('forwards only the plugins query params, dropping list-view state', () => {
    expect(
      buildEntryEditPath(
        'collection-types',
        'api::deal.deal',
        'doc1',
        '?page=2&pageSize=50&sort=title:ASC&plugins[i18n][locale]=hi'
      )
    ).toBe('/content-manager/collection-types/api::deal.deal/doc1?plugins%5Bi18n%5D%5Blocale%5D=hi');
  });

  it('omits the query string entirely when nothing needs forwarding', () => {
    expect(buildEntryEditPath('collection-types', 'api::deal.deal', 'doc1', '?page=2')).toBe(
      '/content-manager/collection-types/api::deal.deal/doc1'
    );
  });

  it('refuses values that could break out of the path segment', () => {
    expect(buildEntryEditPath('collection-types', 'api::coupon.coupon', '../../settings')).toBeNull();
    expect(buildEntryEditPath('collection-types', 'api::coupon.coupon', 'a/b')).toBeNull();
    expect(buildEntryEditPath('collection-types', 'not-a-uid', 'doc1')).toBeNull();
    expect(buildEntryEditPath('collection-types/x', 'api::coupon.coupon', 'doc1')).toBeNull();
  });

  it('refuses missing or non-string inputs rather than building a broken href', () => {
    expect(buildEntryEditPath('collection-types', 'api::coupon.coupon', undefined)).toBeNull();
    expect(buildEntryEditPath('collection-types', 'api::coupon.coupon', 123)).toBeNull();
    expect(buildEntryEditPath(undefined, 'api::coupon.coupon', 'doc1')).toBeNull();
    expect(buildEntryEditPath('collection-types', null, 'doc1')).toBeNull();
    expect(buildEntryEditPath('collection-types', 'api::coupon.coupon', '')).toBeNull();
  });
});

describe('pickForwardedSearch', () => {
  it('works with or without the leading question mark', () => {
    expect(pickForwardedSearch('plugins[i18n][locale]=en')).toBe('plugins%5Bi18n%5D%5Blocale%5D=en');
    expect(pickForwardedSearch('?plugins[i18n][locale]=en')).toBe(
      'plugins%5Bi18n%5D%5Blocale%5D=en'
    );
  });

  it('returns an empty string for an empty or plugin-free search', () => {
    expect(pickForwardedSearch('')).toBe('');
    expect(pickForwardedSearch('?page=1&sort=title:ASC')).toBe('');
  });

  it('does not forward params that merely start with the word plugins', () => {
    expect(pickForwardedSearch('?pluginsEnabled=1')).toBe('');
  });
});

describe('isLinkableCellType', () => {
  it('accepts the plain-text attribute types the list view renders as text', () => {
    expect(isLinkableCellType('string')).toBe(true);
    expect(isLinkableCellType('text')).toBe(true);
    expect(isLinkableCellType('uid')).toBe(true);
    expect(isLinkableCellType('email')).toBe(true);
  });

  it('rejects types whose cells render their own interactive sub-tree', () => {
    expect(isLinkableCellType('relation')).toBe(false);
    expect(isLinkableCellType('media')).toBe(false);
    expect(isLinkableCellType('component')).toBe(false);
    expect(isLinkableCellType('boolean')).toBe(false);
    expect(isLinkableCellType('custom')).toBe(false);
    expect(isLinkableCellType(undefined)).toBe(false);
  });
});
