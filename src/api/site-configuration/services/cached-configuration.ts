import type { Core } from '@strapi/strapi';
import { deploymentCountryCode } from '../../../utils/deployment-country';
import { loadSiteConfiguration } from './site-configuration';
import {
  normalizeSiteConfiguration,
  type SiteConfiguration,
} from './country-registry';

const TTL_MS = 15_000;

let cached: { value: SiteConfiguration; at: number } | null = null;
let pending: Promise<SiteConfiguration> | null = null;
let generation = 0;

/**
 * One-row memoized read for hot paths (search, response walkers) that must
 * not re-query site-configuration per request. Edits are picked up within one
 * TTL — the same staleness budget as the public route caches. A failed read
 * degrades to the last value. Production cold starts require valid settings.
 */
export async function cachedSiteConfiguration(
  strapi: Core.Strapi,
): Promise<SiteConfiguration> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  if (pending) return pending;
  const started = generation;
  const request = readConfiguration(strapi, started);
  pending = request;
  try { return await request; } finally { if (pending === request) pending = null; }
}

async function readConfiguration(strapi: Core.Strapi, started: number): Promise<SiteConfiguration> {
  try {
    const value = await loadSiteConfiguration(strapi);
    if (started === generation) cached = { value, at: Date.now() };
    return value;
  } catch (error) {
    strapi.log?.warn?.(
      `site-configuration cached read failed: ${String(error)}`,
    );
    const expected = deploymentCountryCode();
    if (!cached && (process.env.NODE_ENV === 'production' || (expected && expected !== 'IN'))) throw error;
    const fallback = {
      value: cached?.value ?? normalizeSiteConfiguration(null),
      at: Date.now(),
    };
    if (started === generation) cached = fallback;
    return fallback.value;
  }
}

/**
 * Drop the memo so the next read hits the database. Called by the Country
 * Setup write path so the locale bootstrap that follows a save (and every
 * hot path behind it) sees the new row at once instead of up to one TTL later.
 */
export function invalidateCachedSiteConfiguration(): void {
  generation += 1;
  pending = null;
  if (cached) cached.at = 0;
}
