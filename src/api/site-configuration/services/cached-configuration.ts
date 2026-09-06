import type { Core } from '@strapi/strapi';
import { loadSiteConfiguration } from './site-configuration';
import {
  normalizeSiteConfiguration,
  type SiteConfiguration,
} from './country-registry';

const TTL_MS = 60_000;

let cached: { value: SiteConfiguration; at: number } | null = null;

/**
 * One-row memoized read for hot paths (search, response walkers) that must
 * not re-query site-configuration per request. Edits are picked up within one
 * TTL — the same staleness budget as the public route caches. A failed read
 * degrades to the last value, or the India defaults on a cold start.
 */
export async function cachedSiteConfiguration(
  strapi: Core.Strapi,
): Promise<SiteConfiguration> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    cached = { value: await loadSiteConfiguration(strapi), at: Date.now() };
  } catch (error) {
    strapi.log?.warn?.(
      `site-configuration cached read failed: ${String(error)}`,
    );
    cached = {
      value: cached?.value ?? normalizeSiteConfiguration(null),
      at: Date.now(),
    };
  }
  return cached.value;
}

/**
 * Drop the memo so the next read hits the database. Called by the Country
 * Setup write path so the locale bootstrap that follows a save (and every
 * hot path behind it) sees the new row at once instead of up to one TTL later.
 */
export function invalidateCachedSiteConfiguration(): void {
  cached = null;
}
