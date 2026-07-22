const PUBLIC_OFFER_ROUTE_BY_MODEL = {
  'api::coupon.coupon': 'coupon',
  'api::deal.deal': 'deal',
} as const;

type PublicOfferModel = keyof typeof PUBLIC_OFFER_ROUTE_BY_MODEL;

function getPublicSiteUrl(configuredSiteUrl?: string): URL | null {
  const value = configuredSiteUrl?.trim();

  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function buildPublicOfferUrl(
  model: string,
  id: unknown,
  configuredSiteUrl?: string
): string | null {
  const route = PUBLIC_OFFER_ROUTE_BY_MODEL[model as PublicOfferModel];
  const numericId = typeof id === 'number' ? id : Number(String(id ?? '').trim());

  if (!route || !Number.isSafeInteger(numericId) || numericId <= 0) {
    return null;
  }

  const siteUrl = getPublicSiteUrl(configuredSiteUrl);
  if (!siteUrl) return null;

  return new URL(`/${route}/${numericId}/`, siteUrl.origin).toString();
}

export { PUBLIC_OFFER_ROUTE_BY_MODEL };
