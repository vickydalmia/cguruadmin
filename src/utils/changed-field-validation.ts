import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { cleanHtml } from './sanitize-richtext';

type Problem = { path: string[]; message: string };
type Rule = {
  uid: string;
  path: [string] | ['seo', string];
  valid: (value: unknown) => boolean;
  message: string;
  /**
   * Editor-facing description shown UNDER the field in the admin edit form,
   * before anything is typed (wired into the content-manager metadatas by
   * src/index.ts). Short and imperative; states the constraint, not the error.
   * Required on every rule so a new rule cannot ship without teaching the
   * editor its limit — hint-coverage.test.ts enforces it at runtime too.
   */
  hint: string;
  compare?: (value: unknown) => unknown;
};

export const ENTITY_UIDS = [
  'api::store.store',
  'api::brand.brand',
  'api::category.category',
  'api::bank.bank',
] as const;

export const SEO_UIDS = new Set([
  ...ENTITY_UIDS,
  'api::about-page.about-page',
  'api::career-page.career-page',
  'api::contact-page.contact-page',
  'api::deal-of-the-day-page.deal-of-the-day-page',
  'api::faq-page.faq-page',
  'api::homepage.homepage',
  'api::job.job',
]);

// Taxonomy entities (store/brand/category/bank) may carry DOTTED slugs —
// e.g. a brand slug like `flipkart.in` — so their pattern allows a dot.
const SLUG_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/u;
// Job slugs must NOT contain dots. A job slug becomes the `/careers/<slug>/`
// URL, and its three consumers reject dots: the frontend job-view builder
// (build-career-view.ts), the publicRouteMetadata controller (homepage/
// controllers/custom.ts), and the job schema `regex` (api/job/content-types/
// job/schema.json). This pattern is kept byte-identical to that schema regex
// so validator, schema, sitemap, and canonical all resolve one URL.
const JOB_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const WEBSITE_PATTERN =
  /^https?:\/\/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}(?::\d{2,5})?(?:[/?#][^\s]*)?$/u;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s]+$/iu;
// The path classes exclude backslashes and control characters on top of
// whitespace/`<>?#`: WHATWG URL resolution folds "\" to "/" in http(s)
// contexts, so a canonical of "/\evil.example/" would resolve to
// https://evil.example/ — the same off-site escape the (?!\/) guard blocks for
// "//", spelled with a backslash. A raw control character in a canonical is
// header-splitting material. The host class ([a-zA-Z0-9-] and dots) already
// admits neither.
const CANONICAL_PATTERN =
  /^(?:$|\/(?!\/)[^\s<>?#\\\u0000-\u001f\u007f]*|https?:\/\/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*(?::\d{2,5})?(?:\/[^\s<>?#\\\u0000-\u001f\u007f]*)?)$/u;

const optionalString = (
  predicate: (value: string) => boolean,
): ((value: unknown) => boolean) =>
  (value) =>
    value === undefined ||
    value === null ||
    value === '' ||
    (typeof value === 'string' && predicate(value));

const maxLength = (max: number) =>
  optionalString((value) => value.length <= max);

const minLength = (min: number) =>
  optionalString((value) => value.length >= min);

const topRule = (
  uid: string,
  field: string,
  valid: Rule['valid'],
  message: string,
  hint: string,
  compare?: Rule['compare'],
): Rule => ({
  uid,
  path: [field],
  valid,
  message,
  hint,
  compare,
});

const TOP_LEVEL_RULES: Rule[] = [
  topRule(
    'api::store.store',
    'name',
    optionalString((value) => !/[<>]/u.test(value)),
    'Name cannot contain angle brackets (< or >).',
    'No angle brackets (< or >).',
  ),
  ...ENTITY_UIDS.map((uid) =>
    topRule(
      uid,
      'slug',
      optionalString((value) => SLUG_PATTERN.test(value)),
      'Slug may contain lowercase letters, numbers, hyphens and dots only.',
      'Lowercase letters, numbers, hyphens and dots only.',
    ),
  ),
  topRule(
    'api::job.job',
    'slug',
    optionalString((value) => JOB_SLUG_PATTERN.test(value)),
    'Slug may contain lowercase letters, numbers and hyphens only.',
    'Lowercase letters, numbers and hyphens only.',
  ),
  ...ENTITY_UIDS.map((uid) =>
    topRule(
      uid,
      'shortDescription',
      minLength(160),
      'Short description must be at least 160 characters.',
      'At least 160 characters.',
    ),
  ),
  ...ENTITY_UIDS.map((uid) =>
    topRule(
      uid,
      'websiteUrl',
      optionalString((value) => WEBSITE_PATTERN.test(value)),
      'Website URL must be a complete http(s) address with a valid domain.',
      'Complete http(s) address with a valid domain.',
    ),
  ),
  ...['api::coupon.coupon', 'api::deal.deal'].map((uid) =>
    topRule(
      uid,
      'title',
      maxLength(200),
      'Title must be at most 200 characters.',
      'Up to 200 characters.',
    ),
  ),
  topRule(
    'api::coupon.coupon',
    'code',
    maxLength(64),
    'Code must be at most 64 characters.',
    'Up to 64 characters.',
  ),
  ...['api::coupon.coupon', 'api::deal.deal'].map((uid) =>
    topRule(
      uid,
      'affiliateLink',
      optionalString((value) => HTTP_URL_PATTERN.test(value)),
      'Affiliate link must be a complete http(s) URL without spaces.',
      'Complete http(s) URL with no spaces.',
    ),
  ),
  topRule(
    'api::deal.deal',
    'content',
    maxLength(50_000),
    'Content must be at most 50,000 characters.',
    'Up to 50,000 characters.',
    (value) => (typeof value === 'string' ? cleanHtml(value) : value),
  ),
  ...['salePrice', 'mrp'].map((field) =>
    topRule(
      'api::deal.deal',
      field,
      (value) => {
        if (value === undefined || value === null || value === '') return true;
        const number = Number(value);
        return Number.isFinite(number) && number >= 0;
      },
      `${field === 'mrp' ? 'MRP' : 'Sale price'} cannot be negative.`,
      'Cannot be negative.',
      (value) => {
        if (value === undefined || value === null || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : value;
      },
    ),
  ),
];

const SEO_RULES: Omit<Rule, 'uid'>[] = [
  {
    path: ['seo', 'metaTitle'],
    valid: maxLength(70),
    message: 'SEO title must be at most 70 characters.',
    hint: 'Up to 70 characters.',
  },
  {
    path: ['seo', 'metaDescription'],
    valid: maxLength(170),
    message: 'SEO description must be at most 170 characters.',
    hint: 'Up to 170 characters.',
  },
  {
    path: ['seo', 'canonicalUrl'],
    valid: optionalString((value) => CANONICAL_PATTERN.test(value)),
    message:
      'Canonical URL must be a root-relative path or a complete http(s) URL, without a query or fragment.',
    hint:
      'Site path (e.g. /nike/) or complete http(s) URL — no query or fragment.',
  },
  {
    path: ['seo', 'ogTitle'],
    valid: maxLength(95),
    message: 'Open Graph title must be at most 95 characters.',
    hint: 'Up to 95 characters.',
  },
  {
    path: ['seo', 'ogDescription'],
    valid: maxLength(200),
    message: 'Open Graph description must be at most 200 characters.',
    hint: 'Up to 200 characters.',
  },
  {
    path: ['seo', 'ogImageAlt'],
    valid: maxLength(125),
    message: 'Open Graph image alt text must be at most 125 characters.',
    hint: 'Up to 125 characters.',
  },
];

/** Component uid the ['seo', …] rule paths resolve to on every embedding type. */
export const SEO_COMPONENT_UID = 'shared.seo';

export type FieldHint = { uid: string; field: string; hint: string };
export type ComponentFieldHint = {
  componentUid: string;
  field: string;
  hint: string;
};

/**
 * Editor-facing hints for every TOP-LEVEL rule in this file, derived straight
 * from the rule table so the shown limit can never drift from the enforced
 * one. Consumed by src/index.ts, which pins each hint into the content-manager
 * edit view as the field's grey description.
 */
export function changedFieldHints(): FieldHint[] {
  return TOP_LEVEL_RULES.map((rule) => ({
    uid: rule.uid,
    field: rule.path[0],
    hint: rule.hint,
  }));
}

/**
 * Hints for the shared.seo component rules. The component is embedded by nine
 * content types and its metadatas are stored once per COMPONENT, so these are
 * declared against SEO_COMPONENT_UID and show under the field everywhere the
 * component is edited — which matches how the rules are enforced.
 */
export function changedFieldSeoHints(): ComponentFieldHint[] {
  return SEO_RULES.map((rule) => ({
    componentUid: SEO_COMPONENT_UID,
    field: rule.path[1] as string,
    hint: rule.hint,
  }));
}

function rulesFor(uid: string): Rule[] {
  const rules = TOP_LEVEL_RULES.filter((rule) => rule.uid === uid);
  if (SEO_UIDS.has(uid)) {
    rules.push(...SEO_RULES.map((rule) => ({ ...rule, uid })));
  }
  return rules;
}

function hasOwn(value: unknown, key: string): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      Object.prototype.hasOwnProperty.call(value, key),
  );
}

function valueAt(data: unknown, path: Rule['path']): unknown {
  if (!data || typeof data !== 'object') return undefined;
  const first = Reflect.get(data, path[0]);
  if (path.length === 1) return first;
  return first && typeof first === 'object'
    ? Reflect.get(first, path[1])
    : undefined;
}

function cloneValueAt(
  data: unknown,
  stored: unknown,
  path: Rule['path'],
): unknown {
  if (path.length === 1) {
    return hasOwn(data, path[0]) ? valueAt(data, path) : valueAt(stored, path);
  }

  if (!hasOwn(data, path[0])) return valueAt(stored, path);
  const container = valueAt(data, [path[0]]);
  if (!container || typeof container !== 'object') return valueAt(data, path);
  return hasOwn(container, path[1])
    ? valueAt(data, path)
    : valueAt(stored, path);
}

function payloadTouches(data: unknown, path: Rule['path']): boolean {
  // Components are replaced as a unit. If `seo` is present, omission of one
  // nested key is itself a write (it clears that key).
  return hasOwn(data, path[0]);
}

function comparisonValue(rule: Rule, value: unknown): unknown {
  const compared = rule.compare ? rule.compare(value) : value;
  return compared === undefined || compared === '' ? null : compared;
}

function sameValue(rule: Rule, left: unknown, right: unknown): boolean {
  return Object.is(
    comparisonValue(rule, left),
    comparisonValue(rule, right),
  );
}

export function isValidCanonicalUrl(value: unknown): boolean {
  return optionalString((candidate) => CANONICAL_PATTERN.test(candidate))(value);
}

/**
 * Validate constraints that cannot safely live in a Strapi schema on a
 * populated database. Schema validators see the admin's full PUT and cannot
 * distinguish an untouched legacy value from a newly introduced defect.
 * This validator reads the stored row and only applies each rule on create,
 * clone, or an actual value change.
 *
 * STRICT ("clean as you touch"). When `strict` is true — a human admin write,
 * as computed once by the middleware via isHumanWrite — every rule is enforced
 * against the WHOLE effective record (payload merged over the stored row,
 * exactly as the clone path already does), and the grandfather escape hatch is
 * disabled, so a dirty untouched field blocks the save. When `strict` is false
 * — the status cron's partial updates — behaviour is UNCHANGED (grandfathered /
 * touched-only), so the cron keeps flipping statuses over dirty legacy rows.
 */
export async function validateChangedFields(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
  documentId?: string,
  strict: boolean = false,
): Promise<void> {
  if (!['create', 'update', 'clone'].includes(action)) return;
  if (!data || typeof data !== 'object') return;

  const isClone = action === 'clone';
  // strict and clone share the same "validate the full effective record"
  // machinery: read every rule's value from the payload merged over stored,
  // with no grandfathering.
  const effective = strict || isClone;
  const rules = rulesFor(uid).filter(
    (rule) => strict || isClone || payloadTouches(data, rule.path),
  );
  if (rules.length === 0) return;

  const isFreshCreate = action === 'create' || !documentId;
  let stored: unknown = null;

  if (!isFreshCreate) {
    const fields = [
      'documentId',
      ...rules
        .filter((rule) => rule.path.length === 1)
        .map((rule) => rule.path[0]),
    ];
    const seoFields = rules
      .filter((rule) => rule.path[0] === 'seo')
      .map((rule) => rule.path[1]);

    stored = await strapi.documents(uid as any).findOne({
      documentId,
      fields: [...new Set(fields)] as any,
      ...(seoFields.length > 0
        ? {
            populate: {
              seo: { fields: [...new Set(seoFields)] },
            } as any,
          }
      : {}),
    });
  }
  if (isClone && documentId && !stored) return;

  const problems: Problem[] = [];
  for (const rule of rules) {
    const incoming = effective
      ? cloneValueAt(data, stored, rule.path)
      : valueAt(data, rule.path);
    if (rule.valid(incoming)) continue;

    // Grandfather an unchanged legacy value on a non-strict update only. Strict
    // human writes must clean the whole record, so the escape hatch is off.
    if (
      !effective &&
      action === 'update' &&
      stored &&
      sameValue(rule, incoming, valueAt(stored, rule.path))
    ) {
      continue;
    }
    problems.push({ path: rule.path, message: rule.message });
  }

  if (problems.length === 0) return;
  const noun = problems.length === 1 ? 'problem' : 'problems';
  throw new errors.ValidationError(
    `This entry has ${problems.length} field ${noun} (the fields are highlighted ` +
      `in the form):\n• ${problems
        .map((problem) => `${problem.path.join('.')}: ${problem.message}`)
        .join('\n• ')}`,
    {
      errors: problems.map((problem) => ({
        path: problem.path,
        message: problem.message,
        name: 'ValidationError',
      })),
      problems: problems.map(
        (problem) => `${problem.path.join('.')}: ${problem.message}`,
      ),
    },
  );
}
