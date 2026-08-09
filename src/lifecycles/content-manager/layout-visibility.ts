import type { Core } from '@strapi/strapi';

import { removeEditLayoutFields } from '../../utils/content-manager-layout';

const HIDE_FROM_EDIT: Record<string, string[]> = {
  'api::deal.deal': ['stores', 'brands', 'categories', 'banks'],
  'api::coupon.coupon': ['stores', 'brands', 'categories', 'banks'],
  // Offer membership is maintained from Coupon/Deal records. Entity editors
  // use the dedicated Top Pick and Ordered Coupon panels; Deals remain fully
  // automatic, so none of these raw relation inputs belongs in the edit form.
  'api::store.store': [
    'coupons',
    'deals',
    'topPickCoupons',
    'orderedCoupons',
    'entityDealPageSeo',
  ],
  'api::brand.brand': [
    'coupons',
    'deals',
    'topPickCoupons',
    'orderedCoupons',
    'entityDealPageSeo',
  ],
  'api::bank.bank': [
    'coupons',
    'deals',
    'topPickCoupons',
    'orderedCoupons',
    'entityDealPageSeo',
  ],
  'api::category.category': [
    'coupons',
    'deals',
    'topPickCoupons',
    'orderedCoupons',
    'entityDealPageSeo',
  ],
};

// Fields edited ONLY in a side panel, never in the main form. The offer
// lifecycle fields live in the Publishing panel
// (src/admin/components/PublishingPanel.tsx), which presents them as a derived
// status badge plus "goes live" / "ends" choices — leaving them in the main
// form too would give an editor two controls for one value, including a
// contentStatus dropdown that looks editable but is overwritten on every save.
// The three benefit labels live in the Offer benefits panel
// (src/admin/components/OfferBenefitsPanel.tsx) so they read as one group.
// Product Deal discount prefix/amount live there too: the panel owns their
// paired validation and final-label preview.
// Unlike HIDE_FROM_EDIT these stay in the LIST layout: lifecycle fields are
// exactly the columns editors sort and filter offers by.
const OFFER_PANEL_ONLY_FIELDS = [
  'contentStatus',
  'publishedOn',
  'scheduledAt',
  'expiresAt',
  'cashbackText',
  'bankOfferText',
  'prepaidText',
];
const HIDE_FROM_EDIT_FORM_ONLY: Record<string, string[]> = {
  'api::coupon.coupon': OFFER_PANEL_ONLY_FIELDS,
  'api::deal.deal': [...OFFER_PANEL_ONLY_FIELDS, 'discountPrefix', 'discount'],
};

// Hero banners are repeatable components, so their row order is already
// controlled by drag-and-drop. Keep the legacy value in the schema/database
// for compatibility, but remove the duplicate numeric control from the editor.
const HIDE_FROM_COMPONENT_EDIT: Record<string, string[]> = {
  'homepage.slider-slide': ['order'],
};

/**
 * Drop fields from the content-manager EDIT layout, and — unless
 * `keepListColumns` — from the list layout too.
 *
 * Two callers with deliberately different scopes: relations moved into side
 * panels are gone from both views, while the offer lifecycle fields move into
 * the Publishing panel but stay as list columns editors sort and filter by.
 */
export async function hideFieldsFromContentManager(
  strapi: Core.Strapi,
  table: Record<string, string[]>,
  { keepListColumns = false }: { keepListColumns?: boolean } = {},
): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  for (const [uid, fieldsToHide] of Object.entries(table)) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType) continue;

      const config = await service.findConfiguration(contentType);
      const prevEdit = config.layouts?.edit ?? [];
      const prevList = config.layouts?.list ?? [];

      const nextEdit = removeEditLayoutFields(prevEdit, fieldsToHide) ?? prevEdit;
      const hidden = new Set(fieldsToHide);
      const nextList = keepListColumns
        ? prevList
        : prevList.filter((name: string) => !hidden.has(name));

      const changed =
        JSON.stringify(nextEdit) !== JSON.stringify(prevEdit) ||
        JSON.stringify(nextList) !== JSON.stringify(prevList);

      if (!changed) continue;

      await service.updateConfiguration(contentType, {
        settings: config.settings,
        metadatas: config.metadatas,
        layouts: { ...config.layouts, edit: nextEdit, list: nextList },
        options: config.options,
      });
      strapi.log.info(`[content-manager] hid fields from ${uid} layout`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] failed to rewrite layout for ${uid}: ${err?.message ?? err}`
      );
    }
  }
}

export async function hideRelationsFromContentManager(strapi: Core.Strapi): Promise<void> {
  await hideFieldsFromContentManager(strapi, HIDE_FROM_EDIT);
  await hideFieldsFromContentManager(strapi, HIDE_FROM_EDIT_FORM_ONLY, {
    keepListColumns: true,
  });
}

export async function hideFieldsFromComponentManager(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('components');
  if (!service) return;

  for (const [uid, fieldsToHide] of Object.entries(HIDE_FROM_COMPONENT_EDIT)) {
    try {
      const component = service.findComponent(uid);
      if (!component) continue;

      const config = await service.findConfiguration(component);
      const prevEdit = config.layouts?.edit ?? [];
      const nextEdit = removeEditLayoutFields(prevEdit, fieldsToHide);
      if (!nextEdit) continue;

      await service.updateConfiguration(component, {
        ...config,
        layouts: { ...config.layouts, edit: nextEdit },
      });
      strapi.log.info(`[content-manager] hid fields from ${uid} component layout`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] failed to rewrite component layout for ${uid}: ${err?.message ?? err}`,
      );
    }
  }
}
