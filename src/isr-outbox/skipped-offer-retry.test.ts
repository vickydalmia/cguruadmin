import { describe, expect, it } from 'vitest';
import { reconcileSkippedOfferRetry } from './skipped-offer-retry';

const skipped = (...paths: string[]) => `gateway skipped ${paths.length} path(s): ${paths.join(', ')}`;

describe('skipped offer retry reconciliation', () => {
  it.each(['coupon', 'deal'])('repairs a skipped %s detail without changing other work', (type) => {
    const path = `/${type}/123/`;
    const payload = { paths: ['/', path, '/store-deals/'], scopes: ['routes'], optionalPaths: ['/store-deals/'] };
    const repaired = reconcileSkippedOfferRetry(payload, skipped(path));
    expect(repaired).toEqual({ ...payload, optionalPaths: ['/store-deals/', path] });
    expect(payload.optionalPaths).toEqual(['/store-deals/']);
    expect(reconcileSkippedOfferRetry(repaired, skipped(path))).toBe(repaired);
  });

  it('repairs every skipped offer detail of a store fan-out and keeps listing pages required', () => {
    // Shape of the production rows that retried every five minutes for months.
    const payload = {
      paths: ['/', '/sitemap_index.xml', '/flipkart-coupons/', '/great-savings-fest/', '/coupon/3/', '/coupon/3167/', '/deal/453/'],
      scopes: ['sitemap'],
    };
    const repaired = reconcileSkippedOfferRetry(payload, skipped('/coupon/3167/', '/deal/453/'));
    expect(repaired).toEqual({ ...payload, optionalPaths: ['/coupon/3167/', '/deal/453/'] });
    expect(repaired.paths).toEqual(payload.paths);
  });

  it('repairs offer details and leaves a skipped non-offer route required', () => {
    const payload = { paths: ['/', '/festival-test/', '/coupon/1274/'] };
    expect(reconcileSkippedOfferRetry(payload, skipped('/festival-test/', '/coupon/1274/'))).toEqual({
      ...payload,
      optionalPaths: ['/coupon/1274/'],
    });
  });

  it.each(['/unknown/', '/coupon/0/', '/coupon/abc/', '/coupon/12', '/coupons/12/', '/en/coupon/12/'])(
    'keeps a path that is not an offer detail route required (%s)',
    (path) => {
      const payload = { paths: [path] };
      expect(reconcileSkippedOfferRetry(payload, skipped(path))).toBe(payload);
    },
  );

  it.each([null, '', 'network timeout', 'gateway returned 500: boom', 'gateway skipped 0 path(s): /coupon/1/'])(
    'does not repair without a skipped-path report: %s',
    (error) => {
      const payload = { paths: ['/coupon/123/'] };
      expect(reconcileSkippedOfferRetry(payload, error)).toBe(payload);
    },
  );

  it('never adds a path outside the original command', () => {
    const payload = { paths: ['/'] };
    expect(reconcileSkippedOfferRetry(payload, skipped('/coupon/123/'))).toBe(payload);
  });

  it('ignores a global command, which has no paths to repair', () => {
    const payload = { all: true };
    expect(reconcileSkippedOfferRetry(payload, skipped('/coupon/123/'))).toBe(payload);
  });

  it('ignores an entry cut off by the stored-error length cap', () => {
    const payload = { paths: ['/coupon/1/', '/coupon/12/', '/coupon/123/'] };
    // last_error is capped at 4,000 characters, so the tail can be partial.
    expect(reconcileSkippedOfferRetry(payload, 'gateway skipped 3 path(s): /coupon/1/, /coupon/12')).toEqual({
      ...payload,
      optionalPaths: ['/coupon/1/'],
    });
  });

  it('does not duplicate a path the error repeats', () => {
    const payload = { paths: ['/deal/9/'] };
    expect(reconcileSkippedOfferRetry(payload, skipped('/deal/9/', '/deal/9/'))).toEqual({
      ...payload,
      optionalPaths: ['/deal/9/'],
    });
  });
});
