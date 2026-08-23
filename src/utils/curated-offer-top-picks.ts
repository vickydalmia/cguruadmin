// CURATED OFFER RELATIONS — displayed-Top-Pick reconciliation. Split out of
// curated-offer-relations.ts, which keeps the schema index.
import type { Core } from '@strapi/strapi';
import { routeSlugCandidates } from './route-normalization';
import {
  ENTITY_KIND_BY_UID,
  curatedSourcePath,
} from './curated-offer-relations';
import { type CuratedOfferCleanupResult } from './curated-offer-cleanup';

/**
 * How many Top Picks the storefront actually renders. Selections past this are
 * expiry buffers — invisible until an earlier pick stops being live.
 * Mirrors TOP_PICK_DISPLAYED in the admin Coupon layout feature.
 */
const DISPLAYED_TOP_PICKS = 2;

const TOP_PICK_ENTITY_UIDS = Object.keys(ENTITY_KIND_BY_UID);

/**
 * Keep a DISPLAYED Top Pick out of `orderedCoupons`.
 *
 * Top Picks 3-4 are expiry buffers and may legitimately sit in the ordered
 * head at the same time — a displayed pick may not, because the storefront
 * removes displayed picks from the main list, which would silently punch a
 * hole in the editorial order.
 *
 * This is enforced by REPAIR rather than by write validation, deliberately:
 *
 *   - The rule is positional, and `resultingRelations` cannot resolve the
 *     resulting ORDER of a relation patch (it keeps first occurrences and
 *     ignores Strapi's before/end anchors), so a validator would misjudge any
 *     drag-reorder.
 *   - `removeInactiveCuratedOfferRelations` above writes through Query Engine,
 *     bypassing the document-service middleware. When it drops an expired pick
 *     and promotes a buffer that is also ordered, it creates exactly this
 *     state — and a validator would then reject EVERY later save of that
 *     entity, including edits unrelated to Coupons.
 *
 * Lifecycle cleanup passes affected entity paths so buffer promotions are
 * repaired immediately without scanning every entity. The nightly call omits
 * that target and performs the full reconciliation safety pass.
 *
 * NOTE: this edits editorial data without the editor asking, so every removal
 * is logged. If someone deliberately puts a displayed Top Pick into Ordered
 * Coupons it will be removed by reconciliation, and the log is the audit
 * trail.
 */
export async function removeDisplayedTopPicksFromOrdered(
  strapi: Core.Strapi,
  targetPaths?: readonly string[],
): Promise<CuratedOfferCleanupResult> {
  let removedSelections = 0;
  let requiresFullRevalidation = false;
  const affectedPaths = new Set<string>();

  for (const sourceUid of TOP_PICK_ENTITY_UIDS) {
    const query = strapi.db.query(sourceUid as any);
    const kind = ENTITY_KIND_BY_UID[sourceUid];
    const slugs = targetPaths
      ?.flatMap((path) => {
        const route = path.replace(/^\/+|\/+$/g, '');
        return route && kind ? routeSlugCandidates(route, kind) : [];
      });
    if (targetPaths && (!slugs || slugs.length === 0)) continue;
    // Query Engine populate preserves link-table order when no explicit sort
    // is given (getJoinTableOrderBy in @strapi/database), so index 0 and 1 are
    // the displayed picks.
    const rows = await query.findMany({
      ...(slugs ? { where: { slug: { $in: slugs } } } : {}),
      select: ['id', 'slug'],
      populate: {
        topPickCoupons: { select: ['id', 'documentId'] },
        orderedCoupons: { select: ['id', 'documentId'] },
      },
    } as any);

    for (const row of rows as any[]) {
      const topPicks = Array.isArray(row?.topPickCoupons)
        ? row.topPickCoupons
        : [];
      const ordered = Array.isArray(row?.orderedCoupons)
        ? row.orderedCoupons
        : [];
      if (topPicks.length === 0 || ordered.length === 0) continue;

      const orderedIds = new Set(
        ordered.map((coupon: any) => coupon?.id).filter(Boolean),
      );
      const conflicting = topPicks
        .slice(0, DISPLAYED_TOP_PICKS)
        .filter((coupon: any) => coupon?.id && orderedIds.has(coupon.id));
      if (conflicting.length === 0) continue;

      await query.update({
        where: { id: row.id },
        data: {
          orderedCoupons: {
            disconnect: conflicting.map((coupon: any) => coupon.id),
          },
        },
      } as any);
      removedSelections += conflicting.length;

      const path = curatedSourcePath(sourceUid, row);
      if (path) {
        affectedPaths.add(path);
      } else {
        requiresFullRevalidation = true;
      }

      strapi.log.info({
        event: 'content.displayed_top_pick_removed_from_ordered',
        sourceUid,
        path,
        entityId: row.id,
        coupons: conflicting.map((coupon: any) => coupon.documentId ?? coupon.id),
      });
    }
  }

  return {
    removedSelections,
    affectedPaths: [...affectedPaths],
    requiresFullRevalidation,
  };
}
