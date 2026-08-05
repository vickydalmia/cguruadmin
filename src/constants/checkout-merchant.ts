/**
 * Checkout Merchant — the ONE Store or Brand a shopper actually checks out
 * with, chosen from a single dropdown that lists both.
 *
 * WHY THIS IS A CUSTOM FIELD AND NOT A RELATION
 * ---------------------------------------------
 * A Strapi relation targets exactly one content type, so "Stores and Brands in
 * the same dropdown" cannot be expressed as one relation attribute. The three
 * ways out, and why this one:
 *
 *   - Two relations (checkoutStore + checkoutBrand) driven by one merged
 *     picker. Keeps foreign keys, but the merged picker can only live in a
 *     side panel: `@strapi/content-manager` exposes no injection zone inside
 *     the main edit form (INJECTION_ZONES only has editView.informations and
 *     editView['right-links'], both sidebar), and overriding the whole
 *     `relation` input type via app.addFields would re-render EVERY relation
 *     field in the admin through a component we would have to reimplement —
 *     the stock RelationsInput is not exported from the package's `exports`
 *     map, so it cannot even be delegated to.
 *   - A custom field. The ONLY supported seam that renders in the main edit
 *     form, and it is scoped to this one attribute. This is what we use.
 *
 * The cost is the missing foreign key, and it is paid back explicitly:
 *   - checkout-merchant-validation.ts rejects a write whose target does not
 *     exist, so a bad reference never lands;
 *   - clearDeletedCheckoutMerchant() (same file) nulls every reference to a
 *     Store or Brand as it is deleted, so one never goes dangling afterwards.
 *
 * STORED FORM: `<kind>:<documentId>` — e.g. `store:abc123…`, `brand:xyz789…`.
 * A single string column, so it is trivially readable, indexable and
 * greppable, and `parseCheckoutMerchant` is the one place that knows the shape.
 *
 * Imported by BOTH halves of the app (the server pipeline and the admin
 * bundle), which is why it lives in src/constants alongside the homepage
 * section tables rather than in src/utils.
 */

/** Attribute name on both offer schemas. */
export const CHECKOUT_MERCHANT_FIELD = 'checkoutMerchant';

/**
 * Registered with no plugin on either side, so both registries derive the same
 * `global::` uid — server: registries/custom-fields.js, admin:
 * core/apis/CustomFields.mjs. The schema.json `customField` key must match
 * CHECKOUT_MERCHANT_CUSTOM_FIELD_UID exactly or boot fails in
 * convertCustomFieldType with "Could not find Custom Field".
 */
export const CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME = 'checkout-merchant';
export const CHECKOUT_MERCHANT_CUSTOM_FIELD_UID = `global::${CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME}`;

/** Content types that carry the field. Both offer types, per the brief. */
export const CHECKOUT_MERCHANT_OFFER_UIDS = [
  'api::coupon.coupon',
  'api::deal.deal',
] as const;

export type CheckoutMerchantOfferUid =
  (typeof CHECKOUT_MERCHANT_OFFER_UIDS)[number];

export function isCheckoutMerchantOfferUid(
  uid: unknown,
): uid is CheckoutMerchantOfferUid {
  return CHECKOUT_MERCHANT_OFFER_UIDS.includes(
    uid as CheckoutMerchantOfferUid,
  );
}

export type CheckoutMerchantKind = 'store' | 'brand';

/**
 * The two option groups, in the order the dropdown renders them. Order is
 * load-bearing for the picker: it appends each source's page independently
 * rather than re-sorting the merged list, so a "load more" never reshuffles
 * rows the editor is already looking at.
 */
export const CHECKOUT_MERCHANT_SOURCES = [
  {
    kind: 'store',
    label: 'Store',
    target: 'api::store.store',
  },
  {
    kind: 'brand',
    label: 'Brand',
    target: 'api::brand.brand',
  },
] as const satisfies ReadonlyArray<{
  kind: CheckoutMerchantKind;
  label: string;
  target: string;
}>;

export type CheckoutMerchantSource = (typeof CHECKOUT_MERCHANT_SOURCES)[number];

export type CheckoutMerchantRef = {
  kind: CheckoutMerchantKind;
  documentId: string;
};

/**
 * `store:` + a Strapi 5 documentId. The cap exists so a hand-crafted API write
 * cannot push an unbounded string into the column; the real shape check is the
 * pattern below.
 */
export const CHECKOUT_MERCHANT_MAX_LENGTH = 64;

/**
 * Strapi 5 mints documentIds as lowercase alphanumeric ids, but rows migrated
 * from WordPress carry whatever the importer assigned — stay permissive on the
 * charset and strict on the delimiter, which is the part this format depends
 * on. No colon inside the id, so the split below is unambiguous.
 */
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,55}$/u;

export function checkoutMerchantSource(
  kind: CheckoutMerchantKind,
): CheckoutMerchantSource {
  const source = CHECKOUT_MERCHANT_SOURCES.find(
    (candidate) => candidate.kind === kind,
  );
  if (!source) throw new Error(`Unknown checkout merchant kind: ${kind}`);
  return source;
}

export function formatCheckoutMerchant(ref: CheckoutMerchantRef): string {
  return `${ref.kind}:${ref.documentId}`;
}

/**
 * Parse a stored value. Returns null for anything that is not a well-formed
 * reference — including empty/blank, which callers read as "no merchant set".
 * Never throws: the validator turns a null-from-non-blank into an editor-facing
 * problem, and every other caller treats null as absent.
 */
export function parseCheckoutMerchant(value: unknown): CheckoutMerchantRef | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const separator = trimmed.indexOf(':');
  if (separator < 1) return null;

  const kind = trimmed.slice(0, separator);
  const documentId = trimmed.slice(separator + 1);

  if (kind !== 'store' && kind !== 'brand') return null;
  if (!DOCUMENT_ID_PATTERN.test(documentId)) return null;

  return { kind, documentId };
}

/** True when the payload value means "no merchant" rather than a bad one. */
export function isBlankCheckoutMerchant(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  );
}
