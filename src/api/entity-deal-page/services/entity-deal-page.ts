import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { arrayizeOfferText } from '../../../utils/offer-text';
import {
  CANONICAL_PATH_RULE,
  normalizeCanonicalPath,
} from '../../../utils/canonical-path';
import { isMediaRef } from '../../../utils/entity-deal-page-seo-validation';
import { publishedOnlyFilters } from '../../../utils/content-status';
import {
  isActionableProductDeal,
  NEWEST_FIRST,
} from '../../../utils/offer-visibility';
import {
  routeSlugCandidates,
  toRouteSlug,
  type IdentityKind,
} from '../../../utils/route-normalization';
import {
  entityDealPagePath,
  entityDealPageSlug,
  parseEntityDealPageSlug,
} from './entity-deal-route';

export const ENTITY_DEAL_PAGE_DEFAULT_PAGE_SIZE = 50;
// Astro fetches every page of a catalogue during regeneration, so a larger
// ceiling is a direct reduction in requests per render (and in how close a
// render gets to the route's 60/min rate limit).
export const ENTITY_DEAL_PAGE_MAX_PAGE_SIZE = 250;

type EntityUid =
  | 'api::store.store'
  | 'api::brand.brand'
  | 'api::category.category'
  | 'api::bank.bank';

type EntityConfig = {
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

const ENTITY_BATCH_SIZE = 1_000;
const DEAL_BATCH_SIZE = 1_000;
const SEO_LIMITS = {
  metaTitle: 70,
  metaDescription: 170,
  ogTitle: 95,
  ogDescription: 200,
  ogImageAlt: 125,
} as const;
const SEO_FIELDS = [
  'indexingEnabled',
  'metaTitle',
  'metaDescription',
  'canonicalUrl',
  'ogTitle',
  'ogDescription',
  'ogImage',
  'ogImageAlt',
] as const;
const DEAL_FIELDS = [
  'title',
  'offerText',
  'cashbackText',
  'bankOfferText',
  'badge',
  'content',
  'code',
  'salePrice',
  'mrp',
  'discount',
  'affiliateLink',
  'expiresAt',
  'contentStatus',
  'scheduledAt',
  'createdAt',
  'updatedAt',
  'publishedAt',
  'publishedOn',
] as const;
const ENTITY_FIELDS = [
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

type SeoInput = {
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

type ResolvedEntity = {
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

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function collapseText(value: unknown): string | null {
  const text = cleanText(value);
  return text ? text.replace(/\s+/gu, ' ') : null;
}

function limitText(value: string, limit: number): string {
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
function normalizePage(raw: unknown): number {
  return Math.max(1, Math.trunc(Number(raw)) || 1);
}

function normalizePageSize(raw: unknown): number {
  return Math.max(
    1,
    Math.min(
      Math.trunc(Number(raw)) || ENTITY_DEAL_PAGE_DEFAULT_PAGE_SIZE,
      ENTITY_DEAL_PAGE_MAX_PAGE_SIZE,
    ),
  );
}

function configForKind(value: unknown): EntityConfig | null {
  return ENTITY_DEAL_PAGE_CONFIGS.find((config) => config.kind === value) ?? null;
}

export {
  entityDealPagePath,
  entityDealPageSlug,
  parseEntityDealPageSlug,
} from './entity-deal-route';

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

  const media = entity?.logo ?? entity?.icon ?? null;
  const ogImage = seo?.ogImage ?? media;
  const mediaAlt =
    collapseText(entity?.logoAlt)
    ?? collapseText(entity?.iconAlt)
    ?? displayName;
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
    ogImageAlt:
      collapseText(seo?.ogImageAlt)
      ?? collapseText(ogImage?.alternativeText)
      ?? mediaAlt,
  };
}

function entityPopulate(config: EntityConfig) {
  return {
    [config.mediaField]: true,
    entityDealPageSeo: { populate: { ogImage: true } },
  };
}

function entityFields(config: EntityConfig) {
  return [...ENTITY_FIELDS, config.mediaAltField];
}

function dealPopulate() {
  const namedLogo = {
    fields: ['name', 'slug', 'logoAlt'],
    populate: { logo: true },
  };
  return {
    dealImage: true,
    stores: namedLogo,
    brands: namedLogo,
    banks: namedLogo,
    categories: {
      fields: ['name', 'slug', 'iconAlt'],
      populate: { icon: true },
    },
  };
}

/**
 * SQL-side filter for deals eligible to appear on an entity Deal page.
 *
 * This is a deliberate SUPERSET of `isActionableProductDeal`, which stays the
 * authority over what is actually rendered. Every predicate here is a
 * necessary condition, so a deal that would be actionable can never be
 * excluded — the filter is safe to paginate against.
 *
 * The one predicate that cannot be expressed faithfully is
 * `hasSafeAffiliateLink`: it accepts root-relative paths (but not `//…`) and
 * anything `new URL()` parses as http/https, which no combination of
 * `$startsWith` reproduces without either dropping valid rows or admitting
 * `javascript:`. Write validation requires the field to be non-blank but does
 * not constrain the scheme, so a malformed link can still pass this filter and
 * be dropped in Node. That makes counts derived from this filter an UPPER
 * BOUND; `countActionableDeals` reconciles it where an exact number matters.
 */
function liveDealFilters(
  config: EntityConfig,
  entityDocumentId?: string,
  now = new Date(),
) {
  return {
    ...publishedOnlyFilters(now),
    salePrice: { $gt: 0 },
    affiliateLink: { $notNull: true, $ne: '' },
    // A deal with no image can never be actionable, and this is exact.
    dealImage: { id: { $notNull: true } },
    ...(entityDocumentId
      ? { [config.relationField]: { documentId: entityDocumentId } }
      : { [config.relationField]: { documentId: { $notNull: true } } }),
  };
}

async function sanitizePublicOutput(
  strapi: Core.Strapi,
  uid: string,
  data: unknown,
) {
  const schema = strapi.contentType(uid as any) as any;
  return await strapi.contentAPI.sanitize.output(data, schema, {
    auth: undefined,
  });
}

type EntityRouteOwner = {
  config: EntityConfig;
  documentId: string;
  publicSlug: string;
  dealSlug: string;
};

const ENTITY_ROUTE_OWNER_TTL_MS = 60_000;
const entityRouteOwnerCache = new WeakMap<
  Core.Strapi,
  { expiresAt: number; owners: Map<string, EntityRouteOwner | null> }
>();

async function entityRouteOwners(
  strapi: Core.Strapi,
): Promise<Map<string, EntityRouteOwner | null>> {
  const cached = entityRouteOwnerCache.get(strapi);
  if (cached && cached.expiresAt > Date.now()) return cached.owners;

  const perConfig = await Promise.all(
    ENTITY_DEAL_PAGE_CONFIGS.map(async (config) => ({
      config,
      entities: await findAllDocuments(
        strapi,
        config.uid,
        {
          fields: ['documentId', 'name', 'slug'],
          sort: [{ id: 'asc' }],
        },
        ENTITY_BATCH_SIZE,
      ),
    })),
  );
  const owners = new Map<string, EntityRouteOwner | null>();
  for (const { config, entities } of perConfig) {
    for (const entity of entities) {
      const documentId = cleanText(entity?.documentId);
      const publicSlug = toRouteSlug(entity?.slug, config.kind);
      const dealSlug = entityDealPageSlug(entity?.name);
      if (!documentId || !publicSlug || !dealSlug) continue;
      const owner = { config, documentId, publicSlug, dealSlug };
      owners.set(dealSlug, owners.has(dealSlug) ? null : owner);
    }
  }
  entityRouteOwnerCache.set(strapi, {
    expiresAt: Date.now() + ENTITY_ROUTE_OWNER_TTL_MS,
    owners,
  });
  return owners;
}

async function resolveEntityByDealSlug(
  strapi: Core.Strapi,
  requestedDealSlug: string,
): Promise<ResolvedEntity | null> {
  const owner = (await entityRouteOwners(strapi)).get(requestedDealSlug);
  if (!owner) return null;

  const entity: any = await strapi.documents(owner.config.uid).findOne({
    documentId: owner.documentId,
    fields: entityFields(owner.config) as any,
    populate: entityPopulate(owner.config) as any,
  } as any);
  const publicSlug = toRouteSlug(entity?.slug, owner.config.kind);
  const dealSlug = entityDealPageSlug(entity?.name);
  if (!entity || publicSlug !== owner.publicSlug || dealSlug !== requestedDealSlug) {
    return null;
  }
  return { config: owner.config, entity, publicSlug, dealSlug };
}

async function findAllDocuments(
  strapi: Core.Strapi,
  uid: string,
  options: Record<string, any>,
  batchSize: number,
): Promise<any[]> {
  const rows: any[] = [];
  let start = 0;
  while (true) {
    const page: any[] = await strapi.documents(uid as any).findMany({
      ...options,
      start,
      limit: batchSize,
    } as any);
    rows.push(...page);
    if (page.length < batchSize) break;
    start += page.length;
  }
  return rows;
}

/**
 * True when the normalized patch differs from what is already stored.
 *
 * `ogImage` is compared by id: the stored value is a populated media object,
 * while a patch carries the relation payload Strapi expects (an id, or null to
 * clear). `id` is the component's own row id, which normalizeSeoPatch copies
 * over verbatim and which never represents an editorial change.
 */
function seoPatchChanges(current: SeoInput | null | undefined, next: SeoInput): boolean {
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

function normalizeRedirectFrom(value: unknown): string | null {
  return cleanText(value)?.replace(/\/+$/g, '').toLowerCase() ?? null;
}

function routeConflictFor(
  dealSlug: string,
  publicEntitySlugs: ReadonlySet<string>,
  dealSlugCounts: ReadonlyMap<string, number>,
  redirectPaths: ReadonlySet<string>,
): boolean {
  return (
    publicEntitySlugs.has(dealSlug)
    || (dealSlugCounts.get(dealSlug) ?? 0) > 1
    || redirectPaths.has(`/${dealSlug}`.toLowerCase())
  );
}

/**
 * Targeted equivalent of `routeConflictFor` for the single-page read path.
 *
 * getPublicPage used to derive this from a second full entity resolution,
 * which checked only the entity-slug half. The route inventory checked the
 * redirect half too, so the same page could report `noIndex: false` publicly
 * and `noIndex: true` in the inventory. Both callers now answer the same
 * question; this one just scopes the reads to the one slug it cares about.
 */
async function hasRouteConflict(
  strapi: Core.Strapi,
  resolved: ResolvedEntity,
): Promise<boolean> {
  const { dealSlug } = resolved;

  const [entityOwnsDealSlug, anotherGeneratedOwner, redirects] = await Promise.all([
    Promise.all(
      ENTITY_DEAL_PAGE_CONFIGS.map(async (config) => {
        const candidates = routeSlugCandidates(dealSlug, config.kind);
        const rows: any[] = await strapi.documents(config.uid).findMany({
          filters: {
            $or: candidates.map((candidate) => ({ slug: { $eqi: candidate } })),
          } as any,
          fields: ['slug'] as any,
          limit: ENTITY_BATCH_SIZE,
        } as any);
        return rows.some(
          (row) => toRouteSlug(row?.slug, config.kind) === dealSlug,
        );
      }),
    ).then((results) => results.some(Boolean)),
    Promise.all(
      ENTITY_DEAL_PAGE_CONFIGS.map(async (config) => {
        const rows = await findAllDocuments(
          strapi,
          config.uid,
          {
            fields: ['documentId', 'name'],
            sort: [{ id: 'asc' }],
          },
          ENTITY_BATCH_SIZE,
        );
        return rows.some((entity) => {
          const sameEntity =
            config.uid === resolved.config.uid
            && entity?.documentId === resolved.entity?.documentId;
          return !sameEntity && entityDealPageSlug(entity?.name) === dealSlug;
        });
      }),
    ).then((results) => results.some(Boolean)),
    strapi.documents('api::redirect.redirect' as any).findMany({
      filters: {
        active: true,
        $or: [
          { from: { $eqi: `/${dealSlug}` } },
          { from: { $eqi: `/${dealSlug}/` } },
        ],
      } as any,
      fields: ['from'] as any,
      limit: 1,
    } as any),
  ]);

  return (
    entityOwnsDealSlug
    || anotherGeneratedOwner
    || (Array.isArray(redirects) && redirects.length > 0)
  );
}

/**
 * Exact count of actionable deals, used only to settle the `no-live-deals`
 * blocker when the cheap signal is inconclusive.
 *
 * `liveDealFilters` is an upper bound (see its doc comment), so a non-zero SQL
 * count does not prove a page has anything to render. When the requested page
 * yields at least one actionable deal the answer is already known, and this
 * scan is skipped — which is every normal request. It only runs when a page
 * comes back empty despite matching rows existing, i.e. when the affiliate
 * links are malformed. Fields are kept minimal so the scan stays cheap.
 */
async function countActionableDeals(
  strapi: Core.Strapi,
  filters: Record<string, any>,
): Promise<number> {
  const rows = await findAllDocuments(
    strapi,
    'api::deal.deal',
    {
      filters,
      fields: ['contentStatus', 'expiresAt', 'salePrice', 'affiliateLink'],
      populate: { dealImage: { fields: ['url'] } },
      sort: [{ id: 'asc' }],
    },
    DEAL_BATCH_SIZE,
  );
  const now = new Date();
  return rows.filter((deal) => isActionableProductDeal(deal, now)).length;
}

function normalizeSeoPatch(
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

function mapSettingItem(input: {
  config: EntityConfig;
  entity: any;
  publicSlug: string;
  dealSlug: string;
  liveDealCount: number;
  liveDealUpdatedAt?: string;
  routeConflict: boolean;
}) {
  const resolvedSeo = resolveEntityDealPageSeo(input);
  const entityUpdatedAt = cleanText(input.entity.updatedAt);
  const updatedAt =
    [entityUpdatedAt, input.liveDealUpdatedAt]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? undefined;
  return {
    entityType: input.config.kind,
    documentId: input.entity.documentId,
    id: input.entity.id,
    name: collapseText(input.entity.name) ?? input.publicSlug,
    sourceSlug: input.entity.slug,
    publicSlug: input.publicSlug,
    entityPath: `/${input.publicSlug}/`,
    permalink: `/${input.dealSlug}/`,
    liveDealCount: input.liveDealCount,
    updatedAt,
    entityDealPageSeo: input.entity.entityDealPageSeo ?? null,
    resolvedSeo,
    indexState: !resolvedSeo.indexingEnabled
      ? 'disabled' as const
      : resolvedSeo.effectiveIndexable
        ? 'enabled' as const
        : 'blocked' as const,
  };
}

export function publicEntityDealPageRoute(item: {
  entityType: string;
  id?: number;
  permalink: string;
  updatedAt?: string;
  resolvedSeo: {
    noIndex: boolean;
    blockers: readonly EntityDealPageIndexBlocker[];
  };
}) {
  return {
    entityType: item.entityType,
    id: item.id,
    path: item.permalink,
    updatedAt: item.updatedAt,
    noIndex: item.resolvedSeo.noIndex,
    // A redirect-owned path is not merely non-indexable: it must be absent
    // from live route membership so the gateway can resolve the authored
    // redirect instead of a generated page.
    routeConflict: item.resolvedSeo.blockers.includes('route-conflict'),
  };
}

export const SETTINGS_SORT_FIELDS = [
  'name',
  'liveDealCount',
  'updatedAt',
] as const;

export type SettingsSortField = (typeof SETTINGS_SORT_FIELDS)[number];
export type SettingsSort = { field: SettingsSortField; desc: boolean };

const DEFAULT_SETTINGS_SORT: SettingsSort = { field: 'name', desc: false };

/**
 * Parse `?sort=liveDealCount:desc` into a sort descriptor.
 *
 * Sorting has to happen here rather than in the admin table: listSettings
 * paginates AFTER sorting, so a client-side sort would only reorder the 25
 * rows of the current page and silently lie about which entities have the most
 * Deals. An unrecognised field or direction falls back to the default instead
 * of erroring — a bad sort is a broken control, not a broken request.
 */
export function parseSettingsSort(raw: unknown): SettingsSort {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return DEFAULT_SETTINGS_SORT;

  const [rawField, rawDirection] = value.split(':');
  const field = SETTINGS_SORT_FIELDS.find((candidate) => candidate === rawField);
  if (!field) return DEFAULT_SETTINGS_SORT;

  return { field, desc: rawDirection?.toLowerCase() === 'desc' };
}

type SortableItem = {
  name: string;
  entityType: string;
  documentId: string;
  liveDealCount: number;
  updatedAt?: string;
};

/**
 * Every comparator ends in the same name/type/documentId tiebreak, so equal
 * primary values keep a stable, deterministic order. Without it, offset
 * pagination over ties (very common: hundreds of entities share
 * liveDealCount 0) could show the same row on two pages and drop another.
 */
export function settingsComparator(
  sort: SettingsSort,
): (left: SortableItem, right: SortableItem) => number {
  const direction = sort.desc ? -1 : 1;
  const byIdentity = (left: SortableItem, right: SortableItem) =>
    left.name.localeCompare(right.name, 'en', { sensitivity: 'base' })
    || left.entityType.localeCompare(right.entityType)
    || left.documentId.localeCompare(right.documentId);
  const timestamp = (item: SortableItem): number | null => {
    if (!item.updatedAt) return null;
    const value = Date.parse(item.updatedAt);
    return Number.isNaN(value) ? null : value;
  };

  return (left, right) => {
    let primary = 0;
    if (sort.field === 'liveDealCount') {
      primary = left.liveDealCount - right.liveDealCount;
    } else if (sort.field === 'updatedAt') {
      // Missing or invalid timestamps stay last in both directions. Applying
      // the normal direction multiplier to a sentinel would move them to the
      // front for one direction.
      const leftTimestamp = timestamp(left);
      const rightTimestamp = timestamp(right);
      if (leftTimestamp === null || rightTimestamp === null) {
        if (leftTimestamp === rightTimestamp) return byIdentity(left, right);
        return leftTimestamp === null ? 1 : -1;
      }
      primary = leftTimestamp - rightTimestamp;
    } else {
      primary = left.name.localeCompare(right.name, 'en', {
        sensitivity: 'base',
      });
    }

    return primary !== 0 ? primary * direction : byIdentity(left, right);
  };
}

async function loadSettingItems(
  strapi: Core.Strapi,
  configs: readonly EntityConfig[],
) {
  const [perConfigEntities, activeRedirects] = await Promise.all([
    Promise.all(
      configs.map(async (config) => ({
        config,
        entities: await findAllDocuments(
          strapi,
          config.uid,
          {
            fields: entityFields(config) as any,
            populate: entityPopulate(config) as any,
            sort: [{ id: 'asc' }],
          },
          ENTITY_BATCH_SIZE,
        ),
      })),
    ),
    // Paged, not `limit: 2_000` — past a flat cap the route-conflict blocker
    // silently stops firing for every redirect beyond the window.
    findAllDocuments(
      strapi,
      'api::redirect.redirect',
      {
        filters: { active: true },
        fields: ['from'],
        sort: [{ id: 'asc' }],
      },
      ENTITY_BATCH_SIZE,
    ),
  ]);

  const allEntityRows = perConfigEntities.flatMap(({ config, entities }) =>
    entities.flatMap((entity) => {
      const publicSlug = toRouteSlug(entity?.slug, config.kind);
      const dealSlug = entityDealPageSlug(entity?.name);
      return publicSlug && dealSlug
        ? [{ config, entity, publicSlug, dealSlug }]
        : [];
    }),
  );
  const publicEntitySlugs = new Set(
    allEntityRows.map((row) => row.publicSlug),
  );
  const dealSlugCounts = new Map<string, number>();
  for (const row of allEntityRows) {
    dealSlugCounts.set(row.dealSlug, (dealSlugCounts.get(row.dealSlug) ?? 0) + 1);
  }
  const redirectPaths = new Set(
    (Array.isArray(activeRedirects) ? activeRedirects : [])
      .map((row: any) => normalizeRedirectFrom(row?.from))
      .filter((value): value is string => Boolean(value)),
  );

  // ONE scan over the deal table, not one per entity type. The four scans this
  // replaces differed only in which relation they populated, so a deal linked
  // to a store, a brand and a category was fetched and materialised three
  // times. `sort` is required: findAllDocuments pages by offset, and offsetting
  // through an unordered result set can repeat or skip rows across the batch
  // boundary — which would corrupt liveDealCount and the no-live-deals blocker.
  const { contentStatus, $and: publishedAnd } = publishedOnlyFilters();
  const deals = await findAllDocuments(
    strapi,
    'api::deal.deal',
    {
      filters: {
        contentStatus,
        $and: publishedAnd,
        salePrice: { $gt: 0 },
        affiliateLink: { $notNull: true, $ne: '' },
        dealImage: { id: { $notNull: true } },
        $or: configs.map((config) => ({
          [config.relationField]: { documentId: { $notNull: true } },
        })),
      },
      fields: DEAL_FIELDS as any,
      populate: {
        dealImage: true,
        ...Object.fromEntries(
          configs.map((config) => [
            config.relationField,
            { fields: ['documentId'] },
          ]),
        ),
      },
      sort: [{ id: 'asc' }],
    },
    DEAL_BATCH_SIZE,
  );

  const liveDealMeta = new Map<
    string,
    { count: number; updatedAt?: string }
  >();
  const now = new Date();
  for (const deal of deals) {
    if (!isActionableProductDeal(deal, now)) continue;
    const dealUpdatedAt = cleanText(deal?.updatedAt) ?? undefined;
    for (const config of configs) {
      const seen = new Set<string>();
      for (const entity of deal?.[config.relationField] ?? []) {
        const documentId = cleanText(entity?.documentId);
        if (!documentId || seen.has(documentId)) continue;
        seen.add(documentId);
        const current = liveDealMeta.get(documentId);
        liveDealMeta.set(documentId, {
          count: (current?.count ?? 0) + 1,
          updatedAt:
            [current?.updatedAt, dealUpdatedAt]
              .filter((value): value is string => Boolean(value))
              .sort()
              .at(-1) ?? undefined,
        });
      }
    }
  }

  return allEntityRows.map(({ config, entity, publicSlug, dealSlug }) => {
    const meta = liveDealMeta.get(entity.documentId);
    return mapSettingItem({
      config,
      entity,
      publicSlug,
      dealSlug,
      liveDealCount: meta?.count ?? 0,
      liveDealUpdatedAt: meta?.updatedAt,
      routeConflict: routeConflictFor(
        dealSlug,
        publicEntitySlugs,
        dealSlugCounts,
        redirectPaths,
      ),
    });
  });
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getPublicPage(rawDealSlug: unknown, rawQuery: Record<string, unknown> = {}) {
    const nameSlug = parseEntityDealPageSlug(rawDealSlug);
    if (!nameSlug) return null;
    const requestedDealSlug = `${nameSlug}-deals`;

    const resolved = await resolveEntityByDealSlug(strapi, requestedDealSlug);
    if (!resolved) return null;

    const page = normalizePage(rawQuery.page);
    const pageSize = normalizePageSize(rawQuery.pageSize);
    const filters = liveDealFilters(
      resolved.config,
      resolved.entity.documentId,
    );

    // Pagination happens in the database. This used to load every deal for the
    // entity with a five-way populate and then slice in memory, so `?pageSize=1`
    // cost the same as the full catalogue — and Astro requests every page of it.
    const start = (page - 1) * pageSize;
    const [rawDeals, matchedTotal, routeConflict] = await Promise.all([
      strapi.documents('api::deal.deal' as any).findMany({
        filters: filters as any,
        fields: DEAL_FIELDS as any,
        populate: dealPopulate() as any,
        sort: NEWEST_FIRST as any,
        start,
        limit: pageSize,
      } as any),
      strapi.documents('api::deal.deal' as any).count({
        filters: filters as any,
      } as any),
      hasRouteConflict(strapi, resolved),
    ]);

    const now = new Date();
    const pagedDeals = (Array.isArray(rawDeals) ? rawDeals : []).filter(
      (deal) => isActionableProductDeal(deal, now),
    );

    // `matchedTotal` counts the SQL superset. It is exact unless a deal has a
    // malformed affiliate link, which only the Node predicate can detect. The
    // count is used for the `no-live-deals` blocker, so settle it exactly when
    // — and only when — the cheap signal cannot: a page that returned nothing
    // actionable while the superset says rows exist.
    const supersetTotal = typeof matchedTotal === 'number' ? matchedTotal : 0;
    const total = pagedDeals.length === 0 && supersetTotal > 0
      ? await countActionableDeals(strapi, filters)
      : supersetTotal;

    const [entity, deals] = await Promise.all([
      sanitizePublicOutput(strapi, resolved.config.uid, resolved.entity),
      sanitizePublicOutput(strapi, 'api::deal.deal', pagedDeals),
    ]);
    const resolvedSeo = resolveEntityDealPageSeo({
      entity,
      publicSlug: resolved.publicSlug,
      liveDealCount: total,
      routeConflict,
    });

    return {
      data: {
        route: {
          entityType: resolved.config.kind,
          documentId: resolved.entity.documentId,
          sourceSlug: resolved.entity.slug,
          publicSlug: resolved.publicSlug,
          entityPath: `/${resolved.publicSlug}/`,
          permalink: `/${resolved.dealSlug}/`,
        },
        entity,
        seo: resolvedSeo,
        deals: arrayizeOfferText(deals),
        pagination: {
          page,
          pageSize,
          total,
          pageCount: Math.ceil(total / pageSize),
        },
      },
    };
  },

  async listSettings(rawQuery: Record<string, unknown> = {}) {
    const requestedKind = cleanText(rawQuery.kind);
    const requestedState = cleanText(rawQuery.indexState);
    const search = cleanText(rawQuery.search)?.toLowerCase() ?? null;
    const page = normalizePage(rawQuery.page);
    const pageSize = normalizePageSize(rawQuery.pageSize);
    const sort = parseSettingsSort(rawQuery.sort);
    const configs = requestedKind
      ? ENTITY_DEAL_PAGE_CONFIGS.filter((config) => config.kind === requestedKind)
      : ENTITY_DEAL_PAGE_CONFIGS;

    if (requestedKind && configs.length === 0) {
      throw new errors.ValidationError(
        'kind must be store, brand, category, or bank.',
      );
    }
    if (
      requestedState
      && !['enabled', 'disabled', 'blocked'].includes(requestedState)
    ) {
      throw new errors.ValidationError(
        'indexState must be enabled, disabled, or blocked.',
      );
    }

    let items = await loadSettingItems(strapi, configs);

    if (search) {
      items = items.filter((item) =>
        [item.name, item.sourceSlug, item.permalink].some((value) =>
          String(value ?? '').toLowerCase().includes(search),
        ),
      );
    }
    if (requestedState) {
      items = items.filter((item) => item.indexState === requestedState);
    }
    items.sort(settingsComparator(sort));

    const total = items.length;
    const start = (page - 1) * pageSize;
    return {
      data: items.slice(start, start + pageSize),
      meta: {
        pagination: {
          page,
          pageSize,
          total,
          pageCount: Math.ceil(total / pageSize),
        },
      },
    };
  },

  async listPublicRoutes() {
    const allItems = await loadSettingItems(strapi, ENTITY_DEAL_PAGE_CONFIGS);
    // A generated Deal page with nothing to render is not a route. Emitting one
    // per entity regardless of liveDealCount doubled the site's route surface
    // with pages that render empty, and put them in the sitemap.
    const items = allItems.filter((item) => item.liveDealCount > 0);
    items.sort(
      (left, right) =>
        left.entityType.localeCompare(right.entityType)
        || (left.id ?? Number.MAX_SAFE_INTEGER)
          - (right.id ?? Number.MAX_SAFE_INTEGER)
        || left.documentId.localeCompare(right.documentId),
    );
    return {
      // `documentId` is deliberately NOT published here: this route is
      // anonymous, and documentId is the path parameter the Super-Admin PATCH
      // endpoint takes. `id` stays — the frontend assigns sitemap shards from
      // it (features/routing/services/route-inventory.ts).
      data: items.map(publicEntityDealPageRoute),
    };
  },

  async updateSettings(
    rawKind: unknown,
    rawDocumentId: unknown,
    rawPatch: unknown,
  ) {
    const config = configForKind(rawKind);
    const documentId = cleanText(rawDocumentId);
    if (!config || !documentId) return null;

    const current: any = await strapi.documents(config.uid).findOne({
      documentId,
      fields: ['documentId'] as any,
      populate: {
        entityDealPageSeo: { populate: { ogImage: true } },
      } as any,
    } as any);
    if (!current) return null;

    const patch =
      rawPatch
      && typeof rawPatch === 'object'
      && Object.prototype.hasOwnProperty.call(rawPatch, 'entityDealPageSeo')
        ? Reflect.get(rawPatch, 'entityDealPageSeo')
        : rawPatch;
    const entityDealPageSeo = normalizeSeoPatch(
      current.entityDealPageSeo,
      patch,
    );

    // Skip the write when nothing actually changed. An entity write goes
    // through the ISR outbox, and a no-op PATCH — which the settings screen
    // will produce every time an editor opens a row and saves without editing
    // — otherwise costs a page rebuild.
    if (!seoPatchChanges(current.entityDealPageSeo, entityDealPageSeo)) {
      return {
        data: {
          entityType: config.kind,
          documentId,
          entityDealPageSeo,
        },
      };
    }

    await strapi.documents(config.uid).update({
      documentId,
      data: { entityDealPageSeo } as any,
    });

    return {
      data: {
        entityType: config.kind,
        documentId,
        entityDealPageSeo,
      },
    };
  },
});
