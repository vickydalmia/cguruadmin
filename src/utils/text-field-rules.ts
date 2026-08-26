/**
 * Blank-reject / trim / required-field enforcement for store, brand, coupon
 * and deal.
 *
 * WHY THIS EXISTS (verified in
 * node_modules/@strapi/core/dist/services/entity-validator/index.js):
 *
 *   const addRequiredValidation = (createOrUpdate) => {
 *     return (validator, { attr: { required } }) => {
 *       let nextValidator = validator;
 *       if (required) {
 *         if (createOrUpdate === 'creation')   nextValidator = nextValidator.notNil();
 *         else if (createOrUpdate === 'update') nextValidator = nextValidator.notNull();
 *       } else { nextValidator = nextValidator.nullable(); }
 *       return nextValidator;
 *     };
 *   };
 *
 * `required: true` therefore compiles to `.notNil()` on create and only
 * `.notNull()` on update — and the string validator itself is a bare
 * `yup.string().transform(...)` with no `.required()` (validators.js:285).
 * yup's `notNil`/`notNull` reject null/undefined and NOTHING else, so `""` and
 * `"   "` sail straight through on every content type. No schema key can
 * express "not blank"; it has to be a lifecycle rule, which is this file.
 *
 * (Two further core details worth knowing: on UPDATE `required` degrades to
 * `.notNull()`, so an omitted required field is legal — which is what makes
 * partial cron updates work at all; and required is skipped entirely for
 * drafts via `!isDraft && attr.required`. All four content types here set
 * `draftAndPublish: false`, so the draft escape hatch never applies to them.)
 *
 * GRANDFATHERING. This lands on a populated production DB with no cleanup
 * pass. Every rule below fires only when the incoming payload actually touches
 * the field, or on create. An editor opening a legacy row to fix a typo in one
 * field is never blocked by a different field they did not touch — even when
 * the stored value is invalid.
 *
 * PARTIAL PAYLOADS. `context.params.data` is partial on update: the content
 * cron issues `update({ data: { contentStatus } })` and nothing else. Nothing
 * here derives a value from the payload alone; the one rule that needs the
 * whole picture (taxonomy cardinality) merges the payload over the stored row.
 *
 * Errors use the ValidationError shape the rest of src/utils uses —
 * `details.errors[].path` as a string array — so the admin renders an inline
 * error on the exact field instead of an unmappable 500.
 */

// ---------------------------------------------------------------------------
// Rule table
// ---------------------------------------------------------------------------

/**
 * `string`   — single-line admin input. Safe to collapse internal whitespace.
 * `text`     — multi-line textarea. Trim only; collapsing would destroy the
 *              paragraph breaks that render on the live site.
 * `richtext` — HTML. Never touched here; sanitizeRichtextData already trims it
 *              and maps empty to null, and collapsing HTML would be a visible
 *              content regression. Listed only so it can be required.
 * `media`    — presence check only.
 * `number`   — presence check only (decimal/integer attributes). Never
 *              normalised: there is no whitespace to trim, and 0 is a real
 *              value, so only null/undefined/"" count as missing.
 */
export type TextFieldKind = 'string' | 'text' | 'richtext' | 'media' | 'number';

export type TextFieldRule = {
  uid: string;
  /** Top-level attribute name, or the field inside `container` when set. */
  field: string;
  label: string;
  kind: TextFieldKind;
  /** Component the field lives in, e.g. 'seo' → path ['seo', 'metaTitle']. */
  container?: string;
  /** Reject null / undefined / "" / "   " when the payload touches it. */
  requiredNonBlank?: boolean;
  /** Strip leading + trailing whitespace. Default true for string/text. */
  trim?: boolean;
  /** Collapse internal whitespace runs to one space. `string` kind ONLY. */
  collapse?: boolean;
};

export const COUPON_UID = 'api::coupon.coupon';
export const DEAL_UID = 'api::deal.deal';
export const STORE_UID = 'api::store.store';
export const BRAND_UID = 'api::brand.brand';
export const CATEGORY_UID = 'api::category.category';
export const BANK_UID = 'api::bank.bank';

export const TEXT_FIELD_UIDS = [
  COUPON_UID,
  DEAL_UID,
  STORE_UID,
  BRAND_UID,
  CATEGORY_UID,
  BANK_UID,
] as const;

/**
 * NOTE ON `collapse`: enabled only for short display strings that feed
 * fixed-size card slots. Deliberately OFF for `code` (a coupon code with an
 * internal space is data, not formatting) and for `websiteUrl` (trim fixes the
 * real-world paste artefact; collapsing a URL is meaningless). Never available
 * to `text`/`richtext` — `assertCollapseIsStringOnly` below enforces that at
 * module load so a future edit cannot quietly regress it.
 *
 * NOTE ON `slug`: excluded entirely. Slugs are plain `string` attributes whose
 * schema `regex` already rejects leading/trailing/inner whitespace, and
 * rewriting a slug here would change public URLs.
 *
 * NOTE ON BRAND: brand's SEO requiredness is already owned by
 * checkBrandRequired in entity-field-validation.ts and is NOT duplicated here —
 * listing it in both places would report the same blank field twice. Store,
 * category and bank have no such counterpart, so their SEO rules live here.
 * Brand `logo` keeps its schema-level `required: true` (media + notNil/notNull
 * is sufficient for a relation-like attribute). Brand `shortDescription` IS
 * listed, because its schema `required: true` does not catch "".
 *
 * NOTE ON WEBSITE URL: `websiteUrl` is optional on all four taxonomy types.
 * Keep it in this table so pasted values are trimmed consistently; the URL
 * shape validator in changed-field-validation.ts still rejects malformed
 * non-empty values.
 */
export const TEXT_FIELD_RULES: readonly TextFieldRule[] = [
  // --- Coupon -------------------------------------------------------------
  { uid: COUPON_UID, field: 'title', label: 'Title', kind: 'string', requiredNonBlank: true, collapse: true },
  // Row 46 — coupon must carry its description.
  { uid: COUPON_UID, field: 'content', label: 'Content', kind: 'richtext', requiredNonBlank: true },
  // Row 70 — a coupon with no outbound link is dead weight on the site.
  { uid: COUPON_UID, field: 'affiliateLink', label: 'Affiliate link', kind: 'text', requiredNonBlank: true },
  // offerText is the headline on every coupon card — blank leaves the card
  // with nothing to say.
  { uid: COUPON_UID, field: 'offerText', label: 'Offer text', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: COUPON_UID, field: 'cashbackText', label: 'Cashback text', kind: 'string', collapse: true },
  { uid: COUPON_UID, field: 'bankOfferText', label: 'Bank offer text', kind: 'string', collapse: true },
  { uid: COUPON_UID, field: 'prepaidText', label: 'Prepaid text', kind: 'string', collapse: true },
  { uid: COUPON_UID, field: 'code', label: 'Code', kind: 'string' },

  // --- Deal ---------------------------------------------------------------
  { uid: DEAL_UID, field: 'title', label: 'Title', kind: 'string', requiredNonBlank: true, collapse: true },
  // Row 82 — same reasoning as the coupon link.
  { uid: DEAL_UID, field: 'affiliateLink', label: 'Affiliate link', kind: 'text', requiredNonBlank: true },
  // Deal `content` carries no row here on purpose: it is OPTIONAL (the public
  // API always sends a pre-calculated price/MRP/discount block — see
  // src/utils/deal-computed-content.ts — and written content is only the extra
  // "Any Other Condition" section), and an optional richtext rule would
  // enforce nothing. Its editor hint lives in VALIDATOR_MIRROR_HINTS.
  // Prices are optional display data. Their non-negative validation and editor
  // hints live in changed-field-validation.ts; they do not belong in this
  // required/blank-field table. `dealImage` is NOT listed because it already
  // carries schema `required: true` (same reasoning as brand.logo above).
  { uid: DEAL_UID, field: 'cashbackText', label: 'Cashback text', kind: 'string', collapse: true },
  { uid: DEAL_UID, field: 'bankOfferText', label: 'Bank offer text', kind: 'string', collapse: true },
  { uid: DEAL_UID, field: 'prepaidText', label: 'Prepaid text', kind: 'string', collapse: true },
  { uid: DEAL_UID, field: 'discount', label: 'Discount', kind: 'string', collapse: true },
  { uid: DEAL_UID, field: 'code', label: 'Code', kind: 'text' },

  // --- Store --------------------------------------------------------------
  { uid: STORE_UID, field: 'name', label: 'Name', kind: 'string', requiredNonBlank: true, collapse: true },
  // Row 93 — store cards render shortDescription; blank leaves a hole.
  { uid: STORE_UID, field: 'shortDescription', label: 'Short description', kind: 'text', requiredNonBlank: true },
  // Row 94 — store logo has no schema-level `required`, unlike brand's.
  { uid: STORE_UID, field: 'logo', label: 'Logo', kind: 'media', requiredNonBlank: true },
  { uid: STORE_UID, field: 'metaTitle', label: 'SEO title', kind: 'string', container: 'seo', requiredNonBlank: true, collapse: true },
  { uid: STORE_UID, field: 'metaDescription', label: 'SEO description', kind: 'text', container: 'seo', requiredNonBlank: true },
  // Alt text is the accessible name for the logo — a missing one ships an
  // unlabelled image to every store card and page header.
  { uid: STORE_UID, field: 'logoAlt', label: 'Logo alt text', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: STORE_UID, field: 'websiteUrl', label: 'Website URL', kind: 'string' },
  // Festive offer title/description are CONDITIONALLY required — only when
  // `isFestiveOffer` is on — which this table cannot express, so their
  // requiredness lives in entity-field-validation.ts (checkFestiveOffer). The
  // row here exists purely so a pasted title is trimmed and collapsed like
  // every other short display string before the 60-character cap counts it.
  { uid: STORE_UID, field: 'festiveOfferTitle', label: 'Festive offer title', kind: 'string', collapse: true },

  // --- Brand --------------------------------------------------------------
  { uid: BRAND_UID, field: 'name', label: 'Name', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: BRAND_UID, field: 'shortDescription', label: 'Short description', kind: 'text', requiredNonBlank: true },
  { uid: BRAND_UID, field: 'logoAlt', label: 'Logo alt text', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: BRAND_UID, field: 'websiteUrl', label: 'Website URL', kind: 'string' },
  // Same reasoning as the Store row above.
  { uid: BRAND_UID, field: 'festiveOfferTitle', label: 'Festive offer title', kind: 'string', collapse: true },

  // --- Category -----------------------------------------------------------
  // Category's media field is `icon`, not `logo`, and `iconAlt` was added
  // alongside these rules — categories previously had no alt text at all.
  { uid: CATEGORY_UID, field: 'name', label: 'Name', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: CATEGORY_UID, field: 'shortDescription', label: 'Short description', kind: 'text', requiredNonBlank: true },
  { uid: CATEGORY_UID, field: 'icon', label: 'Icon', kind: 'media', requiredNonBlank: true },
  { uid: CATEGORY_UID, field: 'iconAlt', label: 'Icon alt text', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: CATEGORY_UID, field: 'websiteUrl', label: 'Website URL', kind: 'string' },
  { uid: CATEGORY_UID, field: 'metaTitle', label: 'SEO title', kind: 'string', container: 'seo', requiredNonBlank: true, collapse: true },
  { uid: CATEGORY_UID, field: 'metaDescription', label: 'SEO description', kind: 'text', container: 'seo', requiredNonBlank: true },

  // --- Bank ---------------------------------------------------------------
  { uid: BANK_UID, field: 'name', label: 'Name', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: BANK_UID, field: 'shortDescription', label: 'Short description', kind: 'text', requiredNonBlank: true },
  { uid: BANK_UID, field: 'logo', label: 'Logo', kind: 'media', requiredNonBlank: true },
  { uid: BANK_UID, field: 'logoAlt', label: 'Logo alt text', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: BANK_UID, field: 'websiteUrl', label: 'Website URL', kind: 'string' },
  { uid: BANK_UID, field: 'metaTitle', label: 'SEO title', kind: 'string', container: 'seo', requiredNonBlank: true, collapse: true },
  { uid: BANK_UID, field: 'metaDescription', label: 'SEO description', kind: 'text', container: 'seo', requiredNonBlank: true },
];

/**
 * Collapsing a `text` or `richtext` field would destroy paragraph breaks and
 * show up as a live-site content regression. Fail loudly at import time rather
 * than let a bad table entry ship.
 */
function assertCollapseIsStringOnly(rules: readonly TextFieldRule[]): void {
  const bad = rules.filter((rule) => rule.collapse && rule.kind !== 'string');
  if (bad.length) {
    throw new Error(
      'text-field-validation: `collapse` is only valid on kind "string" ' +
        `(offending: ${bad.map((r) => `${r.uid}.${r.field}`).join(', ')}).`
    );
  }
}
assertCollapseIsStringOnly(TEXT_FIELD_RULES);

/**
 * Component uid per `container` value — a container rule's field lives inside
 * this component, and the admin stores component metadatas once per COMPONENT
 * (not per embedding type), so its hint must be declared against this uid.
 */
export const CONTAINER_COMPONENT_UIDS: Record<string, string> = {
  seo: 'shared.seo',
};
