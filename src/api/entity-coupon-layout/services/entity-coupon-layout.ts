import { randomUUID } from 'node:crypto';
import type { Core } from '@strapi/strapi';

import { insertIsrOutboxEvent } from '../../../isr-outbox/store';
import { SITEMAP_INDEX_PATH } from '../../../isr-outbox/payload';
import { wakeIsrOutbox } from '../../../isr-outbox/runtime';
import { purgeResponseCaches } from '../../../middlewares/cache';
import { enabledContentLocaleCodesSync } from '../../../translation/locales/registry';
import {
  translationRuntimeActive,
  wakeTranslationOutbox,
} from '../../../translation/outbox/runtime';
import { insertTranslationJob } from '../../../translation/outbox/store';
import { publishedOnlyFilters } from '../../../utils/content-status';
import { toRouteSlug } from '../../../utils/route-normalization';

// The thin coupon-layout service: request parsing and the kind registry live
// in ./entity-coupon-layout-parse, entity/coupon reads in
// ./entity-coupon-layout-repository, selection eligibility in
// ./entity-coupon-layout-eligibility, and ISR invalidation in
// ./entity-coupon-layout-invalidation. This file keeps the RBAC action
// constants and the service factory.
import {
  configFor,
  CouponLayoutError,
  parseLayoutSelection,
  DISPLAYED_TOP_PICK_COUNT,
  ORDERED_COUPON_LIMIT,
  PREVIEW_COUPON_LIMIT,
  TOP_PICK_LIMIT,
  type EntityCouponLayoutKind,
  type LayoutSelection,
} from './entity-coupon-layout-parse';
import {
  minimalCoupon,
  readEntity,
  relationIds,
  versionOf,
  type CouponProjection,
} from './entity-coupon-layout-repository';
import {
  eligibleCouponFilters,
  eligibleCoupons,
  storedSelectionIds,
  storedSelectionTitles,
  validateEligibleSelection,
  type DroppedSelection,
} from './entity-coupon-layout-eligibility';
import { couponLayoutInvalidation } from './entity-coupon-layout-invalidation';


export const ENTITY_COUPON_LAYOUT_ACTION =
  'admin::entity-coupon-layout.manage';

export const ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES = {
  section: 'settings',
  displayName: 'Manage entity coupon layout',
  uid: 'entity-coupon-layout.manage',
  // This is an Administration Panel permission, not a standalone Strapi
  // plugin. `admin` is the installed core plugin that owns settings actions.
  pluginName: 'admin',
  category: 'content management',
  subCategory: 'coupon layout',
} as const;

export function createEntityCouponLayoutService({
  strapi,
}: {
  strapi: Core.Strapi;
}) {
  const getLayout = async (kind: unknown, rawDocumentId: unknown) => {
    const { config, entity } = await readEntity(
      strapi,
      kind,
      rawDocumentId,
    );
    const topPickCoupons = (entity.topPickCoupons ?? []).map(minimalCoupon);
    const orderedCoupons = (entity.orderedCoupons ?? []).map(minimalCoupon);
    return {
      kind: config.kind,
      documentId: entity.documentId,
      slug: entity.slug,
      version: versionOf(entity),
      topPickCoupons,
      orderedCoupons,
      counts: {
        topPicks: topPickCoupons.length,
        ordered: orderedCoupons.length,
      },
    };
  };
  return {
    get: getLayout,

    async candidates(
      kind: unknown,
      rawDocumentId: unknown,
      query: Record<string, unknown>,
    ) {
      const { config, documentId: entityDocumentId } = await readEntity(
        strapi,
        kind,
        rawDocumentId,
      );
      const page = Math.max(1, Number(query.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 50));
      const search = String(query.search ?? '').trim().slice(0, 120);
      const sort = query.sort === 'title' ? 'title' : 'newest';
      const filters = eligibleCouponFilters(
        config,
        entityDocumentId,
        undefined,
        search,
      );
      const [results, total] = await Promise.all([
        eligibleCoupons(strapi, config, entityDocumentId, undefined, {
          search,
          sort,
          start: (page - 1) * pageSize,
          limit: pageSize,
          filters,
        }),
        strapi.documents('api::coupon.coupon').count({ filters }),
      ]);
      return {
        results,
        pagination: {
          page,
          pageSize,
          pageCount: Math.max(1, Math.ceil(total / pageSize)),
          total,
        },
      };
    },

    async preview(
      kind: unknown,
      rawDocumentId: unknown,
      body: unknown,
    ) {
      const { config, entity, documentId: entityDocumentId } = await readEntity(
        strapi,
        kind,
        rawDocumentId,
      );
      const requestedSelection = parseLayoutSelection(body);
      // A preview writes nothing, so it must never be the thing that fails on
      // stale saved picks — it is how an editor SEES the current state.
      const { byId: selected, selection } = await validateEligibleSelection(
        strapi,
        config,
        entityDocumentId,
        requestedSelection,
        storedSelectionIds(entity),
      );
      const filters = eligibleCouponFilters(config, entityDocumentId);
      const [automatic, total] = await Promise.all([
        eligibleCoupons(
          strapi,
          config,
          entityDocumentId,
          undefined,
          {
            // At most fourteen selected Coupons can occupy the beginning of
            // the automatic sequence. Fetch enough beyond the 30 visible rows
            // to construct the authoritative preview without loading the
            // entity's complete membership.
            limit:
              PREVIEW_COUPON_LIMIT +
              TOP_PICK_LIMIT +
              ORDERED_COUPON_LIMIT +
              DISPLAYED_TOP_PICK_COUNT,
            filters,
          },
        ),
        strapi.documents('api::coupon.coupon').count({
          filters,
        }),
      ]);
      const automaticById = new Map(
        automatic.map((coupon) => [coupon.documentId, coupon]),
      );
      const topPicks = selection.topPickCouponIds
        .map((id) => selected.get(id))
        .filter(Boolean) as CouponProjection[];

      // Fill empty displayed slots the way the storefront does, which means
      // skipping anything the editor put in the ordered head:
      // build-unified-entity-page-view filters `orderedCouponIds` out of its
      // automatic candidates before calling selectEntityTopPicks. Without this
      // the preview could promote an ordered Coupon into a Top Pick slot AND
      // remove it from the main list — the one place the real page renders it.
      const orderedSelectionIds = new Set(selection.orderedCouponIds);
      for (const coupon of automatic) {
        if (topPicks.length >= DISPLAYED_TOP_PICK_COUNT) break;
        if (orderedSelectionIds.has(coupon.documentId)) continue;
        if (!topPicks.some((item) => item.documentId === coupon.documentId)) {
          topPicks.push(coupon);
        }
      }

      // The storefront renders NO Top Picks section below two picks
      // (selectEntityTopPicks: `if (selected.length < 2) return []`), leaving
      // those Coupons in the main list. An entity with a single eligible
      // Coupon must preview that way too, or the preview shows a section the
      // page will not render and hides the row where it actually appears.
      const displayedPicks =
        topPicks.length >= DISPLAYED_TOP_PICK_COUNT
          ? topPicks.slice(0, DISPLAYED_TOP_PICK_COUNT)
          : [];
      const displayed = new Set(
        displayedPicks.map((coupon) => coupon.documentId),
      );
      const ordered = selection.orderedCouponIds
        .filter((id) => !displayed.has(id))
        .map((id) => selected.get(id) ?? automaticById.get(id))
        .filter(Boolean) as CouponProjection[];
      const orderedIds = new Set(ordered.map((coupon) => coupon.documentId));
      const main = [
        ...ordered,
        ...automatic.filter(
          (coupon) =>
            !displayed.has(coupon.documentId) &&
            !orderedIds.has(coupon.documentId),
        ),
      ];
      return {
        topPicks: displayedPicks,
        coupons: main.slice(0, PREVIEW_COUPON_LIMIT),
        // Full live membership, including Coupons displayed as Top Picks.
        total,
      };
    },

    async replace(
      kind: unknown,
      rawDocumentId: unknown,
      body: unknown,
    ) {
      const { config, entity, documentId: entityDocumentId } = await readEntity(
        strapi,
        kind,
        rawDocumentId,
      );
      const input =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      const requestedVersion = String(input.version ?? '');
      const currentVersion = versionOf(entity);
      if (!requestedVersion || requestedVersion !== currentVersion) {
        throw new CouponLayoutError(
          'This Coupon layout changed after you opened it. Reload before saving.',
          409,
          'VERSION_CONFLICT',
          { currentVersion },
        );
      }
      const requestedSelection = parseLayoutSelection(input);
      const {
        byId: selected,
        selection,
        dropped,
      } = await validateEligibleSelection(
        strapi,
        config,
        entityDocumentId,
        requestedSelection,
        storedSelectionIds(entity),
        storedSelectionTitles(entity),
      );
      const topPickIds = selection.topPickCouponIds.map(
        (id) => selected.get(id)!.id,
      );
      const orderedIds = selection.orderedCouponIds.map(
        (id) => selected.get(id)!.id,
      );
      const now = new Date();
      const eventKey = randomUUID();
      const { pagePaths, cachePaths } = couponLayoutInvalidation(
        config,
        entity.slug,
      );
      if (pagePaths.length === 0) {
        strapi.log.warn(
          `[coupon-layout] ${config.uid} ${entityDocumentId} has an unroutable slug `
          + `(${JSON.stringify(entity.slug)}); skipping page invalidation.`,
        );
      }

      const outbox = await strapi.db.transaction(
        async ({
          trx,
          onCommit,
        }: {
          trx: any;
          onCommit: (callback: () => void) => void;
        }) => {
          // Row lock, then re-read the version INSIDE it — the check before
          // the transaction is only a fast path and cannot close the
          // read-modify-write window on its own.
          //
          // knex emits no lock clause on SQLite, which is the default
          // DATABASE_CLIENT for local dev, so there this degrades to the same
          // non-atomic compare. Production runs Postgres, where it is a real
          // FOR UPDATE.
          const locked = await trx(config.table)
            .where({ id: entity.id })
            .select(['id', 'updated_at'])
            .forUpdate()
            .first();
          const lockedVersion = locked?.updated_at
            ? new Date(locked.updated_at).toISOString()
            : '';
          if (lockedVersion !== requestedVersion) {
            throw new CouponLayoutError(
              'This Coupon layout changed after you opened it. Reload before saving.',
              409,
              'VERSION_CONFLICT',
              { currentVersion: lockedVersion },
            );
          }
          await strapi.db.query(config.uid as any).update({
            where: { id: entity.id },
            data: {
              topPickCoupons: { set: topPickIds },
              orderedCoupons: { set: orderedIds },
            },
          } as any);
          // document_id addressing: locale twins share the public timestamp
          // (sitemap lastmod), and this raw write never reaches the i18n
          // non-localized sync.
          const touched = await trx(config.table)
            .where({ document_id: entity.documentId })
            .update({ updated_at: now });
          if (Number(touched) < 1) {
            throw new Error('Entity disappeared while saving Coupon layout.');
          }
          const event = await insertIsrOutboxEvent(trx, {
            eventKey,
            // `sitemap` because the write bumps `updated_at`, which is the
            // value the sitemap publishes as lastmod for this entity.
            payload: { paths: pagePaths, scopes: ['sitemap'] },
            reason: `${config.uid} coupon layout update`,
          });
          // Curated relations changed at the Query Engine layer, which the
          // translation enqueue in the document middleware never sees — the
          // locale twin's topPickCoupons/orderedCoupons would drift without
          // this. Same transaction, no LLM cost: an unchanged source hash
          // makes it a pure relation re-mirror.
          if (await translationRuntimeActive(strapi)) {
            for (const code of enabledContentLocaleCodesSync()) {
              await insertTranslationJob(trx, {
                uid: config.uid,
                documentId: entityDocumentId,
                targetLocale: code,
                kind: 'relation-sync',
                reason: `${config.uid} coupon layout update`,
              });
            }
          }
          onCommit(() => {
            purgeResponseCaches(cachePaths);
            wakeIsrOutbox();
            wakeTranslationOutbox();
          });
          return event;
        },
      );

      return {
        ...(await getLayout(config.kind, entityDocumentId)),
        // Non-empty when a saved pick had gone stale and was self-healed out
        // of the selection. The dialog names them so the editor is never
        // silently left with a different layout than the one they submitted.
        dropped,
        refresh: {
          outboxId: outbox.id,
          state: 'queued',
        },
      };
    },
  };
}

export default createEntityCouponLayoutService;
