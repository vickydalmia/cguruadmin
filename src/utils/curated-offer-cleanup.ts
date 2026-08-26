// CURATED OFFER RELATIONS — inactive-offer cleanup. Split out of
// curated-offer-relations.ts, which keeps the schema index.
import type { Core } from '@strapi/strapi';
import { isLiveOffer } from './offer-visibility';
import {
  ENTITY_KIND_BY_UID,
  curatedSourcePaths,
  getCuratedOfferRelations,
  type CuratedOfferRelation,
  type OfferUid,
} from './curated-offer-relations';

export type CuratedOfferCleanupResult = {
  removedSelections: number;
  affectedPaths: string[];
  requiresFullRevalidation: boolean;
};

/**
 * Remove non-live offers from curated component/entity relations themselves.
 * Query Engine relation updates preserve the remaining many-way ordering and
 * work for both to-one and to-many fields.
 */
export async function removeInactiveCuratedOfferRelations(
  strapi: Core.Strapi,
  now = new Date(),
  changedOffers?: Readonly<Partial<Record<OfferUid, readonly string[]>>>,
): Promise<CuratedOfferCleanupResult> {
  let removedSelections = 0;
  let requiresFullRevalidation = false;
  const affectedPaths = new Set<string>();

  for (const relation of getCuratedOfferRelations(strapi)) {
    const changedDocumentIds = changedOffers?.[relation.targetUid];
    if (changedOffers && (!changedDocumentIds || changedDocumentIds.length === 0)) {
      continue;
    }
    const query = strapi.db.query(relation.sourceUid as any);
    const isEntitySource = Boolean(ENTITY_KIND_BY_UID[relation.sourceUid]);
    const rows = await query.findMany({
      ...(changedDocumentIds
        ? {
            where: {
              [relation.field]: {
                documentId: { $in: [...changedDocumentIds] },
              },
            },
          }
        : {}),
      select: isEntitySource ? ['id', 'slug'] : ['id'],
      populate: {
        [relation.field]: {
          select: ['id', 'documentId', 'contentStatus', 'expiresAt'],
        },
      },
    } as any);

    for (const row of rows as any[]) {
      const selected = Array.isArray(row?.[relation.field])
        ? row[relation.field]
        : row?.[relation.field]
          ? [row[relation.field]]
          : [];
      const inactiveIds = selected
        .filter((offer: any) => !isLiveOffer(offer, now))
        .map((offer: any) => offer.id)
        .filter((id: unknown): id is string | number =>
          typeof id === 'string' || typeof id === 'number',
        );

      if (inactiveIds.length === 0) continue;

      await query.update({
        where: { id: row.id },
        data: {
          [relation.field]: {
            disconnect: inactiveIds,
          },
        },
      } as any);
      removedSelections += inactiveIds.length;

      const paths = await curatedSourcePaths(strapi, relation.sourceUid, row);
      if (paths.length > 0) {
        for (const path of paths) affectedPaths.add(path);
      } else {
        requiresFullRevalidation = true;
      }
    }
  }

  return {
    removedSelections,
    affectedPaths: [...affectedPaths],
    requiresFullRevalidation,
  };
}
