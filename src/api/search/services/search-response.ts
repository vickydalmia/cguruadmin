// Search RESPONSE MAPPING: document → public wire shape for entities,
// coupons and deals. One of the modules split out of the search service
// (see ./search.ts).
import { normaliseImageBackgroundColour } from "../../../constants/image-background";
import { withAmazonAffiliateDisclosure } from "../../../utils/amazon-affiliate-disclosure";
import { buildDealComputedContent } from "../../../utils/deal-computed-content";
import { formatDealDiscount } from "../../../utils/deal-discount";
import { type EntityConfig } from "./search-config";

function mediaAlt(
  document: any,
  mediaField: "logo" | "icon",
  fallback: string | null,
): string | null {
  return (
    cleanText(
      mediaField === "icon" ? document?.iconAlt : document?.logoAlt,
      300,
    ) ?? fallback
  );
}

export function cleanText(value: unknown, maxLength = 300): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function safeHref(value: unknown): string | null {
  const href = cleanText(value, 2048);
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function safeEntityHref(slug: unknown): string | null {
  const value = cleanText(slug, 180);
  if (!value) return null;

  const path = value.replace(/^\/+|\/+$/gu, "");
  const segment = "[a-z0-9]+(?:-[a-z0-9]+)*";
  if (!new RegExp(`^${segment}(?:/${segment})*$`, "iu").test(path)) {
    return null;
  }
  return "/" + path + "/";
}

export function mapMedia(media: any, fallbackAlt: string) {
  const src = safeHref(media?.url);
  if (!src) return null;

  // A plain img srcset cannot advertise mixed AVIF and WebP candidates:
  // srcset keeps the universally usable WebP/fallback variants, while the
  // `_avif` twin formats feed the separate avifSrcset (consumed by a
  // <source type="image/avif">, additive — null until twins exist).
  const byWidth = new Map<number, string>();
  const avifByWidth = new Map<number, string>();
  for (const [formatName, format] of Object.entries(
    media?.formats ?? {},
  ) as Array<[string, any]>) {
    const url = safeHref(format?.url);
    const width = Number(format?.width);
    // Integer check matches cguru-ui's isRenderableCandidate so both ladders
    // agree on which candidates count toward the coverage rule.
    if (!url || !Number.isInteger(width) || width <= 0) continue;
    (formatName.endsWith("_avif") ? avifByWidth : byWidth).set(width, url);
  }

  const toSrcset = (candidates: Map<number, string>) =>
    Array.from(candidates.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([width, url]) => url + " " + width + "w")
      .join(", ");

  const srcset = toSrcset(byWidth);

  // The avif <source> shadows the ENTIRE fallback srcset for avif-capable
  // browsers, so a twin ladder whose top rung was dropped by the encoder's
  // size guard would commit them to upscaling its widest candidate into
  // large slots. Same coverage rule as cguru-ui's avifLadderCoversFallback
  // (separate repo — cannot be imported): the avif ladder qualifies only
  // when its max width reaches the fallback ladder's max width; an empty
  // fallback ladder is covered vacuously (twins-only media keeps its avif).
  const maxWidth = (candidates: Map<number, string>) =>
    Math.max(0, ...candidates.keys());
  const avifSrcset =
    avifByWidth.size > 0 && maxWidth(avifByWidth) >= maxWidth(byWidth)
      ? toSrcset(avifByWidth)
      : "";

  return {
    src,
    backgroundColour: normaliseImageBackgroundColour(media?.backgroundColour),
    srcset: srcset || null,
    avifSrcset: avifSrcset || null,
    width: Number(media?.width) > 0 ? Number(media.width) : null,
    height: Number(media?.height) > 0 ? Number(media.height) : null,
    alt: cleanText(media?.alternativeText, 160) ?? fallbackAlt,
  };
}

export function relatedEntities(document: any): any[] {
  // Affiliate-brand offers are owned by their BRAND — never a store — even
  // if a programmatic write left a store attached.
  if (document?.isForAffiliateBrand === true) {
    return Array.isArray(document?.brands) ? document.brands : [];
  }
  return [
    ...(Array.isArray(document?.stores) ? document.stores : []),
    ...(Array.isArray(document?.brands) ? document.brands : []),
    ...(Array.isArray(document?.banks) ? document.banks : []),
    ...(Array.isArray(document?.categories) ? document.categories : []),
  ];
}

// Deals no longer carry a `primaryStore`, so both offer kinds resolve their
// owner the same way: the first related taxonomy entity.
function offerOwner(document: any, _source: "coupon" | "deal") {
  return relatedEntities(document)[0] ?? null;
}

// Coupon cards mirror the site's identity-media rule: the first related
// entity carrying a logo or icon supplies the artwork, even when the owning
// (first) relation has neither. Attribution (name/subtitle/link) stays with
// the owner.
function couponIdentityMedia(document: any): { media: any; alt: string | null } | null {
  // Affiliate-brand offers show their BRAND's logo — never a store's.
  const candidates =
    document?.isForAffiliateBrand === true
      ? [...(Array.isArray(document?.brands) ? document.brands : [])]
      : [
          ...(Array.isArray(document?.stores) ? document.stores : []),
          document?.logoStore,
          ...(Array.isArray(document?.brands) ? document.brands : []),
          ...(Array.isArray(document?.banks) ? document.banks : []),
          ...(Array.isArray(document?.categories) ? document.categories : []),
        ];
  for (const relation of candidates) {
    const media = relation?.logo ?? relation?.icon ?? null;
    if (!media) continue;
    const field = relation?.logo ? "logo" : "icon";
    return {
      media,
      alt: mediaAlt(relation, field, cleanText(relation?.name, 160)),
    };
  }
  return null;
}

export function mapEntity(document: any, config: EntityConfig) {
  const name = cleanText(document?.name, 160);
  const link = safeEntityHref(document?.slug);
  if (!name || !link) return null;

  return {
    id: String(
      document?.documentId ?? document?.id ?? config.kind + ":" + document.slug,
    ),
    name,
    link,
    type: config.kind,
    subtitle: null,
    storeName: config.kind === "store" ? name : null,
    media: mapMedia(
      document?.[config.mediaField],
      mediaAlt(document, config.mediaField, name),
    ),
    price: null,
    originalPrice: null,
    discount: null,
  };
}

// The ranked-SQL path can surface ids as strings; accept both, emit a
// positive safe integer or null.
function numericOfferId(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d{0,14}$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function mapOffer(document: any, type: "coupon" | "deal") {
  const name = cleanText(document?.title, 300);
  if (!name) return null;
  const documentId = cleanText(document?.documentId, 160);
  const dealContent =
    type === "deal" ? withAmazonAffiliateDisclosure(document ?? {}) : null;

  const owner = offerOwner(document, type);
  const ownerName = cleanText(owner?.name, 160);
  const fallbackLink = safeEntityHref(owner?.slug) ?? "/stores/";
  const ownerMedia = owner?.logo ?? owner?.icon ?? null;
  const ownerMediaField = owner?.icon ? "icon" : "logo";
  const ownerAlt = mediaAlt(owner, ownerMediaField, ownerName);
  const identity = type === "coupon" ? couponIdentityMedia(document) : null;
  // Affiliate-brand offers never borrow store artwork; the owner (already
  // brand-first via relatedEntities) supplies the logo.
  const affiliateBrandOffer = document?.isForAffiliateBrand === true;
  const storeWithLogo =
    !affiliateBrandOffer && Array.isArray(document?.stores)
      ? document.stores.find((store: any) => store?.logo)
      : null;
  const storeMedia = storeWithLogo?.logo ?? null;
  const logoStoreMedia = affiliateBrandOffer
    ? null
    : (document?.logoStore?.logo ?? null);
  const displayOwnerMedia = storeMedia ?? logoStoreMedia ?? ownerMedia;
  const displayOwnerAlt = storeMedia
    ? mediaAlt(storeWithLogo, "logo", ownerName ?? name)
    : logoStoreMedia
      ? mediaAlt(document.logoStore, "logo", ownerName ?? name)
      : ownerAlt;

  return {
    id: type + ":" + String(document?.documentId ?? document?.id ?? name),
    documentId,
    name,
    link: safeHref(document?.affiliateLink) ?? fallbackLink,
    type,
    subtitle: ownerName,
    storeName: ownerName,
    // Product-deal cards must never disguise a store logo as product media.
    // Coupon records no longer own media, so their search result draws from
    // the first related entity carrying a logo/icon (site identity-media
    // rule) and otherwise keeps the accessible text fallback.
    media: mapMedia(
      type === "coupon" ? (identity?.media ?? null) : document?.dealImage,
      type === "coupon" ? (identity?.alt ?? ownerName ?? name) : name,
    ),
    price:
      type === "deal" && document?.salePrice != null
        ? String(document.salePrice)
        : null,
    originalPrice:
      type === "deal" && document?.mrp != null ? String(document.mrp) : null,
    discount:
      type === "deal"
        ? cleanText(
            formatDealDiscount(document?.discount, document?.discountPrefix),
            80,
          )
        : null,
    expiresAt:
      type === "deal" ? cleanText(document?.expiresAt, 80) : null,
    // Numeric Strapi id per offer type: the storefront builds the public
    // /deal/:id or /coupon/:id detail URL from it, so a search hit opens its
    // detail page (with the redeem flow) instead of jumping straight to the
    // affiliate link.
    ...(type === "deal"
      ? {
          dealId: numericOfferId(document?.id),
          // Show Details / redeem-modal source material, composed client-side
          // exactly like other Deal cards. Content is CMS richtext already
          // sanitised at write time (sanitizeRichtextData).
          content:
            typeof dealContent === "string" && dealContent.trim()
              ? dealContent
              : null,
          computedContent: buildDealComputedContent(document ?? {}),
        }
      : { couponId: numericOfferId(document?.id) }),
    owner:
      type === "deal" && ownerName
        ? {
            name: ownerName,
            logo: mapMedia(displayOwnerMedia, displayOwnerAlt),
          }
        : null,
    // Both offer types can draw from a pool. Only the MODE ships — never a code
    // and never a pool documentId; the redeem interstitial resolves the pool
    // server-side.
    codeMode:
      document?.couponType === "unique"
        ? "unique"
        : document?.couponType === "static" &&
            Boolean(cleanText(document?.code, 300))
          ? "static"
          : "none",
  };
}

export function toPublicOffer(hit: any) {
  return hit ?? null;
}
