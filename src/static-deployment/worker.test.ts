import { describe, expect, it } from 'vitest';
import { redisRevalidatePayload, type RebuildJob } from './worker';

const job = (overrides: Partial<RebuildJob> = {}): RebuildJob => ({
  full: false,
  homepage: false,
  sitemap: false,
  slugs: [],
  reasons: [],
  ...overrides,
});

describe('redisRevalidatePayload', () => {
  it('refreshes sitemap with the routes data scope for entity updates', () => {
    expect(
      redisRevalidatePayload(
        job({
          homepage: true,
          sitemap: true,
          slugs: ['amazon', 'deal-of-the-day'],
        }),
      ),
    ).toEqual({
      paths: [
        '/',
        '/sitemap.xml',
        '/amazon/',
        '/deal-of-the-day/',
      ],
      scopes: ['routes'],
    });
  });

  it('does not bust routes data for ordinary content-only scopes', () => {
    expect(
      redisRevalidatePayload(job({ homepage: true, slugs: ['amazon'] })),
    ).toEqual({ paths: ['/', '/amazon/'] });
  });

  it('keeps a full sweep represented by all=true', () => {
    expect(redisRevalidatePayload(job({ full: true, sitemap: true }))).toEqual({
      all: true,
    });
  });
});
