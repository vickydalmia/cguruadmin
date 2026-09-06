import { describe, expect, it } from 'vitest';
import { buildRefreshRequest, canonicalPagePath } from './refresh-request';
import { parseIsrOutboxPayload } from '../../../isr-outbox/store';
import { boundOutboxPayload, mergeOutboxPayloads } from '../../../isr-outbox/payload';
const languages = [{ code: 'en', name: 'English', pathPrefix: '' }, { code: 'ar', name: 'Arabic', pathPrefix: '/ar' }];
describe('manual website refresh', () => {
  it('uses a bounded deterministic key even for long paths', () => {
    const input = { locale: 'en', all: false, path: `/${'category-'.repeat(50)}/` };
    const first = buildRefreshRequest(input, languages);
    expect(first.eventKey).toMatch(/^[a-f0-9]{64}$/);
    expect(buildRefreshRequest(input, languages).eventKey).toBe(first.eventKey);
    expect(buildRefreshRequest({ ...input, locale: 'ar' }, languages).eventKey).not.toBe(first.eventKey);
  });
  it.each(['https://evil.test/', '//evil.test/', '/../admin', '/a/../admin', '/%2e%2e/admin', '/a?token=x', '/a#x', '/a\\b', ''])('rejects unsafe page path %s', (path) => {
    expect(() => canonicalPagePath(path)).toThrow();
  });
  it('canonicalizes Unicode paths and refuses encoded separators', () => {
    expect(canonicalPagePath('/café/')).toBe('/caf%C3%A9/');
    expect(canonicalPagePath('/caf%C3%A9')).toBe('/caf%C3%A9/');
    expect(() => canonicalPagePath('/a%2fb')).toThrow();
  });
  it('preserves English-only scope across persistence, coalescing and bounding', () => {
    const { payload } = buildRefreshRequest({ locale: 'en', all: true, confirm: true }, languages);
    expect(payload.excludeLocalePrefixes).toEqual(['/ar']);
    const parsed = parseIsrOutboxPayload(JSON.stringify(payload));
    expect(parsed).toEqual(payload);
    expect(mergeOutboxPayloads(parsed, parsed)).toEqual(payload);
    expect(boundOutboxPayload({ ...payload, paths: ['/a/', '/b/'] }, 1, 1000).excludeLocalePrefixes).toEqual(['/ar']);
  });
  it('keeps an explicit empty exclusion list on English-only deployments', () => {
    const { payload } = buildRefreshRequest({ locale: 'en', all: true, confirm: true }, languages.slice(0, 1));
    expect(parseIsrOutboxPayload(payload).excludeLocalePrefixes).toEqual([]);
  });
  it('targets exactly one language or explicit twins for all languages', () => {
    expect(buildRefreshRequest({ locale: 'ar', all: false, path: '/amazon' }, languages).payload).toMatchObject({ localePrefix: '/ar', paths: ['/amazon/'] });
    expect(buildRefreshRequest({ locale: '*', all: false, path: '/' }, languages).payload.paths).toEqual(['/', '/ar/']);
  });
  it('requires whole-site confirmation and rejects disabled locales and prefixed input', () => {
    expect(() => buildRefreshRequest({ locale: 'en', all: true }, languages)).toThrow(/Confirm/);
    expect(() => buildRefreshRequest({ locale: 'hi', all: false, path: '/' }, languages)).toThrow(/enabled/);
    expect(() => buildRefreshRequest({ locale: 'en', all: false, path: '/ar/amazon/' }, languages)).toThrow(/English/);
  });
  it('never broadens an oversized manual page request to the whole website', () => {
    const { payload } = buildRefreshRequest({ locale: '*', all: false, path: '/' }, languages);
    expect(() => boundOutboxPayload(payload, 1, 1000)).toThrow(/limits/);
    expect(() => mergeOutboxPayloads(payload, { ...payload, excludeLocalePrefixes: ['/ar'] })).toThrow();
  });
});
