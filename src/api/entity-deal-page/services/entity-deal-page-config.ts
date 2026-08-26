// Entity Deal-page CONFIGURATION: the per-entity registry, field/limit
// projections, shared types and text helpers. One of the modules split out
// of the entity-deal-page service (see ./entity-deal-page.ts).
import { AMAZON_AFFILIATE_DISCLOSURE_FIELD } from '../../../utils/amazon-affiliate-disclosure';
import { type IdentityKind } from '../../../utils/route-normalization';

export const ENTITY_DEAL_PAGE_DEFAULT_PAGE_SIZE = 50;

// Astro fetches every page of a catalogue during regeneration, so a larger
// ceiling is a direct reduction in requests per render (and in how close a
// render gets to the route's 60/min rate limit).
export const ENTITY_DEAL_PAGE_MAX_PAGE_SIZE = 250;

export type EntityUid =
  | 'api::store.store'
  | 'api::brand.brand'
  | 'api::category.category'
  | 'api::bank.bank';

export type EntityConfig = {
  kind: IdentityKind;
  uid: EntityUid;
  relationField: 'stores' | 'brands' | 'categories' | 'banks';
  mediaField: 'logo' | 'icon';
  mediaAltField: 'logoAlt' | 'iconAlt';
};

export const ENTITY_DEAL_PAGE_CONFIGS: readonly EntityConfig[] = [
  {
    kind: 'store',
    uid: 'api::store.store',
    relationField: 'stores',
    mediaField: 'logo',
    mediaAltField: 'logoAlt',
  },
  {
    kind: 'brand',
    uid: 'api::brand.brand',
    relationField: 'brands',
    mediaField: 'logo',
    mediaAltField: 'logoAlt',
  },
  {
    kind: 'category',
    uid: 'api::category.category',
    relationField: 'categories',
    mediaField: 'icon',
    mediaAltField: 'iconAlt',
  },
  {
    kind: 'bank',
    uid: 'api::bank.bank',
    relationField: 'banks',
    mediaField: 'logo',
    mediaAltField: 'logoAlt',
  },
] as const;

export const ENTITY_BATCH_SIZE = 1_000;

export const DEAL_BATCH_SIZE = 1_000;

export const SEO_LIMITS = {
  metaTitle: 70,
  metaDescription: 170,
  ogTitle: 95,
  ogDescription: 200,
  ogImageAlt: 125,
} as const;

export const SEO_FIELDS = [
  'indexingEnabled',
  'metaTitle',
  'metaDescription',
  'canonicalUrl',
  'ogTitle',
  'ogDescription',
  'ogImage',
  'ogImageAlt',
] as const;

export const DEAL_FIELDS = [
  'title',
  'cashbackText',
  'bankOfferText',
  'prepaidText',
  'badge',
  'content',
  'code',
  // Load-bearing alongside `code`: the frontend exposes a code only for a
  // KNOWN code type, so omitting this renders every Deal as a no-code offer.
  'couponType',
  'salePrice',
  'mrp',
  'discount',
  'discountPrefix',
  'affiliateLink',
  // Read by the festive-offer walker, which strips it from the response before
  // it reaches the UI (see src/utils/festive-offer-response.ts).
  'checkoutMerchant',
  // Affiliate-brand offers render the BRAND logo in their merchant chip.
  'isForAffiliateBrand',
  // Consumed and removed by arrayizeOfferText after it derives the final
  // Amazon Creator Connections condition.
  AMAZON_AFFILIATE_DISCLOSURE_FIELD,
  'expiresAt',
  'contentStatus',
  'scheduledAt',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'publishedOn',
] as const;

export const ENTITY_FIELDS = [
  'name',
  'slug',
  'description',
  'shortDescription',
  'websiteUrl',
  'isVerified',
  'ratingAverage',
  'ratingCount',
  'createdAt',
  'updatedAt',
] as const;

export type SeoInput = {
  id?: number;
  indexingEnabled?: boolean | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  canonicalUrl?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImage?: unknown;
  ogImageAlt?: string | null;
};

export type ResolvedEntity = {
  config: EntityConfig;
  entity: any;
  publicSlug: string;
  dealSlug: string;
};

export type EntityDealPageIndexBlocker =
  | 'indexing-disabled'
  | 'no-live-deals'
  | 'canonical-not-self'
  | 'route-conflict';

export function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export function collapseText(value: unknown): string | null {
  const text = cleanText(value);
  return text ? text.replace(/\s+/gu, ' ') : null;
}

export function limitText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const clipped = value.slice(0, limit + 1);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace >= Math.floor(limit * 0.65)
    ? clipped.slice(0, lastSpace)
    : value.slice(0, limit)
  ).trimEnd();
}

// Math.trunc, or `page=1.5` yields a fractional offset and a fractional
// pageCount.
export function normalizePage(raw: unknown): number {
  return Math.max(1, Math.trunc(Number(raw)) || 1);
}

export function normalizePageSize(raw: unknown): number {
  return Math.max(
    1,
    Math.min(
      Math.trunc(Number(raw)) || ENTITY_DEAL_PAGE_DEFAULT_PAGE_SIZE,
      ENTITY_DEAL_PAGE_MAX_PAGE_SIZE,
    ),
  );
}

export function configForKind(value: unknown): EntityConfig | null {
  return ENTITY_DEAL_PAGE_CONFIGS.find((config) => config.kind === value) ?? null;
}
