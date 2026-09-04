// Entity Deal-page ROUTE OWNERSHIP: which entity owns each generated
// `-deals` route (60s-cached per strapi instance) and redirect/entity
// conflicts that block indexing. One of the modules split out of the
// entity-deal-page service (see ./entity-deal-page.ts).
import type { Core } from '@strapi/strapi';
import {
  entityDealPageSlug,
} from './entity-deal-route';
import {
  routeSlugCandidates,
  toRouteSlug,
} from '../../../utils/route-normalization';
import {
  ENTITY_BATCH_SIZE,
  ENTITY_DEAL_PAGE_CONFIGS,
  cleanText,
  type EntityConfig,
  type EntityDealPageIndexBlocker,
  type ResolvedEntity,
} from './entity-deal-page-config';
import {
  entityFields,
  entityPopulate,
  findAllDocuments,
} from './entity-deal-page-loaders';
import { DEFAULT_CONTENT_LOCALE } from '../../../constants/content-locales';

type EntityRouteOwner = {
  config: EntityConfig;
  documentId: string;
  publicSlug: string;
  dealSlug: string;
};

const ENTITY_ROUTE_OWNER_TTL_MS = 60_000;

const entityRouteOwnerCache = new WeakMap<
  Core.Strapi,
  Map<string, { expiresAt: number; owners: Map<string, EntityRouteOwner | null> }>
>();

export async function entityRouteOwners(
  strapi: Core.Strapi,
  locale = DEFAULT_CONTENT_LOCALE,
): Promise<Map<string, EntityRouteOwner | null>> {
  const localeCache = entityRouteOwnerCache.get(strapi);
  const cached = localeCache?.get(locale);
  if (cached && cached.expiresAt > Date.now()) return cached.owners;

  const perConfig = await Promise.all(
    ENTITY_DEAL_PAGE_CONFIGS.map(async (config) => {
      const entities = await findAllDocuments(
        strapi,
        config.uid,
        {
          locale,
          fields: ['documentId', 'name', 'slug'],
          sort: [{ id: 'asc' }],
        },
        ENTITY_BATCH_SIZE,
      );
      const sourceRows = locale === DEFAULT_CONTENT_LOCALE
        ? entities
        : entities.length > 0
          ? await findAllDocuments(
            strapi,
            config.uid,
            {
              locale: DEFAULT_CONTENT_LOCALE,
              filters: {
                documentId: { $in: entities.map((entity) => entity.documentId) },
              },
              fields: ['documentId', 'name'],
              sort: [{ id: 'asc' }],
            },
            ENTITY_BATCH_SIZE,
          )
          : [];
      return {
        config,
        entities,
        routeNameByDocumentId: new Map(
          sourceRows.map((entity) => [entity.documentId, entity.name]),
        ),
      };
    }),
  );
  const owners = new Map<string, EntityRouteOwner | null>();
  for (const { config, entities, routeNameByDocumentId } of perConfig) {
    for (const entity of entities) {
      const documentId = cleanText(entity?.documentId);
      const publicSlug = toRouteSlug(entity?.slug, config.kind);
      const dealSlug = entityDealPageSlug(
        routeNameByDocumentId.get(entity?.documentId),
      );
      if (!documentId || !publicSlug || !dealSlug) continue;
      const owner = { config, documentId, publicSlug, dealSlug };
      owners.set(dealSlug, owners.has(dealSlug) ? null : owner);
    }
  }
  const nextCache = localeCache ?? new Map();
  nextCache.set(locale, {
    expiresAt: Date.now() + ENTITY_ROUTE_OWNER_TTL_MS,
    owners,
  });
  entityRouteOwnerCache.set(strapi, nextCache);
  return owners;
}

export function normalizeRedirectFrom(value: unknown): string | null {
  return cleanText(value)?.replace(/\/+$/g, '').toLowerCase() ?? null;
}

export function routeConflictFor(
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
export async function hasRouteConflict(
  strapi: Core.Strapi,
  resolved: ResolvedEntity,
): Promise<boolean> {
  const { dealSlug } = resolved;

  const [entityOwnsDealSlug, anotherGeneratedOwner, redirects] = await Promise.all([
    Promise.all(
      ENTITY_DEAL_PAGE_CONFIGS.map(async (config) => {
        const candidates = routeSlugCandidates(dealSlug, config.kind);
        const rows: any[] = await strapi.documents(config.uid).findMany({
          locale: DEFAULT_CONTENT_LOCALE,
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
            locale: DEFAULT_CONTENT_LOCALE,
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

export async function resolveEntityByDealSlug(
  strapi: Core.Strapi,
  requestedDealSlug: string,
  locale = DEFAULT_CONTENT_LOCALE,
): Promise<ResolvedEntity | null> {
  const owner = (await entityRouteOwners(strapi, locale)).get(requestedDealSlug);
  if (!owner) return null;

  const entity: any = await strapi.documents(owner.config.uid).findOne({
    documentId: owner.documentId,
    locale,
    fields: entityFields(owner.config) as any,
    populate: entityPopulate(owner.config) as any,
  } as any);
  const publicSlug = toRouteSlug(entity?.slug, owner.config.kind);
  if (!entity || publicSlug !== owner.publicSlug) {
    return null;
  }
  return {
    config: owner.config,
    entity,
    publicSlug,
    dealSlug: owner.dealSlug,
  };
}
