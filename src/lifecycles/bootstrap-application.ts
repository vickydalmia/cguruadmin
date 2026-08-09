import type { Core } from '@strapi/strapi';

import { initializeSearchRuntime } from '../api/search/services/search';
import {
  DOTD_SECTION_LABELS,
  DOTD_UID,
} from '../constants/deal-of-the-day-sections';
import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_UID,
} from '../constants/homepage-sections';
import {
  INDEPENDENCE_DAY_SALE_SECTION_LABELS,
  INDEPENDENCE_DAY_SALE_UID,
} from '../constants/independence-day-sale-sections';
import { startIsrOutbox, stopIsrOutbox } from '../isr-outbox/runtime';
import { bootstrapCuratedOfferRelations } from './bootstrap-curated-offers';
import { seedEntityCouponLayoutEditorPermission } from './bootstrap-permissions';
import { reconcileDatabaseAfterSchemaSync } from './bootstrap-reconciliation';
import {
  warnIfTrustedIpsMissing,
  warnIfUploadConfigurationIsUnsafe,
} from './bootstrap-warnings';
import { ensureComponentFieldDescriptions } from './content-manager/component-field-hints';
import { ensureFieldDescriptions } from './content-manager/content-type-field-hints';
import {
  ensureComponentEntryTitles,
  ensureSingleTypeEntryTitles,
} from './content-manager/entry-titles';
import {
  hideFieldsFromComponentManager,
  hideRelationsFromContentManager,
} from './content-manager/layout-visibility';
import {
  ensureFullWidthEditFields,
  ensureOfferListStatusColumn,
  ensureSortableListColumns,
} from './content-manager/list-layout';
import {
  ensurePublicReadPermissions,
  ensureUploadSettings,
  restrictSingleTypesToSuperAdmin,
} from './content-manager/permission-and-upload';
import {
  ensureAdminRelationSearchFields,
  ensureNavigationIconPlacement,
  ensureRelationTargetFieldReadability,
} from './content-manager/relation-configuration';
import { ensureSectionLabels } from './content-manager/section-labels';

export async function bootstrapApplication(strapi: Core.Strapi): Promise<void> {
  await seedEntityCouponLayoutEditorPermission(strapi);
  warnIfTrustedIpsMissing(strapi);
  bootstrapCuratedOfferRelations(strapi);
  await reconcileDatabaseAfterSchemaSync(strapi);
  await initializeSearchRuntime(strapi);
  await hideRelationsFromContentManager(strapi);
  await hideFieldsFromComponentManager(strapi);
  await ensurePublicReadPermissions(strapi);
  await restrictSingleTypesToSuperAdmin(strapi);
  await ensureUploadSettings(strapi);
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
  warnIfUploadConfigurationIsUnsafe(strapi);
  startIsrOutbox(strapi);
}

export async function destroyApplication(): Promise<void> {
  await stopIsrOutbox();
}
