// CURATED OFFER RELATIONS — request-scoped live filtering for the Content
// Manager relation pickers. Split out of curated-offer-relations.ts, which
// keeps the schema index.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Core } from '@strapi/strapi';
import { publishedOnlyFilters } from './content-status';
import { isLiveOffer } from './offer-visibility';
import {
  getCuratedOfferRelationIndex,
  type OfferUid,
} from './curated-offer-relations';

const liveRelationRequest = new AsyncLocalStorage<{ targetUid: OfferUid }>();

function safelyDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Axios leaves literal percent signs untouched while encoding spaces in the
 * relation combobox query (for example `100%%20Whey`). Depending on the URL
 * parser, the encoded tail can then survive in `_q` and fail an otherwise
 * exact title match. Preserve literal percent signs, decode valid escapes, and
 * ignore accidental leading/trailing whitespace.
 */
export function normalizeRelationSearch(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const escapedLiteralPercents = value.replace(/%(?![0-9a-f]{2})/gi, '%25');
  return safelyDecode(escapedLiteralPercents).trim();
}

/**
 * Matches both Content Manager relation endpoints:
 *   /content-manager/relations/:model/:targetField
 *   /content-manager/relations/:model/:id/:targetField
 */
function relationPathParts(
  path: string,
): { sourceUid: string; field: string } | null {
  const parts = path.split('/').filter(Boolean).map(safelyDecode);
  const relationsIndex = parts.findIndex(
    (part, index) => part === 'relations' && parts[index - 1] === 'content-manager',
  );
  if (relationsIndex < 0) return null;

  const sourceUid = parts[relationsIndex + 1];
  const field = parts.at(-1);
  if (!sourceUid || !field || parts.length - relationsIndex < 3) return null;

  return { sourceUid, field };
}

export function isContentManagerRelationPath(path: string): boolean {
  return relationPathParts(path) !== null;
}

export function curatedOfferTargetForRelationPath(
  strapi: Core.Strapi,
  path: string,
): OfferUid | null {
  const parsed = relationPathParts(path);
  if (!parsed) return null;

  return (
    getCuratedOfferRelationIndex(strapi).targetBySourceAndField.get(
      `${parsed.sourceUid}\0${parsed.field}`,
    ) ?? null
  );
}

export function runWithCuratedOfferRelationFilter<T>(
  targetUid: OfferUid,
  callback: () => T,
): T {
  return liveRelationRequest.run({ targetUid }, callback);
}

function appendLiveOfferWhere(event: any): void {
  const request = liveRelationRequest.getStore();
  const eventUid = event?.model?.uid ?? event?.model;
  if (!request || (eventUid && eventUid !== request.targetUid)) return;

  event.params ??= {};
  const liveWhere = publishedOnlyFilters(new Date());
  const currentWhere = event.params.where;
  event.params.where = currentWhere
    ? { $and: [currentWhere, liveWhere] }
    : liveWhere;
}

/**
 * The relation controller uses Query Engine (not Document Service), including
 * a separate count query for pagination. Filter both operations so dropdown
 * results, search, totals, and "load more" all describe the same live set.
 */
export function registerCuratedOfferRelationQueryFilter(strapi: Core.Strapi): void {
  strapi.db.lifecycles.subscribe({
    models: ['api::coupon.coupon', 'api::deal.deal'],
    beforeFindMany: appendLiveOfferWhere,
    beforeCount: appendLiveOfferWhere,
  });
}
