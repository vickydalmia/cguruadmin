import { describe, expect, it } from 'vitest';
import { reconcileDeletedOfferRetry } from './deleted-offer-retry';

describe('deleted offer retry reconciliation', () => {
  it.each(['coupon', 'deal'])('repairs a confirmed skipped %s detail without changing other work', (type) => {
    const path = `/${type}/123/`;
    const payload = { paths: ['/', path, '/store-deals/'], scopes: ['routes'], optionalPaths: ['/store-deals/'] };
    const repaired = reconcileDeletedOfferRetry(payload, `api::${type}.${type} delete`, `gateway skipped 1 path(s): ${path}`);
    expect(repaired).toEqual({ ...payload, optionalPaths: ['/store-deals/', path] });
    expect(payload.optionalPaths).toEqual(['/store-deals/']);
    expect(reconcileDeletedOfferRetry(repaired, `api::${type}.${type} delete`, `gateway skipped 1 path(s): ${path}`)).toBe(repaired);
  });

  it.each([
    ['api::coupon.coupon update', '/coupon/123/', 'routes'],
    ['api::coupon.coupon delete', '/deal/123/', 'routes'],
    ['api::coupon.coupon delete', '/unknown/', 'routes'],
    ['api::coupon.coupon delete', '/coupon/0/', 'routes'],
    ['api::coupon.coupon delete', '/coupon/123/', 'sitemap'],
  ])('keeps unrelated or unverified missing paths required (%s, %s, %s)', (reason, path, scope) => {
    const payload = { paths: [path], scopes: [scope] };
    expect(reconcileDeletedOfferRetry(payload, reason, `gateway skipped 1 path(s): ${path}`)).toBe(payload);
  });

  it.each([null, 'network timeout', 'gateway skipped 2 path(s): /coupon/123/, /unknown/'])('does not repair an unconfirmed failure: %s', (error) => {
    const payload = { paths: ['/coupon/123/'], scopes: ['routes'] };
    expect(reconcileDeletedOfferRetry(payload, 'api::coupon.coupon delete', error)).toBe(payload);
  });

  it('never adds a path outside the original command', () => {
    const payload = { paths: ['/'], scopes: ['routes'] };
    expect(reconcileDeletedOfferRetry(payload, 'api::coupon.coupon delete', 'gateway skipped 1 path(s): /coupon/123/')).toBe(payload);
  });
});
