import type { Core } from '@strapi/strapi';

import {
  getCuratedOfferRelations,
  registerCuratedOfferRelationQueryFilter,
} from '../utils/curated-offer-relations';

export function bootstrapCuratedOfferRelations(strapi: Core.Strapi): void {
  registerCuratedOfferRelationQueryFilter(strapi);
  const curatedRelations = getCuratedOfferRelations(strapi);
  if (curatedRelations.length === 0) {
    strapi.log.error(
      '[curated-offers] schema derivation returned zero relations — ' +
        'live-offer filtering and cleanup are inactive',
    );
  } else {
    strapi.log.info(
      `[curated-offers] live-filtered relations (${curatedRelations.length}): ` +
        curatedRelations
          .map(
            (relation) =>
              `${relation.sourceUid}.${relation.field} → ${relation.targetUid}`,
          )
          .join('; '),
    );
  }
}
