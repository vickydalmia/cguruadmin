import type {
  IsrOutboxPayload,
  OfferInvalidation,
  OfferEntityType,
  ScopeRequest,
} from './types';

const OFFER_UIDS: Record<string, OfferEntityType> = {
  'api::coupon.coupon': 'coupon',
  'api::deal.deal': 'deal',
};

export function offerEntityTypeFromUid(uid: string): OfferEntityType | null {
  return OFFER_UIDS[uid] ?? null;
}

/**
 * The submitted sitemap endpoint on the frontend.
 *
 * Only the INDEX is named here. The index is sharded into /sitemap/<group>-<n>.xml
 * files whose count and names depend on live entity membership, which the CMS
 * has no way to know — so the ISR gateway expands this one path into itself plus
 * every live shard it holds in its route registry. Keeping the shard maths on
 * that side means a change to the sharding policy never has to be mirrored here.
 *
 * Must stay in sync with SITEMAP_INDEX_PATH in
 * cguru-ui/src/features/routing/services/sitemap-shards.ts.
 */
const SITEMAP_INDEX_PATH = '/sitemap_index.xml';

function normalizePath(slug: string): string {
  const clean = slug.trim().replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}/` : '/';
}

export function mergeScope(
  before: ScopeRequest | null | undefined,
  after: ScopeRequest | null | undefined,
): ScopeRequest | null {
  if (!before && !after) return null;
  const refreshScopes = [
    ...new Set([
      ...(before?.refreshScopes ?? []),
      ...(after?.refreshScopes ?? []),
    ]),
  ];
  return {
    full: Boolean(before?.full || after?.full),
    homepage: Boolean(before?.homepage || after?.homepage),
    sitemap: Boolean(before?.sitemap || after?.sitemap),
    slugs: [
      ...new Set([...(before?.slugs ?? []), ...(after?.slugs ?? [])]),
    ],
    ...(refreshScopes.length > 0 ? { refreshScopes } : {}),
  };
}

export function createOutboxPayload(
  scope: ScopeRequest,
  offerInvalidations: readonly OfferInvalidation[] = [],
): IsrOutboxPayload {
  const offers = [
    ...new Map(
      offerInvalidations.map((offer) => [
        `${offer.entityType}:${offer.documentId}`,
        offer,
      ]),
    ).values(),
  ];

  if (scope.full) {
    return {
      all: true,
      ...(scope.refreshScopes?.length
        ? { scopes: [...new Set(scope.refreshScopes)] }
        : {}),
      ...(offers.length > 0 ? { offerInvalidations: offers } : {}),
    };
  }

  const paths = new Set<string>();
  if (scope.homepage) paths.add('/');
  if (scope.sitemap) paths.add(SITEMAP_INDEX_PATH);
  for (const slug of scope.slugs ?? []) paths.add(normalizePath(slug));

  return {
    ...(paths.size > 0 ? { paths: [...paths] } : {}),
    ...(
      scope.sitemap || scope.refreshScopes?.length
        ? {
            scopes: [
              ...new Set([
                ...(scope.sitemap ? ['sitemap'] : []),
                ...(scope.refreshScopes ?? []),
              ]),
            ],
          }
        : {}
    ),
    ...(offers.length > 0 ? { offerInvalidations: offers } : {}),
  };
}

export function hasOutboxWork(payload: IsrOutboxPayload): boolean {
  return Boolean(
    payload.all ||
      payload.paths?.length ||
      payload.offerInvalidations?.length,
  );
}

export function boundOutboxPayload(
  payload: IsrOutboxPayload,
  maximumPaths: number,
  maximumBytes: number,
): IsrOutboxPayload {
  const serializedBytes = (value: IsrOutboxPayload) =>
    Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (
    (payload.paths?.length ?? 0) <= maximumPaths &&
    serializedBytes(payload) <= maximumBytes
  ) {
    return payload;
  }
  const full: IsrOutboxPayload = {
    all: true,
    ...(payload.scopes?.length ? { scopes: payload.scopes } : {}),
    ...(payload.offerInvalidations?.length
      ? { offerInvalidations: payload.offerInvalidations }
      : {}),
  };
  if (serializedBytes(full) > maximumBytes) {
    throw new Error(
      `ISR outbox payload exceeds ${maximumBytes} bytes after full-invalidation fallback`,
    );
  }
  return full;
}

export function outboxPayloadSummary(payload: IsrOutboxPayload) {
  return {
    all: payload.all === true,
    pathCount: payload.paths?.length ?? 0,
    pathSample: payload.paths?.slice(0, 100) ?? [],
    pathsTruncated: (payload.paths?.length ?? 0) > 100,
    scopes: payload.scopes ?? [],
    offerInvalidationCount: payload.offerInvalidations?.length ?? 0,
  };
}
