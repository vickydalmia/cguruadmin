import { describe, expect, it } from 'vitest';
import menuSchema from '../../api/menu/content-types/menu/schema.json';
import searchSuggestionSchema from './search-suggestion.json';

describe('header search configuration schema', () => {
  const urlPattern = new RegExp(searchSuggestionSchema.attributes.url.regex);

  it.each([
    '/',
    '/search/?q=summer',
    '/stores/amazon/',
    'https://merchant.example/sale',
    'http://merchant.example:8080/offers?type=deal#featured',
  ])('accepts safe suggestion URL %s', (url) => {
    expect(urlPattern.test(url)).toBe(true);
  });

  it.each([
    '',
    'stores/amazon',
    '//merchant.example/sale',
    'javascript:alert(1)',
    'mailto:help@example.com',
    '/search path',
  ])('rejects unsafe or malformed suggestion URL %s', (url) => {
    expect(urlPattern.test(url)).toBe(false);
  });

  it('limits Search Top Stores independently to eight selections', () => {
    expect(menuSchema.attributes.searchTopStores).toMatchObject({
      type: 'component',
      repeatable: true,
      component: 'header.search-top-store',
      max: 8,
    });
    expect(menuSchema.attributes.topStores).toMatchObject({
      type: 'relation',
      target: 'api::store.store',
    });
  });
});
