import { describe, expect, it } from 'vitest';

import {
  entriesPath,
  entryPath,
  exportPath,
  isPermissionError,
  parseImportJson,
  parseSearch,
  uiDictionaryError,
  unwrapEntries,
  unwrapStatus,
} from './api';

describe('ui-dictionary paths', () => {
  it('encodes dotted and awkward keys into the entry path', () => {
    expect(entryPath('ar', 'offers.count.other')).toBe('/ui-dictionary/entries/ar/offers.count.other');
    expect(entryPath('ar', 'a/b%c d')).toBe('/ui-dictionary/entries/ar/a%2Fb%25c%20d');
    expect(entryPath('pt-br', 'x.y')).toBe('/ui-dictionary/entries/pt-br/x.y');
  });

  it('builds the list and export query strings', () => {
    expect(entriesPath('en', false)).toBe('/ui-dictionary/entries?locale=en');
    expect(entriesPath('ar', true)).toBe('/ui-dictionary/entries?locale=ar&includeRemoved=1');
    expect(exportPath('ar')).toBe('/ui-dictionary/export?locale=ar');
  });
});

describe('unwrap helpers', () => {
  it('accept the fetch-client envelope and reject the wrong shape', () => {
    const status = { translationActive: false, languages: [], catalogue: null, perLocale: {}, jobs: null };
    expect(unwrapStatus({ data: { data: status } })).toEqual(status);
    expect(() => unwrapStatus({ data: { nope: 1 } })).toThrow(/unexpected response/);
    expect(unwrapEntries({ data: { data: { locale: 'en', entries: [] } } })).toEqual([]);
    expect(() => unwrapEntries({ data: {} })).toThrow(/unexpected response/);
  });
});

describe('errors', () => {
  it('reads the controller string error, Strapi error objects and network errors', () => {
    expect(uiDictionaryError({ response: { data: { error: 'nope' } } })).toBe('nope');
    expect(uiDictionaryError({ response: { data: { error: { message: 'Forbidden' } } } })).toBe('Forbidden');
    expect(uiDictionaryError(new Error('offline'))).toBe('offline');
    expect(isPermissionError({ response: { status: 403 } })).toBe(true);
    expect(isPermissionError({ response: { status: 500 } })).toBe(false);
  });
});

describe('parseSearch', () => {
  it('decodes and survives malformed escapes', () => {
    expect(parseSearch('view%20all')).toBe('view all');
    expect(parseSearch('%E0%A4%A')).toBe('%E0%A4%A');
    expect(parseSearch(undefined)).toBe('');
  });
});

describe('parseImportJson', () => {
  it('accepts a bare map and the export envelope', () => {
    expect(parseImportJson('{"a.b":"x"}')).toEqual({ 'a.b': 'x' });
    expect(parseImportJson('{"locale":"ar","messages":{"a.b":"y"}}')).toEqual({ 'a.b': 'y' });
  });

  it('rejects arrays, non-string values, empty maps and invalid JSON', () => {
    expect(() => parseImportJson('[1]')).toThrow(/object/);
    expect(() => parseImportJson('{"a.b":1}')).toThrow(/must be a string/);
    expect(() => parseImportJson('{}')).toThrow(/no keys/);
    expect(() => parseImportJson('{')).toThrow(/valid JSON/);
  });
});
