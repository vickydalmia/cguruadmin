// Search CONFIGURATION & PROJECTIONS: the entity registry and the exact
// fields/populates each result kind reads. One of the modules split out of
// the search service (see ./search.ts).
import { publishedOnlyFilters } from "../../../utils/content-status";
import { AMAZON_AFFILIATE_DISCLOSURE_FIELD } from "../../../utils/amazon-affiliate-disclosure";

export type EntityConfig = {
  key: "stores" | "brands" | "categories" | "banks";
  kind: "store" | "brand" | "category" | "bank";
  uid: string;
  mediaField: "logo" | "icon";
};

export const ENTITIES: readonly EntityConfig[] = [
  { key: "stores", kind: "store", uid: "api::store.store", mediaField: "logo" },
  { key: "brands", kind: "brand", uid: "api::brand.brand", mediaField: "logo" },
  {
    key: "categories",
    kind: "category",
    uid: "api::category.category",
    mediaField: "icon",
  },
  { key: "banks", kind: "bank", uid: "api::bank.bank", mediaField: "logo" },
];

const relationRef = (mediaField: "logo" | "icon" = "logo") => ({
  fields:
    mediaField === "logo"
      ? ["name", "slug", "logoAlt"]
      : ["name", "slug", "iconAlt"],
  populate: { [mediaField]: true },
});

export const relations = Object.fromEntries(
  ENTITIES.map((config) => [config.key, relationRef(config.mediaField)]),
) as Record<EntityConfig["key"], ReturnType<typeof relationRef>>;

export const couponPopulate = {
  ...relations,
  logoStore: relationRef("logo"),
};

export const dealPopulate = {
  ...relations,
  dealImage: true,
  logoStore: relationRef("logo"),
};

// Field/populate sets are shared between the query-engine finders and the
// ranked-ID hydration step so both paths emit byte-identical responses.
export const entityFields = (config: EntityConfig) => [
  "name",
  "slug",
  config.mediaField === "logo" ? "logoAlt" : "iconAlt",
];

export const COUPON_FIELDS = [
  "title",
  "code",
  "couponType",
  "affiliateLink",
  "offerCountries",
  // Affiliate-brand offers resolve the BRAND logo/owner in mapOffer.
  "isForAffiliateBrand",
];

export const DEAL_FIELDS = [
  "title",
  "code",
  "couponType",
  "affiliateLink",
  "salePrice",
  "mrp",
  "discount",
  "discountPrefix",
  "expiresAt",
  "offerCountries",
  // Affiliate-brand offers resolve the BRAND logo/owner in mapOffer.
  "isForAffiliateBrand",
  AMAZON_AFFILIATE_DISCLOSURE_FIELD,
  // Feeds the search card's Show Details + redeem-modal bullets, matching
  // every other Deal surface (computed price block + written content).
  "content",
];
