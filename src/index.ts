import type { Core } from '@strapi/strapi';
import { DOTD_SECTION_LABELS, DOTD_UID } from './constants/deal-of-the-day-sections';
import {
  INDEPENDENCE_DAY_SALE_SECTION_LABELS,
  INDEPENDENCE_DAY_SALE_UID,
} from './constants/independence-day-sale-sections';
import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_UID,
} from './constants/homepage-sections';
import { hasTrustedIpsConfigured } from './middlewares/rate-limit';
import { initializeSearchRuntime } from './api/search/services/search';
import { startIsrOutbox, stopIsrOutbox } from './isr-outbox/runtime';
import { installIsrDocumentMiddleware } from './isr-outbox/document-middleware';
// Lives in src/register/, NOT src/middlewares/: Strapi auto-loads every file
// in src/middlewares as a global HTTP middleware via its default export, and
// this module has none — it would register 'global::record-lock-document' as
// an undefined factory that throws the moment anything references it.
import { installRecordLockDocumentMiddleware } from './register/record-lock-document';
import {
  getCuratedOfferRelations,
  registerCuratedOfferRelationQueryFilter,
} from './utils/curated-offer-relations';
import { ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES } from './api/entity-coupon-layout/services/entity-coupon-layout';
import { CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME } from './constants/checkout-merchant';
import {
  ensureComponentEntryTitles,
  ensureFullWidthEditFields,
  ensureNavigationIconPlacement,
  ensureOfferListStatusColumn,
  ensureSectionLabels,
  ensureSingleTypeEntryTitles,
  ensureSortableListColumns,
  hideFieldsFromComponentManager,
  hideRelationsFromContentManager,
} from './bootstrap/content-manager-layouts';
import {
  ensureComponentFieldDescriptions,
  ensureFieldDescriptions,
} from './bootstrap/field-hints';
import {
  ensureAdminRelationSearchFields,
  ensureRelationTargetFieldReadability,
} from './bootstrap/relation-search';
import {
  ensurePublicReadPermissions,
  restrictSingleTypesToSuperAdmin,
  seedEditorCouponLayoutPermission,
} from './bootstrap/permissions';
import {
  ensureCultureGalleryMediaFolder,
  ensureUploadSettings,
} from './bootstrap/upload';
import { runDatabaseReconciliations } from './bootstrap/db-reconciliation';
import {
  registerEntityCouponLayoutRoutes,
  registerEntityDealPageRoutes,
  registerRecordLockRoutes,
} from './register/admin-routes';

// Re-exported for hint-coverage.test.ts, which imports these from '../index'.
export {
  COMPONENT_FIELD_DESCRIPTIONS,
  CONTENT_TYPE_FIELD_HINTS,
} from './bootstrap/field-hints';

export default {
  async register({ strapi }: { strapi: Core.Strapi }) {
    // The Checkout Merchant custom field, which is what lets ONE dropdown
    // offer Stores and Brands together in the main edit form (a relation can
    // only target one content type — src/constants/checkout-merchant.ts has
    // the full reasoning).
    //
    // Registering HERE is mandatory, not stylistic: Strapi.register() runs the
    // user register lifecycle and only THEN calls convertCustomFieldType(),
    // which swaps `"type": "customField"` in the offer schemas for this
    // field's underlying `string`. Register any later and both schemas fail to
    // load with "Could not find Custom Field: global::checkout-merchant".
    //
    // No `plugin` key, so the registry derives the `global::` uid the two
    // schema.json files name. The admin half registers the matching Input in
    // src/admin/app.tsx.
    strapi.customFields.register({
      name: CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME,
      type: 'string',
      inputSize: { default: 6, isResizable: true },
    });

    // NOTE: no custom /_health route — Strapi core already serves /_health
    // (all methods, 204, no auth) and registers it BEFORE this lifecycle,
    // so a route here would be dead code. The docker healthcheck and
    // deploy.sh curl both hit the built-in.

    registerEntityDealPageRoutes(strapi);

    // Register the coupon-layout RBAC action HERE, not in `bootstrap`.
    //
    // The admin plugin's own bootstrap runs before the user bootstrap
    // (Strapi.js: runPluginsLifecycles(BOOTSTRAP) then runUserLifecycles) and
    // calls cleanPermissionsInDatabase(), which deletes every permission row
    // whose action is not yet in the action provider. Registering in the user
    // bootstrap therefore let the cleanup delete the granted row first and
    // register the action immediately afterwards — so every grant survived
    // exactly until the next restart, including ones made by hand in
    // Settings → Roles.
    //
    // The user `register` lifecycle runs before all of that, and the provider
    // only refuses registration once `strapi.isLoaded` is set (after
    // bootstrap), so this is both early enough and allowed.
    await strapi.service('admin::permission').actionProvider.registerMany([
      ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES,
    ]);

    registerEntityCouponLayoutRoutes(strapi);
    registerRecordLockRoutes(strapi);

    // Document-service middlewares. Registration order = execution order:
    // the record-lock guard must run before the write-validation/ISR
    // middleware, matching the order the two blocks had inline here.
    installRecordLockDocumentMiddleware(strapi);
    installIsrDocumentMiddleware(strapi);
  },

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await seedEditorCouponLayoutPermission(strapi);

    // The renderer fetches every page of a Deal catalogue to regenerate one
    // entity Deal page, so a single render can spend a large share of the
    // public 60/min per-IP budget. RATE_LIMIT_TRUSTED_IPS is what exempts the
    // Astro origin from the limiter; without it those bursts surface as
    // intermittent 429s that the renderer turns into 5xx pages, which is very
    // hard to read back from a stack trace. Say so at boot instead.
    if (!hasTrustedIpsConfigured()) {
      strapi.log.warn(
        '[rate-limit] RATE_LIMIT_TRUSTED_IPS is empty — ISR renders share the '
        + 'public per-IP budget and signed ISR cache-bypass requests will be '
        + "rejected. Set it to the Astro origin's private IP.",
      );
    }

    // Content Manager's relation picker queries the immediate component UID,
    // not the Homepage / Deal of the Day single type. A request-scoped Query
    // Engine lifecycle filter keeps only live Coupons/Deals in those pickers
    // while leaving the normal offer collection views fully manageable.
    registerCuratedOfferRelationQueryFilter(strapi);

    // The curated set is derived from the schemas at boot; this log is the
    // audit trail for which pickers are live-filtered.
    const curatedRelations = getCuratedOfferRelations(strapi);
    if (curatedRelations.length === 0) {
      strapi.log.error(
        '[curated-offers] schema derivation returned zero relations — '
        + 'live-offer filtering and cleanup are inactive',
      );
    } else {
      strapi.log.info(
        `[curated-offers] live-filtered relations (${curatedRelations.length}): `
        + curatedRelations
          .map((r) => `${r.sourceUid}.${r.field} → ${r.targetUid}`)
          .join('; '),
      );
    }

    await runDatabaseReconciliations(strapi);

    // Fix the search implementation for this process before serving traffic:
    // the database dialect alone selects Postgres full-set SQL or the
    // non-Postgres full-set query-engine path. pg_trgm/index checks are
    // diagnostics only and never change result semantics or runtime mode.
    await initializeSearchRuntime(strapi);
    await hideRelationsFromContentManager(strapi);
    await hideFieldsFromComponentManager(strapi);
    await ensurePublicReadPermissions(strapi);
    await restrictSingleTypesToSuperAdmin(strapi);
    await ensureUploadSettings(strapi);
    await ensureCultureGalleryMediaFolder(strapi);
    await ensureComponentEntryTitles(strapi);
    await ensureAdminRelationSearchFields(strapi);
    await ensureRelationTargetFieldReadability(strapi);
    await ensureNavigationIconPlacement(strapi);
    await ensureComponentFieldDescriptions(strapi);
    await ensureFieldDescriptions(strapi);
    await ensureSingleTypeEntryTitles(strapi);
    await ensureOfferListStatusColumn(strapi);
    await ensureSortableListColumns(strapi);
    await ensureFullWidthEditFields(strapi);
    await ensureSectionLabels(strapi, HOMEPAGE_UID, HOMEPAGE_SECTION_LABELS);
    await ensureSectionLabels(strapi, DOTD_UID, DOTD_SECTION_LABELS);
    await ensureSectionLabels(
      strapi,
      INDEPENDENCE_DAY_SALE_UID,
      INDEPENDENCE_DAY_SALE_SECTION_LABELS,
    );

    // S3_UPLOAD_ENABLED defaults OFF in production (config/plugins.ts), so a
    // boot missing the flag silently writes uploads to the container's local
    // disk — tmpfs in the hardened deploy, wiped on every redeploy. Loud
    // error, never a throw: the instance must still boot so the env can be
    // fixed and redeployed.
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.S3_UPLOAD_ENABLED !== 'true'
    ) {
      strapi.log.error(
        '[upload] S3_UPLOAD_ENABLED is not "true" — uploads will go to LOCAL DISK ' +
          '(ephemeral tmpfs, lost on redeploy). Set S3_UPLOAD_ENABLED=true in the production env.'
      );
    }

    // The upload MIME allow list is FILE config (config/plugins.ts →
    // plugin::upload.security), not the plugin store, so nothing in the DB
    // records that it was ever set. Drop the key and @strapi/upload silently
    // goes back to accepting every file type, warning only once per upload
    // request in the request log — far too easy to miss. Check it at boot.
    const uploadAllowedTypes = strapi.config.get(['plugin::upload', 'security', 'allowedTypes']);
    if (!Array.isArray(uploadAllowedTypes)) {
      strapi.log.error(
        '[upload] plugin::upload.security.allowedTypes is missing — the Media Library ' +
          'will accept ANY file type. Restore the `security` block in config/plugins.ts.'
      );
    } else if (uploadAllowedTypes.length === 0) {
      strapi.log.error(
        '[upload] plugin::upload.security.allowedTypes is empty — EVERY upload will be ' +
          'rejected. List the permitted MIME types in config/plugins.ts.'
      );
    }

    startIsrOutbox(strapi);
  },

  async destroy() {
    await stopIsrOutbox();
  },
};
