// Entity Deal-page SEO: resolution of the effective SEO block and
// validation/normalisation of settings-screen SEO patches. One of the
// modules split out of the entity-deal-page service (see
// ./entity-deal-page.ts).
import { errors } from '@strapi/utils';
import {
  CANONICAL_PATH_RULE,
  normalizeCanonicalPath,
} from '../../../utils/canonical-path';
import { isMediaRef } from '../../../utils/entity-deal-page-seo-validation';
import {
  SEO_FIELDS,
  SEO_LIMITS,
  cleanText,
  collapseText,
  limitText,
  type EntityConfig,
  type EntityDealPageIndexBlocker,
  type SeoInput,
} from './entity-deal-page-config';
import { entityDealPagePath } from './entity-deal-route';

// Shared with the write-time validator so the read path can never accept a
// value the validator would have rejected, or vice versa.
const canonicalPath = normalizeCanonicalPath;

export function resolveEntityDealPageSeo(input: {
  entity: any;
  publicSlug: string;
  liveDealCount: number;
  routeConflict?: boolean;
}) {
  const { entity, publicSlug, liveDealCount } = input;
  const seo = entity?.entityDealPageSeo ?? {};
  const displayName =
    collapseText(entity?.name) ?? collapseText(publicSlug) ?? publicSlug;
  const selfCanonical = entityDealPagePath(entity?.name);
  if (!selfCanonical) {
    throw new Error('Entity name cannot produce a Product Deal page route.');
  }
  const authoredCanonical = canonicalPath(seo?.canonicalUrl);
  const canonical = authoredCanonical ?? selfCanonical;
  const blockers: EntityDealPageIndexBlocker[] = [];

  if (seo?.indexingEnabled !== true) blockers.push('indexing-disabled');
  if (liveDealCount <= 0) blockers.push('no-live-deals');
  if (canonical !== selfCanonical) blockers.push('canonical-not-self');
  if (input.routeConflict === true) blockers.push('route-conflict');

  // Share-card image: ONLY an editor-uploaded seo.ogImage. Logos/icons are
  // small and far off the ~1.91:1 card ratio; when absent the UI layout serves
  // its 1200×630 site-default card instead.
  const ogImage = seo?.ogImage ?? null;
  const metaTitle = limitText(
    collapseText(seo?.metaTitle) ?? `${displayName} Deals & Offers`,
    SEO_LIMITS.metaTitle,
  );
  const metaDescription = limitText(
    cleanText(seo?.metaDescription)
      ?? `Discover the latest ${displayName} product deals, prices and offers on CouponzGuru.`,
    SEO_LIMITS.metaDescription,
  );

  return {
    metaTitle,
    metaDescription,
    canonical,
    indexingEnabled: seo?.indexingEnabled === true,
    effectiveIndexable: blockers.length === 0,
    noIndex: blockers.length > 0,
    blockers,
    ogTitle: limitText(
      collapseText(seo?.ogTitle) ?? metaTitle,
      SEO_LIMITS.ogTitle,
    ),
    ogDescription: limitText(
      cleanText(seo?.ogDescription) ?? metaDescription,
      SEO_LIMITS.ogDescription,
    ),
    ogImage,
    // Alt must describe the image actually shipped: with no editor ogImage
    // both stay null and the UI default card supplies its own alt.
    ogImageAlt: ogImage
      ? (collapseText(seo?.ogImageAlt)
        ?? collapseText(ogImage?.alternativeText)
        ?? displayName)
      : null,
  };
}

/**
 * True when the normalized patch differs from what is already stored.
 *
 * `ogImage` is compared by id: the stored value is a populated media object,
 * while a patch carries the relation payload Strapi expects (an id, or null to
 * clear). `id` is the component's own row id, which normalizeSeoPatch copies
 * over verbatim and which never represents an editorial change.
 */
export function seoPatchChanges(current: SeoInput | null | undefined, next: SeoInput): boolean {
  const mediaId = (value: unknown): number | null => {
    if (typeof value === 'number') return value;
    if (value && typeof value === 'object') {
      const id = Number((value as any).id);
      return Number.isSafeInteger(id) ? id : null;
    }
    return null;
  };

  return SEO_FIELDS.some((field) => {
    if (field === 'ogImage') {
      return mediaId(current?.ogImage) !== mediaId(next.ogImage);
    }
    return (current?.[field] ?? null) !== (next[field] ?? null);
  });
}

export function normalizeSeoPatch(
  current: SeoInput | null | undefined,
  patch: unknown,
): SeoInput {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new errors.ValidationError('entityDealPageSeo must be an object.');
  }
  // Keep the component id so Strapi updates the existing component row.
  // Do not echo a populated media object back into Document Service: omitting
  // an untouched relation preserves it, while an explicit ogImage patch can
  // set or clear it using Strapi's normal relation payload.
  const merged: Record<string, unknown> = {};
  if (typeof current?.id === 'number') merged.id = current.id;
  for (const field of SEO_FIELDS) {
    if (field !== 'ogImage' && current?.[field] !== undefined) {
      merged[field] = current[field];
    }
  }
  for (const field of SEO_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      merged[field] = Reflect.get(patch, field);
    }
  }

  if (
    merged.indexingEnabled !== undefined
    && merged.indexingEnabled !== null
    && typeof merged.indexingEnabled !== 'boolean'
  ) {
    throw new errors.ValidationError('indexingEnabled must be true or false.');
  }

  for (const [field, limit] of Object.entries(SEO_LIMITS)) {
    if (!Object.prototype.hasOwnProperty.call(merged, field)) continue;
    const value = merged[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new errors.ValidationError(`${field} must be text or null.`);
    }
    const normalized =
      field === 'metaDescription'
      || field === 'ogDescription'
        ? cleanText(value)
        : collapseText(value);
    if (normalized && normalized.length > limit) {
      throw new errors.ValidationError(
        `${field} must be at most ${limit} characters.`,
      );
    }
    // These land in <title> and <meta content>. Angle brackets have no
    // legitimate use there and the renderer is outside this repository.
    if (normalized && /[<>]/u.test(normalized)) {
      throw new errors.ValidationError(`${field} must not contain < or >.`);
    }
    merged[field] = normalized;
  }

  // The one allow-listed field that previously reached documents().update()
  // completely unvalidated.
  if (
    Object.prototype.hasOwnProperty.call(merged, 'ogImage')
    && merged.ogImage !== null
    && merged.ogImage !== undefined
    && !isMediaRef(merged.ogImage)
  ) {
    throw new errors.ValidationError(
      'ogImage must be a media id, an object with a numeric id, or null.',
    );
  }

  if (Object.prototype.hasOwnProperty.call(merged, 'canonicalUrl')) {
    const raw = cleanText(merged.canonicalUrl);
    if (raw && !canonicalPath(raw)) {
      throw new errors.ValidationError(`canonicalUrl ${CANONICAL_PATH_RULE}.`);
    }
    merged.canonicalUrl = raw ? canonicalPath(raw) : null;
  }

  return merged as SeoInput;
}
