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
export const SITEMAP_INDEX_PATH = '/sitemap_index.xml';

function normalizePath(slug: string): string {
  const clean = slug.trim().replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}/` : '/';
}

export function mergeScope(
  before: ScopeRequest | null | undefined,
  after: ScopeRequest | null | undefined,
): ScopeRequest | null {
  if (!before && !after) return null;
  const slugs = [
    ...new Set([...(before?.slugs ?? []), ...(after?.slugs ?? [])]),
  ];
  const requiredPaths = new Set(slugs.map(normalizePath));
  const optionalSlugs = [
    ...new Set([
      ...(before?.optionalSlugs ?? []),
      ...(after?.optionalSlugs ?? []),
    ]),
  ].filter((slug) => !requiredPaths.has(normalizePath(slug)));
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
    slugs,
    ...(optionalSlugs.length > 0 ? { optionalSlugs } : {}),
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

  const requiredPaths = new Set<string>();
  if (scope.homepage) requiredPaths.add('/');
  if (scope.sitemap) requiredPaths.add(SITEMAP_INDEX_PATH);
  for (const slug of scope.slugs ?? []) requiredPaths.add(normalizePath(slug));
  const optionalPaths = new Set(
    (scope.optionalSlugs ?? [])
      .map(normalizePath)
      .filter((path) => !requiredPaths.has(path)),
  );
  const paths = new Set([...requiredPaths, ...optionalPaths]);

  return {
    ...(paths.size > 0 ? { paths: [...paths] } : {}),
    ...(optionalPaths.size > 0
      ? { optionalPaths: [...optionalPaths] }
      : {}),
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

/**
 * Narrow a localized content invalidation to the locale that was written.
 * The public sitemap currently contains default-locale URLs only. Existing
 * locale rows keep route membership, while creation/removal retains `routes`
 * so the inventory can admit or remove that exact localized path.
 */
export function localizeTranslationPayload(
  payload: IsrOutboxPayload,
  targetLocale: string,
  options: { routeMembershipChanged?: boolean } = {},
): IsrOutboxPayload {
  const locale = targetLocale.trim().replace(/^\/+|\/+$/g, '');
  if (!locale) return payload;
  const membershipChanged = options.routeMembershipChanged === true;
  const paths = (payload.paths ?? []).filter(
    (path) => path !== SITEMAP_INDEX_PATH,
  );
  const optionalPathSet = new Set(payload.optionalPaths ?? []);
  const optionalPaths = paths.filter((path) => optionalPathSet.has(path));
  const scopes = (payload.scopes ?? []).filter(
    (scope) =>
      scope !== 'sitemap' && (membershipChanged || scope !== 'routes'),
  );

  return {
    ...(payload.all ? { all: true as const } : {}),
    localePrefix: `/${locale}`,
    ...(paths.length > 0 ? { paths: [...new Set(paths)] } : {}),
    ...(optionalPaths.length > 0
      ? { optionalPaths: [...new Set(optionalPaths)] }
      : {}),
    ...(scopes.length > 0 ? { scopes: [...new Set(scopes)] } : {}),
  };
}

/**
 * Expand a shared non-localized change to every configured language. This is
 * intentionally not used for localized prose: only locale rows admitted by
 * the storefront inventory exist, and those are invalidated after their own
 * successful write. A full sweep (`all`) already covers everything; the
 * sitemap index is shard-expanded by the gateway and has no locale twin.
 */
export function expandPayloadPathsForLocales(
  payload: IsrOutboxPayload,
  localeCodes: readonly string[],
): IsrOutboxPayload {
  if (payload.all || localeCodes.length === 0 || !payload.paths?.length) {
    return payload;
  }
  const twin = (path: string, code: string): string | null => {
    if (path === SITEMAP_INDEX_PATH) return null;
    if (!path.startsWith('/')) return null;
    if (path === `/${code}/` || path.startsWith(`/${code}/`)) return null;
    return path === '/' ? `/${code}/` : `/${code}${path}`;
  };
  const paths = new Set(payload.paths);
  const optionalPaths = new Set(payload.optionalPaths ?? []);
  for (const code of localeCodes) {
    for (const path of payload.paths) {
      const twinPath = twin(path, code);
      if (!twinPath) continue;
      paths.add(twinPath);
      // A twin inherits optionality: only optional sources stay optional.
      if (optionalPaths.has(path)) optionalPaths.add(twinPath);
    }
  }
  return {
    ...payload,
    paths: [...paths],
    ...(optionalPaths.size > 0 ? { optionalPaths: [...optionalPaths] } : {}),
  };
}

export function hasOutboxWork(payload: IsrOutboxPayload): boolean {
  return Boolean(
    payload.all ||
      payload.paths?.length ||
      payload.offerInvalidations?.length,
  );
}

/** Merge a burst of pending writes without widening it beyond one locale. */
export function mergeOutboxPayloads(
  before: IsrOutboxPayload,
  after: IsrOutboxPayload,
): IsrOutboxPayload {
  if (before.localePrefix !== after.localePrefix) {
    throw new Error('cannot coalesce ISR payloads for different locales');
  }
  const paths = [...new Set([...(before.paths ?? []), ...(after.paths ?? [])])];
  const required = new Set([
    ...(before.paths ?? []).filter(
      (path) => !(before.optionalPaths ?? []).includes(path),
    ),
    ...(after.paths ?? []).filter(
      (path) => !(after.optionalPaths ?? []).includes(path),
    ),
  ]);
  const optionalPaths = paths.filter(
    (path) => !required.has(path) && (
      (before.optionalPaths ?? []).includes(path) ||
      (after.optionalPaths ?? []).includes(path)
    ),
  );
  const offers = [
    ...new Map(
      [...(before.offerInvalidations ?? []), ...(after.offerInvalidations ?? [])]
        .map((offer) => [`${offer.entityType}:${offer.documentId}`, offer]),
    ).values(),
  ];
  return {
    ...(before.all || after.all ? { all: true as const } : {}),
    ...(before.localePrefix ? { localePrefix: before.localePrefix } : {}),
    ...(paths.length ? { paths } : {}),
    ...(optionalPaths.length ? { optionalPaths } : {}),
    ...((before.scopes?.length || after.scopes?.length)
      ? { scopes: [...new Set([...(before.scopes ?? []), ...(after.scopes ?? [])])] }
      : {}),
    ...(offers.length ? { offerInvalidations: offers } : {}),
  };
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
    ...(payload.localePrefix ? { localePrefix: payload.localePrefix } : {}),
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
    localePrefix: payload.localePrefix ?? null,
    pathCount: payload.paths?.length ?? 0,
    pathSample: payload.paths?.slice(0, 100) ?? [],
    pathsTruncated: (payload.paths?.length ?? 0) > 100,
    optionalPathCount: payload.optionalPaths?.length ?? 0,
    optionalPathSample: payload.optionalPaths?.slice(0, 100) ?? [],
    optionalPathsTruncated: (payload.optionalPaths?.length ?? 0) > 100,
    scopes: payload.scopes ?? [],
    offerInvalidationCount: payload.offerInvalidations?.length ?? 0,
  };
}
