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
  if (scope.sitemap) paths.add('/sitemap.xml');
  for (const slug of scope.slugs ?? []) paths.add(normalizePath(slug));

  return {
    ...(paths.size > 0 ? { paths: [...paths] } : {}),
    ...(
      scope.sitemap || scope.refreshScopes?.length
        ? {
            scopes: [
              ...new Set([
                ...(scope.sitemap ? ['routes'] : []),
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
