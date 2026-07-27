import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from '../../../utils/content-status';
import { toRouteSlug } from '../../../utils/route-normalization';
import type { EntityPageType } from './entity-page';

export const ENTITY_POPULAR_SEARCH_ORDER = [
  'store',
  'brand',
  'category',
  'bank',
] as const satisfies readonly EntityPageType[];

const GROUP_LIMIT = 10;
const FALLBACK_MINIMUM = 5;
const OFFER_PAGE_SIZE = 1_000;

const ENTITY_CONFIG: Record<
  EntityPageType,
  { uid: string; relationField: 'stores' | 'brands' | 'categories' | 'banks' }
> = {
  store: { uid: 'api::store.store', relationField: 'stores' },
  brand: { uid: 'api::brand.brand', relationField: 'brands' },
  category: { uid: 'api::category.category', relationField: 'categories' },
  bank: { uid: 'api::bank.bank', relationField: 'banks' },
};

export type PopularSearchIdentity = {
  documentId: string;
  name: string;
  slug: string;
};

export type PopularSearchGroup = {
  kind: EntityPageType;
  items: PopularSearchIdentity[];
};

type OfferInventoryItem = {
  relations: Record<EntityPageType, PopularSearchIdentity[]>;
};

type RankedEntry = {
  item: PopularSearchIdentity;
  count: number;
};

type PopularSearchCatalog = {
  global: Record<EntityPageType, PopularSearchIdentity[]>;
  related: Map<string, PopularSearchIdentity[]>;
};

// Public responses remain cached for 60 seconds at the route middleware. The
// shared catalog lives longer so a large ISR build cannot age it out and
// restart the full offer scan mid-build; every relevant committed content
// write and standalone cleanup purges it immediately.
const CATALOG_TTL_MS = 10 * 60_000;
let catalogGeneration = 0;
let catalogCache:
  | {
      strapi: Core.Strapi;
      expiresAt: number;
      value: PopularSearchCatalog;
    }
  | null = null;
let catalogRead:
  | {
      strapi: Core.Strapi;
      generation: number;
      promise: Promise<PopularSearchCatalog>;
    }
  | null = null;

function identity(value: any): PopularSearchIdentity | null {
  if (
    typeof value?.documentId !== 'string' ||
    typeof value?.name !== 'string' ||
    typeof value?.slug !== 'string' ||
    !value.documentId ||
    !value.name ||
    !value.slug
  ) {
    return null;
  }
  return {
    documentId: value.documentId,
    name: value.name,
    slug: value.slug,
  };
}

function distinctRelations(value: unknown): PopularSearchIdentity[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((candidate) => {
    const item = identity(candidate);
    if (!item || seen.has(item.documentId)) return [];
    seen.add(item.documentId);
    return [item];
  });
}

function compareRanked(
  a: { item: PopularSearchIdentity; count: number },
  b: { item: PopularSearchIdentity; count: number },
): number {
  return (
    b.count - a.count ||
    a.item.name.localeCompare(b.item.name, 'en', { sensitivity: 'base' }) ||
    a.item.documentId.localeCompare(b.item.documentId)
  );
}

async function readAllLiveOffers(
  strapi: Core.Strapi,
): Promise<OfferInventoryItem[]> {
  const cutoff = new Date().toISOString();
  const published = publishedOnlyFilters(cutoff);
  const liveOfferFilters = {
    ...published,
    $and: [
      ...published.$and,
      {
        $or: [
          { scheduledAt: { $null: true } },
          { scheduledAt: { $lte: cutoff } },
        ],
      },
    ],
  };
  const populate = Object.fromEntries(
    Object.values(ENTITY_CONFIG).map(({ relationField }) => [
      relationField,
      { fields: ['documentId', 'name', 'slug'] },
    ]),
  );
  const result: OfferInventoryItem[] = [];

  for (const uid of ['api::coupon.coupon', 'api::deal.deal'] as const) {
    for (let start = 0; ; start += OFFER_PAGE_SIZE) {
      const documents = ((await strapi.documents(uid).findMany({
        filters: liveOfferFilters,
        fields: ['documentId'],
        populate,
        sort: [{ documentId: 'asc' }],
        start,
        limit: OFFER_PAGE_SIZE,
      } as any)) ?? []) as any[];

      for (const document of documents) {
        const documentId =
          typeof document?.documentId === 'string'
            ? document.documentId
            : String(document?.id ?? '');
        if (!documentId) continue;
        result.push({
          relations: {
            store: distinctRelations(document.stores),
            brand: distinctRelations(document.brands),
            category: distinctRelations(document.categories),
            bank: distinctRelations(document.banks),
          },
        });
      }

      if (documents.length < OFFER_PAGE_SIZE) break;
    }
  }

  return result;
}

function isEligible(
  kind: EntityPageType,
  item: PopularSearchIdentity,
): boolean {
  return !(
    kind === 'category' &&
    toRouteSlug(item.slug, 'category') === 'deal-of-the-day'
  );
}

function increment(
  ranked: Map<string, RankedEntry>,
  item: PopularSearchIdentity,
): void {
  const entry = ranked.get(item.documentId);
  if (entry) {
    entry.count += 1;
    return;
  }
  ranked.set(item.documentId, { item, count: 1 });
}

function materialize(ranked: Map<string, RankedEntry>): PopularSearchIdentity[] {
  return [...ranked.values()]
    .sort(compareRanked)
    .map(({ item }) => item);
}

function relatedKey(
  sourceKind: EntityPageType,
  sourceDocumentId: string,
  targetKind: EntityPageType,
): string {
  return `${sourceKind}:${sourceDocumentId}:${targetKind}`;
}

function buildCatalog(
  inventory: readonly OfferInventoryItem[],
): PopularSearchCatalog {
  const globalCounts = Object.fromEntries(
    ENTITY_POPULAR_SEARCH_ORDER.map((kind) => [
      kind,
      new Map<string, RankedEntry>(),
    ]),
  ) as Record<EntityPageType, Map<string, RankedEntry>>;
  const relatedCounts = new Map<string, Map<string, RankedEntry>>();

  for (const offer of inventory) {
    for (const kind of ENTITY_POPULAR_SEARCH_ORDER) {
      for (const item of offer.relations[kind]) {
        if (isEligible(kind, item)) increment(globalCounts[kind], item);
      }
    }

    for (const sourceKind of ENTITY_POPULAR_SEARCH_ORDER) {
      for (const source of offer.relations[sourceKind]) {
        for (const targetKind of ENTITY_POPULAR_SEARCH_ORDER) {
          if (targetKind === sourceKind) continue;
          const key = relatedKey(
            sourceKind,
            source.documentId,
            targetKind,
          );
          const ranked =
            relatedCounts.get(key) ?? new Map<string, RankedEntry>();
          relatedCounts.set(key, ranked);
          for (const target of offer.relations[targetKind]) {
            if (isEligible(targetKind, target)) increment(ranked, target);
          }
        }
      }
    }
  }

  return {
    global: Object.fromEntries(
      ENTITY_POPULAR_SEARCH_ORDER.map((kind) => [
        kind,
        materialize(globalCounts[kind]).slice(0, GROUP_LIMIT),
      ]),
    ) as Record<EntityPageType, PopularSearchIdentity[]>,
    related: new Map(
      [...relatedCounts].map(([key, ranked]) => [
        key,
        materialize(ranked).slice(0, GROUP_LIMIT),
      ]),
    ),
  };
}

async function readFreshCatalog(
  strapi: Core.Strapi,
): Promise<PopularSearchCatalog> {
  return buildCatalog(await readAllLiveOffers(strapi));
}

async function readCachedCatalog(
  strapi: Core.Strapi,
): Promise<PopularSearchCatalog> {
  const now = Date.now();
  if (
    catalogCache?.strapi === strapi &&
    now < catalogCache.expiresAt
  ) {
    return catalogCache.value;
  }
  if (catalogRead?.strapi === strapi) return catalogRead.promise;

  const generation = catalogGeneration;
  const promise = readFreshCatalog(strapi);
  const pending = { strapi, generation, promise };
  catalogRead = pending;
  try {
    const value = await promise;
    if (catalogGeneration === generation) {
      catalogCache = {
        strapi,
        expiresAt: Date.now() + CATALOG_TTL_MS,
        value,
      };
    }
    return value;
  } finally {
    if (catalogRead === pending) catalogRead = null;
  }
}

export function purgeEntityPopularSearchCatalog(): void {
  catalogGeneration += 1;
  catalogCache = null;
  catalogRead = null;
}

export async function buildEntityPopularSearches(
  strapi: Core.Strapi,
  currentKind: EntityPageType,
  slug: string,
): Promise<PopularSearchGroup[] | null> {
  const currentConfig = ENTITY_CONFIG[currentKind];
  const sources = (await strapi.documents(currentConfig.uid as any).findMany({
    filters: { slug },
    fields: ['documentId', 'name', 'slug'],
    limit: 1,
  } as any)) as any[];
  const source = identity(sources?.[0]);
  if (!source) return null;

  const catalog = await readCachedCatalog(strapi);

  return ENTITY_POPULAR_SEARCH_ORDER.flatMap((kind) => {
    if (kind === currentKind) return [];

    const related = [
      ...(catalog.related.get(
        relatedKey(currentKind, source.documentId, kind),
      ) ?? []),
    ];

    if (related.length < FALLBACK_MINIMUM) {
      const seen = new Set(related.map((item) => item.documentId));
      for (const fallback of catalog.global[kind]) {
        if (seen.has(fallback.documentId)) continue;
        related.push(fallback);
        seen.add(fallback.documentId);
        if (related.length >= FALLBACK_MINIMUM) break;
      }
    }

    return [{ kind, items: related.slice(0, GROUP_LIMIT) }];
  });
}

/**
 * The visible global top ten determines which entities can be appended when a
 * related group is short. Passing the active write transaction is mandatory
 * for post-write reads: Document Service joins it through Strapi's ambient
 * transaction context and therefore sees the just-written membership without
 * taking a second pool connection.
 */
export async function readPopularSearchFallbackLeaderboards(
  strapi: Core.Strapi,
  activeWriteTransaction?: any,
): Promise<Record<EntityPageType, string[]>> {
  if (
    activeWriteTransaction !== undefined &&
    typeof activeWriteTransaction !== 'function'
  ) {
    throw new Error('Popular-search leaderboard requires the active write transaction');
  }
  // The post-write read runs inside the active content transaction and must
  // observe its uncommitted relation changes. Never publish that snapshot into
  // the public request cache.
  const catalog = activeWriteTransaction
    ? await readFreshCatalog(strapi)
    : await readCachedCatalog(strapi);
  return Object.fromEntries(
    ENTITY_POPULAR_SEARCH_ORDER.map((kind) => [
      kind,
      catalog.global[kind].map((item) => item.documentId),
    ]),
  ) as Record<EntityPageType, string[]>;
}

export function popularSearchLeaderboardsChanged(
  before: Record<EntityPageType, string[]> | null,
  after: Record<EntityPageType, string[]> | null,
): boolean {
  return Boolean(before && after && JSON.stringify(before) !== JSON.stringify(after));
}
