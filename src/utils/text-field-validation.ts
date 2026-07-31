import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import {
  relationKeys,
  resultingRelations,
  type RelationEntry,
} from './deal-of-the-day-validation';

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
 * NOTE ON `slug`: `uid` attributes are excluded entirely. Strapi generates and
 * regex-validates them; rewriting a slug here would change public URLs.
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

  // --- Brand --------------------------------------------------------------
  { uid: BRAND_UID, field: 'name', label: 'Name', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: BRAND_UID, field: 'shortDescription', label: 'Short description', kind: 'text', requiredNonBlank: true },
  { uid: BRAND_UID, field: 'logoAlt', label: 'Logo alt text', kind: 'string', requiredNonBlank: true, collapse: true },
  { uid: BRAND_UID, field: 'websiteUrl', label: 'Website URL', kind: 'string' },

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

export type TextFieldHint = {
  uid: string;
  field: string;
  /** Set when the field lives inside a component (container rules). */
  componentUid?: string;
  hint: string;
};

/** 'api::store.store' → 'stores' — for qualifying shared-component hints. */
const collectionLabel = (uid: string): string => {
  const name = uid.split('.').pop() ?? uid;
  return name.endsWith('y') ? `${name.slice(0, -1)}ies` : `${name}s`;
};

/**
 * Derive the editor-facing hint for one rule. Every enforced behaviour in this
 * file maps to a sentence: requiredNonBlank → "Required…", collapse/trim →
 * what happens to whitespace on save. Container rules are enforced per content
 * type but DISPLAYED on the shared component (visible on every embedding
 * type), so their required-ness is qualified with the type it applies to.
 */
export function textFieldHint(rule: TextFieldRule): string {
  const qualifier = rule.container ? ` for ${collectionLabel(rule.uid)}` : '';
  // Neither carries text, so the trim/collapse sentences below would be
  // meaningless — required-ness is the only thing worth saying.
  if (rule.kind === 'media' || rule.kind === 'number') {
    return rule.requiredNonBlank ? `Required${qualifier}.` : '';
  }
  const parts: string[] = [];
  if (rule.requiredNonBlank) parts.push(`Required${qualifier} — cannot be blank.`);
  if (rule.collapse) parts.push('Extra spaces are removed on save.');
  else if (rule.trim !== false && rule.kind !== 'richtext') {
    parts.push('Surrounding spaces are trimmed on save.');
  }
  return parts.join(' ');
}

/**
 * Editor-facing hints for every rule in this file, derived from the rule table
 * so the shown behaviour can never drift from the enforced one. Consumed by
 * src/index.ts, which pins each hint into the content-manager edit view as the
 * field's grey description (component fields via the component config).
 * hint-coverage.test.ts fails when a rule produces an empty hint.
 */
export function textFieldHints(): TextFieldHint[] {
  return TEXT_FIELD_RULES.map((rule) => ({
    uid: rule.uid,
    field: rule.field,
    ...(rule.container
      ? { componentUid: CONTAINER_COMPONENT_UIDS[rule.container] }
      : {}),
    hint: textFieldHint(rule),
  }));
}

const RULES_BY_UID: Record<string, TextFieldRule[]> = TEXT_FIELD_RULES.reduce(
  (acc, rule) => {
    (acc[rule.uid] ??= []).push(rule);
    return acc;
  },
  {} as Record<string, TextFieldRule[]>
);

/** Offers must be reachable from at least one taxonomy page (row 48). */
export const OFFER_TAXONOMY_KEYS = [
  'stores',
  'banks',
  'categories',
  'brands',
] as const;

const OFFER_UIDS: string[] = [COUPON_UID, DEAL_UID];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Problem = { path: string[]; message: string };

const hasOwn = (obj: unknown, key: string): boolean =>
  !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);

const isWriteAction = (action: string): boolean =>
  action === 'create' || action === 'update' || action === 'clone';

/** Blank = absent, null, or a string that is empty once trimmed. */
export function isBlankText(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

/**
 * Media is blank when absent, null, an empty array, or an empty relation patch
 * (`{ set: [] }` / `{ disconnect: [...] }` with nothing connected) — the shapes
 * the admin sends when an editor clears the image widget.
 */
export function isBlankMedia(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') {
    const patch = value as { set?: unknown; connect?: unknown };
    if (Array.isArray(patch.set)) return patch.set.length === 0;
    if (Array.isArray(patch.connect)) return patch.connect.length === 0;
    return false;
  }
  return false;
}

function storedMediaRelations(value: unknown): RelationEntry[] {
  if (Array.isArray(value)) {
    return value.filter(
      (entry): entry is RelationEntry => relationKeys(entry).length > 0,
    );
  }
  return relationKeys(value).length > 0 ? [value as RelationEntry] : [];
}

/**
 * Resolve relation patches against the stored one-to-one media value. A
 * disconnect-only patch clears the image, while an empty connect patch is a
 * no-op when an image is already attached.
 */
function isBlankMediaAfterWrite(incoming: unknown, stored: unknown): boolean {
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    const patch = incoming as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(patch, 'set') ||
      Object.prototype.hasOwnProperty.call(patch, 'connect') ||
      Object.prototype.hasOwnProperty.call(patch, 'disconnect')
    ) {
      const resolved = resultingRelations(
        incoming,
        storedMediaRelations(stored),
      );
      return resolved !== null && resolved.length === 0;
    }
  }
  return isBlankMedia(incoming);
}

/** Trim, and for `string` kinds collapse internal whitespace runs to a space. */
export function normaliseValue(value: string, rule: TextFieldRule): string {
  let next = value;
  if (rule.collapse && rule.kind === 'string') next = next.replace(/\s+/g, ' ');
  if (rule.trim !== false) next = next.trim();
  return next;
}

/** The container object a rule reads from, or undefined when not in the payload. */
function ruleTarget(data: any, rule: TextFieldRule): any {
  if (!rule.container) return data;
  const container = data[rule.container];
  return container && typeof container === 'object' ? container : undefined;
}

function cloneInheritsRule(data: any, rule: TextFieldRule): boolean {
  if (!data || typeof data !== 'object') return true;
  if (!rule.container) return !hasOwn(data, rule.field);
  if (!hasOwn(data, rule.container)) return true;

  const container = data[rule.container];
  return Boolean(
    container &&
      typeof container === 'object' &&
      !hasOwn(container, rule.field),
  );
}

/** Did this payload touch the field the rule guards? Drives grandfathering. */
function payloadTouches(data: any, rule: TextFieldRule): boolean {
  if (!rule.container) return hasOwn(data, rule.field);
  // On update the admin form replaces a component as a unit, so touching `seo`
  // means every nested key is being (re)written. Clone handling is separate:
  // Strapi deep-merges clone overrides into the source document.
  return hasOwn(data, rule.container);
}

const errorPath = (rule: TextFieldRule): string[] =>
  rule.container ? [rule.container, rule.field] : [rule.field];

function throwProblems(problems: Problem[]): never {
  const noun = problems.length === 1 ? 'problem' : 'problems';
  throw new errors.ValidationError(
    `This entry has ${problems.length} ${noun} (the fields are highlighted ` +
      `in the form):\n• ${problems
        .map((p) => `${p.path.join('.')}: ${p.message}`)
        .join('\n• ')}`,
    {
      // The admin edit view maps details.errors[].path to an inline error on
      // that exact field (same mechanism as the offer/entity validators).
      errors: problems.map((p) => ({
        path: p.path,
        message: p.message,
        name: 'ValidationError',
      })),
      // Flat shape kept for non-admin API consumers.
      problems: problems.map((p) => `${p.path.join('.')}: ${p.message}`),
    }
  );
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Trim (and, for `string` fields only, collapse internal whitespace) every
 * text field present in a write payload. Mutates `data` in place, like
 * sanitizeRichtextData.
 *
 * DECISION (row 99) — trim and save, do NOT reject on leading/trailing
 * whitespace. Rationale:
 *  1. Rejecting punishes an editor for an invisible character they usually did
 *     not type (paste from Sheets/Word almost always carries a trailing space
 *     or NBSP). The error is unactionable because the defect cannot be seen in
 *     the input.
 *  2. Trimming on write is what makes later name-comparison rules possible at
 *     all — "Nike " and "Nike" must not be two different brands.
 *  3. It is idempotent, so re-saving an untouched row is a no-op.
 * A value that is blank AFTER trimming is a different matter and IS rejected,
 * by validateTextFields below — "   " is a genuinely empty required field, not
 * a formatting artefact.
 *
 * Blank-after-trim optional fields are normalised to null rather than "", to
 * keep one representation of empty in the DB (matching cleanHtml). Every
 * schema-`required` text field on these four types is also `requiredNonBlank`
 * here, so this can never hand core a null it would reject with a worse error.
 *
 * `richtext` is never touched: sanitizeRichtextData already trims it and maps
 * empty to null, and collapsing HTML would destroy paragraph breaks.
 */
export function normaliseTextFields(uid: string, action: string, data: any): void {
  if (!isWriteAction(action)) return;
  if (!data || typeof data !== 'object') return;

  for (const rule of RULES_BY_UID[uid] ?? []) {
    if (rule.kind === 'richtext' || rule.kind === 'media' || rule.kind === 'number') continue;

    const target = ruleTarget(data, rule);
    if (!target || !hasOwn(target, rule.field)) continue;

    const value = target[rule.field];
    if (typeof value !== 'string') continue;

    const next = normaliseValue(value, rule);
    target[rule.field] = next === '' ? null : next;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function storedRelationList(stored: any, key: string): RelationEntry[] {
  const value = stored && typeof stored === 'object' ? stored[key] : null;
  return Array.isArray(value) ? (value as RelationEntry[]) : [];
}

/**
 * Row 48 — an offer must sit under at least one taxonomy, or it is orphaned:
 * reachable by direct URL but listed on no store/bank/category/brand page.
 *
 * Relations arrive as a plain array (REST/seed), `{ set }`, or
 * `{ connect, disconnect }` (Content Manager). resultingRelations resolves all
 * three against the stored value; it returns null when the value is not a
 * relation patch at all.
 *
 * Rule 4 in practice: an untouched key contributes its STORED count, never
 * zero. A payload that disconnects every store still passes if the coupon
 * already sits under a category — which is only knowable from the stored row.
 */
function checkOfferTaxonomy(
  uid: string,
  action: string,
  data: any,
  stored: any,
  problems: Problem[],
  strict: boolean
): void {
  if (!OFFER_UIDS.includes(uid)) return;

  const mentioned = OFFER_TAXONOMY_KEYS.filter((key) => hasOwn(data, key));
  // GRANDFATHERING: on update, a payload that says nothing about taxonomies is
  // not making the situation worse — skip, even if the stored row has none.
  // This is also what keeps the contentStatus cron ticking over legacy rows.
  // A strict human write validates the whole effective record, so it never
  // takes this exit — an orphaned untouched offer blocks the save.
  if (!strict && !['create', 'clone'].includes(action) && mentioned.length === 0) return;

  let total = 0;
  let changed =
    action === 'create' ||
    action === 'clone' ||
    !stored ||
    typeof stored !== 'object';
  for (const key of OFFER_TAXONOMY_KEYS) {
    const current = storedRelationList(stored, key);
    if (!hasOwn(data, key)) {
      total += current.length;
      continue;
    }
    const resolved = resultingRelations(data[key], current);
    const next = resolved === null ? current : resolved;
    total += next.length;

    const keys = (entries: readonly RelationEntry[]) =>
      entries
        .flatMap((entry) => relationKeys(entry))
        .sort()
        .join('|');
    if (keys(next) !== keys(current)) changed = true;
  }

  if (total > 0) return;
  // The full Content Manager form re-sends relation arrays. An already
  // orphaned legacy offer remains saveable until the editor actually changes
  // its taxonomy state — unless this is a strict human write, which must clean
  // the whole record.
  if (!strict && !changed) return;

  const label = uid === COUPON_UID ? 'coupon' : 'deal';
  problems.push({
    path: [mentioned[0] ?? 'stores'],
    message:
      `Link this ${label} to at least one Store, Bank, Category or Brand. ` +
      'An offer with no taxonomy is not listed on any page.',
  });
}

/**
 * Validate a store / brand / coupon / deal payload. No-op for any other uid.
 *
 * `stored` is the previously-saved document. Updates use it for taxonomy and
 * grandfathering; clones use it as the merge base for every required field
 * and relation because Strapi applies clone overrides after middleware runs.
 * Pass null on create.
 *
 * STRICT ("clean as you touch"). When `strict` is true — a human admin write,
 * computed once by the middleware via isHumanWrite — EVERY rule is enforced
 * against the whole effective record: fields absent from the payload fall back
 * to their stored value (the clone merge path), and the grandfather escape
 * hatch is disabled, so a blank untouched required field blocks the save. When
 * `strict` is false — the status cron's partial updates — behaviour is
 * UNCHANGED (grandfathered / touched-only) and dirty legacy rows still save.
 *
 * Throws errors.ValidationError listing every problem at once.
 */
export function validateTextFields(
  uid: string,
  action: string,
  data: any,
  stored: any = null,
  strict: boolean = false
): void {
  if (!isWriteAction(action)) return;
  if (!data || typeof data !== 'object') return;
  if (!RULES_BY_UID[uid]) return;

  const problems: Problem[] = [];

  for (const rule of RULES_BY_UID[uid]) {
    if (!rule.requiredNonBlank) continue;

    // Creates/clones are validated in full; updates only where the payload
    // reaches, and a full-form re-send of the same legacy blank is exempt.
    // Strapi merges clone data over the source AFTER document middleware, so
    // an omitted clone field inherits from `stored` rather than being blank.
    // A strict human write validates every field regardless of what it touches.
    if (!strict && !['create', 'clone'].includes(action) && !payloadTouches(data, rule)) continue;

    const target = ruleTarget(data, rule);
    const storedTarget =
      stored && typeof stored === 'object' ? ruleTarget(stored, rule) : undefined;
    // Both clone and strict read the full effective record: a field the payload
    // does not carry inherits its stored value for the blank check.
    const inheritFromStored =
      (action === 'clone' || strict) && cloneInheritsRule(data, rule);
    const value = inheritFromStored
      ? storedTarget?.[rule.field]
      : target?.[rule.field];
    const blank =
      rule.kind === 'media'
        ? inheritFromStored
          ? isBlankMedia(value)
          : isBlankMediaAfterWrite(value, storedTarget?.[rule.field])
        : isBlankText(value);
    if (!blank) continue;

    // Grandfathering: a legacy row whose stored value is already blank stays
    // saveable on a partial (cron) update. Disabled under strict so a human
    // edit cannot leave the record dirty. Reuses the outer `storedTarget`.
    if (!strict && action === 'update' && stored && typeof stored === 'object') {
      const storedValue = storedTarget ? storedTarget[rule.field] : undefined;
      const storedBlank =
        rule.kind === 'media'
          ? isBlankMedia(storedValue)
          : isBlankText(storedValue);
      if (storedBlank) continue;
    }

    problems.push({
      path: errorPath(rule),
      message:
        rule.kind === 'media'
          ? `${rule.label} is required.`
          : `${rule.label} is required and cannot be blank.`,
    });
  }

  checkOfferTaxonomy(uid, action, data, stored, problems, strict);

  if (problems.length) throwProblems(problems);
}

// ---------------------------------------------------------------------------
// Middleware entry point
// ---------------------------------------------------------------------------

/**
 * True when this write needs the stored document fetched. Every clone needs its
 * merge base; updates read only for touched required/taxonomy fields, so the
 * common contentStatus-only cron still costs zero extra queries.
 */
export function requiresStoredRead(
  uid: string,
  action: string,
  data: any,
  strict: boolean = false
): boolean {
  if (action === 'create') return false;
  // Clone middleware receives only the caller's override payload; Strapi
  // merges it over the source document later in the repository layer.
  if (action === 'clone') return Boolean(RULES_BY_UID[uid]);
  if (!data || typeof data !== 'object') return false;
  // A strict human update validates the whole effective record, so any type
  // with rules needs its stored row fetched to supply untouched fields.
  if (strict && RULES_BY_UID[uid]) return true;
  const rulesNeedStored = (RULES_BY_UID[uid] ?? []).some(
    (rule) => rule.requiredNonBlank && payloadTouches(data, rule),
  );
  const taxonomyNeedsStored =
    OFFER_UIDS.includes(uid) &&
    OFFER_TAXONOMY_KEYS.some((key) => hasOwn(data, key));
  return rulesNeedStored || taxonomyNeedsStored;
}

/**
 * Middleware-facing wrapper: fetches the stored document only when a rule
 * actually needs it, then validates. Normalisation is a separate call because
 * it must run BEFORE this one (so "   " is already "" by the time the required
 * check looks at it) and before core's own entity validation.
 */
export async function validateTextFieldsForWrite(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: any,
  documentId?: string,
  strict: boolean = false
): Promise<void> {
  if (!isWriteAction(action)) return;
  if (!data || typeof data !== 'object') return;
  if (!RULES_BY_UID[uid]) return;

  let stored: unknown = null;
  if (documentId && requiresStoredRead(uid, action, data, strict)) {
    const isClone = action === 'clone';
    const rules = (RULES_BY_UID[uid] ?? []).filter(
      (rule) =>
        rule.requiredNonBlank &&
        (strict || isClone || payloadTouches(data, rule)),
    );
    const fields = [
      'documentId',
      ...rules
        .filter((rule) => !rule.container && rule.kind !== 'media')
        .map((rule) => rule.field),
    ];
    const populate: Record<string, unknown> = {};
    for (const rule of rules) {
      if (rule.container) {
        const fieldSet = new Set<string>(
          ((populate[rule.container] as any)?.fields ?? []) as string[],
        );
        fieldSet.add(rule.field);
        populate[rule.container] = { fields: [...fieldSet] };
      } else if (rule.kind === 'media') {
        populate[rule.field] = { fields: ['documentId'] };
      }
    }
    if (
      OFFER_UIDS.includes(uid) &&
      (strict || isClone || OFFER_TAXONOMY_KEYS.some((key) => hasOwn(data, key)))
    ) {
      for (const key of OFFER_TAXONOMY_KEYS) {
        populate[key] = { fields: ['documentId'] };
      }
    }

    stored = await strapi.documents(uid as any).findOne({
      documentId,
      fields: [...new Set(fields)],
      ...(Object.keys(populate).length > 0 ? { populate } : {}),
    } as any);
  }

  validateTextFields(uid, action, data, stored, strict);
}
