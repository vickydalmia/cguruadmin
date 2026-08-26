import type { Core } from '@strapi/strapi';
import { loadSiteConfiguration } from '../api/site-configuration/services/site-configuration';
import { localizationPreview } from '../api/site-configuration/services/localization';

// Synchronous localization access for the offer response walkers
// (arrayizeOfferText and friends are sync and run on hot response paths, so
// they cannot await a DB read per call). Primed at bootstrap and refreshed in
// the background on a short TTL; site-configuration edits are picked up
// within one TTL, same as the public route caches.
export type OfferContentLocalization = {
  locale: string;
  currencySymbol: string;
  countryCode: string;
};

// India is the source-of-truth default for every deployment until the
// site-configuration row is readable.
const INDIA_DEFAULT: OfferContentLocalization = {
  locale: 'en-IN',
  currencySymbol: '₹',
  countryCode: 'IN',
};

const TTL_MS = 60_000;

let strapiRef: Core.Strapi | null = null;
let cached: { value: OfferContentLocalization; at: number } | null = null;
let refreshing: Promise<void> | null = null;

async function refresh(): Promise<void> {
  if (!strapiRef || refreshing) return refreshing ?? undefined;
  refreshing = (async () => {
    try {
      const config = await loadSiteConfiguration(strapiRef!);
      const preview = localizationPreview(
        config.locale,
        config.currencyCode,
        config.timezone,
        config.countryCode,
      );
      cached = {
        value: {
          locale: config.locale,
          currencySymbol: preview.currencySymbol,
          countryCode: config.countryCode,
        },
        at: Date.now(),
      };
    } catch (error) {
      // Keep serving the previous value (or the India default); a transient
      // read failure must never break offer responses.
      cached = { value: cached?.value ?? INDIA_DEFAULT, at: Date.now() };
      strapiRef?.log?.warn?.(
        `offer-content-localization refresh failed: ${String(error)}`,
      );
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Bootstrap hook: load the localization before the first request is served. */
export async function primeOfferContentLocalization(
  strapi: Core.Strapi,
): Promise<void> {
  strapiRef = strapi;
  await refresh();
}

export function currentOfferContentLocalization(): OfferContentLocalization {
  if (!cached || Date.now() - cached.at >= TTL_MS) void refresh();
  return cached?.value ?? INDIA_DEFAULT;
}
