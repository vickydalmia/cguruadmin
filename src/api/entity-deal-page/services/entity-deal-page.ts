import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { arrayizeOfferText } from '../../../utils/offer-text';
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

export const ENTITY_DEAL_PAGE_SUFFIX = '-deals';
export const ENTITY_DEAL_PAGE_DEFAULT_PAGE_SIZE = 50;
export const ENTITY_DEAL_PAGE_MAX_PAGE_SIZE = 100;

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

function normalizePage(raw: unknown): number {
  return Math.max(1, Number(raw) || 1);
}

function normalizePageSize(raw: unknown): number {
  return Math.max(
    1,
    Math.min(
      Number(raw) || ENTITY_DEAL_PAGE_DEFAULT_PAGE_SIZE,
      ENTITY_DEAL_PAGE_MAX_PAGE_SIZE,
    ),
  );
}

function configForKind(value: unknown): EntityConfig | null {
  return ENTITY_DEAL_PAGE_CONFIGS.find((config) => config.kind === value) ?? null;
}

export function entityDealPageSlug(publicEntitySlug: string): string {
  return `${publicEntitySlug}${ENTITY_DEAL_PAGE_SUFFIX}`;
}

export function entityDealPagePath(publicEntitySlug: string): string {
  return `/${entityDealPageSlug(publicEntitySlug)}/`;
}

export function parseEntityDealPageSlug(value: unknown): string | null {
  const slug = cleanText(value)?.replace(/^\/+|\/+$/g, '') ?? '';
  if (
    !slug.endsWith(ENTITY_DEAL_PAGE_SUFFIX)
    || slug.length === ENTITY_DEAL_PAGE_SUFFIX.length
    || slug.includes('/')
  ) {
    return null;
  }
  return slug.slice(0, -ENTITY_DEAL_PAGE_SUFFIX.length) || null;
}

function canonicalPath(value: unknown): string | null {
  const raw = cleanText(value);
  if (!raw) return null;
  if (
    !raw.startsWith('/')
    || raw.startsWith('//')
    || raw.includes('?')
    || raw.includes('#')
    || raw.includes('\\')
    || /[\u0000-\u001f\u007f<>]/u.test(raw)
  ) {
    return null;
  }
  return raw.endsWith('/') ? raw : `${raw}/`;
}

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
  const selfCanonical = entityDealPagePath(publicSlug);
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

function liveDealFilters(
  config: EntityConfig,
  entityDocumentId?: string,
  now = new Date(),
) {
  return {
    ...publishedOnlyFilters(now),
    salePrice: { $gt: 0 },
    affiliateLink: { $notNull: true, $ne: '' },
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

async function resolveEntityByPublicSlug(
  strapi: Core.Strapi,
  publicSlug: string,
): Promise<ResolvedEntity | null> {
  for (const config of ENTITY_DEAL_PAGE_CONFIGS) {
    const candidates = routeSlugCandidates(publicSlug, config.kind);
    const rows: any[] = await strapi.documents(config.uid).findMany({
      filters: {
        $or: candidates.map((candidate) => ({ slug: { $eqi: candidate } })),
      } as any,
      fields: entityFields(config) as any,
      populate: entityPopulate(config) as any,
      limit: 25,
    } as any);

    const entity = rows.find(
      (row) => toRouteSlug(row?.slug, config.kind) === publicSlug,
    );
    if (entity) return { config, entity, publicSlug };
  }
  return null;
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

function routeConflictFor(
  publicSlug: string,
  publicEntitySlugs: ReadonlySet<string>,
  redirectPaths: ReadonlySet<string>,
): boolean {
  const dealSlug = entityDealPageSlug(publicSlug);
  return (
    publicEntitySlugs.has(dealSlug)
    || redirectPaths.has(`/${dealSlug}`.toLowerCase())
  );
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
    merged[field] = normalized;
  }

  if (Object.prototype.hasOwnProperty.call(merged, 'canonicalUrl')) {
    const raw = cleanText(merged.canonicalUrl);
    if (raw && !canonicalPath(raw)) {
      throw new errors.ValidationError(
        'canonicalUrl must be a root-relative path without a query, fragment, backslash, or markup.',
      );
    }
    merged.canonicalUrl = raw ? canonicalPath(raw) : null;
  }

  return merged as SeoInput;
}

function mapSettingItem(input: {
  config: EntityConfig;
  entity: any;
  publicSlug: string;
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
    permalink: entityDealPagePath(input.publicSlug),
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
    strapi.documents('api::redirect.redirect' as any).findMany({
      filters: { active: true } as any,
      fields: ['from'] as any,
      limit: 2_000,
    } as any),
  ]);

  const allEntityRows = perConfigEntities.flatMap(({ config, entities }) =>
    entities.flatMap((entity) => {
      const publicSlug = toRouteSlug(entity?.slug, config.kind);
      return publicSlug ? [{ config, entity, publicSlug }] : [];
    }),
  );
  const publicEntitySlugs = new Set(
    allEntityRows.map((row) => row.publicSlug),
  );
  const redirectPaths = new Set(
    (Array.isArray(activeRedirects) ? activeRedirects : [])
      .map((row: any) => cleanText(row?.from)?.replace(/\/+$/g, '').toLowerCase())
      .filter((value): value is string => Boolean(value)),
  );

  const liveDealMeta = new Map<
    string,
    { count: number; updatedAt?: string }
  >();
  await Promise.all(
    configs.map(async (config) => {
      const deals = await findAllDocuments(
        strapi,
        'api::deal.deal',
        {
          filters: liveDealFilters(config),
          fields: DEAL_FIELDS as any,
          populate: {
            dealImage: true,
            [config.relationField]: { fields: ['documentId'] },
          } as any,
        },
        DEAL_BATCH_SIZE,
      );
      const now = new Date();
      for (const deal of deals) {
        if (!isActionableProductDeal(deal, now)) continue;
        const dealUpdatedAt = cleanText(deal?.updatedAt) ?? undefined;
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
    }),
  );

  return allEntityRows.map(({ config, entity, publicSlug }) => {
    const meta = liveDealMeta.get(entity.documentId);
    return mapSettingItem({
      config,
      entity,
      publicSlug,
      liveDealCount: meta?.count ?? 0,
      liveDealUpdatedAt: meta?.updatedAt,
      routeConflict: routeConflictFor(
        publicSlug,
        publicEntitySlugs,
        redirectPaths,
      ),
    });
  });
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async getPublicPage(rawDealSlug: unknown, rawQuery: Record<string, unknown> = {}) {
    const entitySlug = parseEntityDealPageSlug(rawDealSlug);
    if (!entitySlug) return null;

    const resolved = await resolveEntityByPublicSlug(strapi, entitySlug);
    if (!resolved) return null;

    const page = normalizePage(rawQuery.page);
    const pageSize = normalizePageSize(rawQuery.pageSize);
    const filters = liveDealFilters(
      resolved.config,
      resolved.entity.documentId,
    );
    const [rawDeals, conflictingEntity] = await Promise.all([
      findAllDocuments(
        strapi,
        'api::deal.deal',
        {
          filters: filters as any,
          fields: DEAL_FIELDS as any,
          populate: dealPopulate() as any,
          sort: NEWEST_FIRST as any,
        },
        DEAL_BATCH_SIZE,
      ),
      resolveEntityByPublicSlug(
        strapi,
        entityDealPageSlug(resolved.publicSlug),
      ),
    ]);

    const now = new Date();
    const actionableDeals = (Array.isArray(rawDeals) ? rawDeals : []).filter(
      (deal) => isActionableProductDeal(deal, now),
    );
    const total = actionableDeals.length;
    const start = (page - 1) * pageSize;
    const pagedDeals = actionableDeals.slice(start, start + pageSize);
    const [entity, deals] = await Promise.all([
      sanitizePublicOutput(strapi, resolved.config.uid, resolved.entity),
      sanitizePublicOutput(strapi, 'api::deal.deal', pagedDeals),
    ]);
    const resolvedSeo = resolveEntityDealPageSeo({
      entity,
      publicSlug: resolved.publicSlug,
      liveDealCount: total,
      routeConflict: Boolean(conflictingEntity),
    });

    return {
      data: {
        route: {
          entityType: resolved.config.kind,
          documentId: resolved.entity.documentId,
          sourceSlug: resolved.entity.slug,
          publicSlug: resolved.publicSlug,
          entityPath: `/${resolved.publicSlug}/`,
          permalink: entityDealPagePath(resolved.publicSlug),
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
    items.sort((left, right) =>
      left.name.localeCompare(right.name, 'en', { sensitivity: 'base' })
      || left.entityType.localeCompare(right.entityType)
      || left.documentId.localeCompare(right.documentId),
    );

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
    const items = await loadSettingItems(strapi, ENTITY_DEAL_PAGE_CONFIGS);
    items.sort(
      (left, right) =>
        left.entityType.localeCompare(right.entityType)
        || (left.id ?? Number.MAX_SAFE_INTEGER)
          - (right.id ?? Number.MAX_SAFE_INTEGER)
        || left.documentId.localeCompare(right.documentId),
    );
    return {
      data: items.map((item) => ({
        entityType: item.entityType,
        documentId: item.documentId,
        id: item.id,
        path: item.permalink,
        updatedAt: item.updatedAt,
        noIndex: item.resolvedSeo.noIndex,
      })),
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
