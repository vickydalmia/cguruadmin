import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';
import { join } from 'node:path';
import { RECORD_LOCK_LEASE_HEADER } from './constants/record-lock';
import { DOTD_SECTION_LABELS, DOTD_UID } from './constants/deal-of-the-day-sections';
import {
  INDEPENDENCE_DAY_SALE_SECTION_LABELS,
  INDEPENDENCE_DAY_SALE_UID,
} from './constants/independence-day-sale-sections';
import { HOMEPAGE_IMAGE_RULES, imageRuleDescription } from './constants/homepage-images';
import { CULTURE_GALLERY_MEDIA_FOLDER_NAME } from './constants/media-folders';
import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_UID,
  type SectionLabel,
} from './constants/homepage-sections';
import { purgeResponseCaches } from './middlewares/cache';
import { hasTrustedIpsConfigured } from './middlewares/rate-limit';
import { initializeSearchRuntime } from './api/search/services/search';
import {
  createOutboxPayload,
  mergeScope,
  offerEntityTypeFromUid,
  outboxPayloadSummary,
} from './isr-outbox/payload';
import { logIsrOutbox } from './isr-outbox/log';
import {
  startIsrOutbox,
  stopIsrOutbox,
  wakeIsrOutbox,
} from './isr-outbox/runtime';
import { runContentTransaction } from './isr-outbox/transaction';
import {
  entityPublicIdentityChanged,
  isPopularSearchEntityUid,
} from './isr-outbox/popular-search-invalidation';
import {
  purgeEntityPopularSearchCatalog,
} from './api/store/services/entity-popular-searches';
import type {
  OfferInvalidation,
  ScopeRequest,
} from './isr-outbox/types';
import {
  computeScope,
  FESTIVE_OFFER_ENTITY_UIDS,
  isRedirectNoteOnlyChange,
  preDeleteScope,
  type FestiveOfferSnapshot,
} from './isr-outbox/scopes';
import {
  appendListColumns,
  isSortableListColumn,
  moveEditLayoutFieldAfter,
  pinFieldToFullRow,
  removeEditLayoutFields,
  type EditLayout,
} from './utils/content-manager-layout';
import {
  ensureAdminRelationSearchFieldsForUid,
  getAdminRelationSearchFields,
  groupAdminRelationSearchFields,
} from './utils/content-manager-relation-search';
import {
  changedFieldHints,
  changedFieldSeoHints,
} from './utils/changed-field-validation';
import { WORD_LIMITS, BENEFIT_TEXT_FIELDS } from './utils/offer-field-validation';
import {
  benefitFieldHint,
  offerAmountFieldHint,
} from './utils/offer-word-limits';
import { textFieldHints } from './utils/text-field-validation';
// Every write validator now runs through this one pipeline, which reports all
// of their problems in a single error instead of the first one it hits.
import { runWriteValidation } from './utils/write-validation/run';
import {
  getCuratedOfferRelations,
  registerCuratedOfferRelationQueryFilter,
  removeInactiveCuratedOfferRelations,
} from './utils/curated-offer-relations';
import {
  changesEntityOfferMembership,
  touchEntityPageUpdatedAt,
} from './utils/entity-page-timestamp';
import {
  ENTITY_COUPON_LAYOUT_ACTION,
  ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES,
} from './api/entity-coupon-layout/services/entity-coupon-layout';
import {
  CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME,
  CHECKOUT_MERCHANT_FIELD,
} from './constants/checkout-merchant';
import { clearDeletedCheckoutMerchant } from './utils/checkout-merchant-validation';
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
// The affiliate toggle lives in the Taxonomies panel (AffiliateOfferToggle in
// src/admin/app.tsx) next to the Store/Brand pickers it gates — a second
// main-form control would duplicate it.
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
  'isForAffiliateBrand',
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

// Write actions the edit lock guards. `create`/`clone` are absent on purpose:
// for collection types they have no existing documentId, so there is nothing
// to lock. Single types are the exception — their first-ever save IS a
// create, and the middleware enforces that case separately.
const LOCK_ENFORCED_ACTIONS = new Set([
  'update',
  'delete',
  'publish',
  'unpublish',
  'discardDraft',
]);

const DOCUMENT_WRITE_ACTIONS = new Set([
  'create',
  'clone',
  'update',
  'delete',
  'publish',
  'unpublish',
  'discardDraft',
]);

/**
 * Drop fields from the content-manager EDIT layout, and — unless
 * `keepListColumns` — from the list layout too.
 *
 * Two callers with deliberately different scopes: relations moved into side
 * panels are gone from both views, while the offer lifecycle fields move into
 * the Publishing panel but stay as list columns editors sort and filter by.
 */
async function hideFieldsFromContentManager(
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

async function hideRelationsFromContentManager(strapi: Core.Strapi): Promise<void> {
  await hideFieldsFromContentManager(strapi, HIDE_FROM_EDIT);
  await hideFieldsFromContentManager(strapi, HIDE_FROM_EDIT_FORM_ONLY, {
    keepListColumns: true,
  });
}

async function hideFieldsFromComponentManager(strapi: Core.Strapi): Promise<void> {
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

// All site content is public; make sure the public role can read it so the
// static-site build and browser flows work on any fresh environment.
// Intentional: this re-grants on every boot, so revoking one of these read
// permissions in the admin UI will not stick across a restart — remove the
// action from this list instead. Same applies to ensureUploadSettings below.
// coupon/deal are intentionally excluded: their core routes are disabled and
// the public frontend reads offers only through the custom controllers, which
// control populate and never expose the unique-code pool.
const PUBLIC_READ_ACTIONS = [
  ...['store', 'brand', 'category', 'bank'].flatMap(
    (name) => [`api::${name}.${name}.find`, `api::${name}.${name}.findOne`]
  ),
  ...['homepage', 'global', 'menu', 'footer', 'error-page', 'career-page'].map(
    (name) => `api::${name}.${name}.find`
  ),
  'api::job.job.find',
  'api::job.job.findOne',
  // The storefront middleware reads the active redirect map on every request.
  // Without this the fetch 403s and get-redirects fails open to an empty
  // table, so every authored redirect silently stops firing.
  'api::redirect.redirect.find',
];

async function ensurePublicReadPermissions(strapi: Core.Strapi): Promise<void> {
  const publicRole = await strapi
    .query('plugin::users-permissions.role')
    .findOne({ where: { type: 'public' } });

  if (!publicRole) {
    strapi.log.warn('[permissions] public role not found; skipping grant');
    return;
  }

  let granted = 0;
  for (const action of PUBLIC_READ_ACTIONS) {
    const existing = await strapi
      .query('plugin::users-permissions.permission')
      .findOne({ where: { action, role: publicRole.id } });

    if (!existing) {
      await strapi
        .query('plugin::users-permissions.permission')
        .create({ data: { action, role: publicRole.id } });
      granted += 1;
    }
  }

  if (granted > 0) {
    strapi.log.info(`[permissions] granted ${granted} public read permissions`);
  }
}

// Media Library settings live in the DB plugin store (not file config).
// Ensure responsive formats + optimization + orientation are on everywhere.
async function ensureUploadSettings(strapi: Core.Strapi): Promise<void> {
  const uploadService: any = strapi.plugin('upload').service('upload');
  const current = (await uploadService.getSettings()) ?? {};
  const desired = {
    ...current,
    sizeOptimization: true,
    responsiveDimensions: true,
    autoOrientation: true,
  };

  if (JSON.stringify(desired) !== JSON.stringify(current)) {
    await uploadService.setSettings(desired);
    strapi.log.info('[upload] enabled sizeOptimization/responsiveDimensions/autoOrientation');
  }
}

async function ensureCultureGalleryMediaFolder(
  strapi: Core.Strapi,
): Promise<void> {
  const folders: any = strapi.db.query('plugin::upload.folder');
  const existing = await folders.findOne({
    where: { name: CULTURE_GALLERY_MEDIA_FOLDER_NAME },
    select: ['id'],
  });
  if (existing) return;

  await strapi.plugin('upload').service('folder').create({
    name: CULTURE_GALLERY_MEDIA_FOLDER_NAME,
    parent: null,
  });
  strapi.log.info(
    `[upload] created ${CULTURE_GALLERY_MEDIA_FOLDER_NAME} media folder`,
  );
}

// Content Manager "Entry title" per component — the text field shown as the
// collapsed label of each repeatable entry (e.g. hero banners show altText
// instead of the link URL). Strapi has no schema.json knob for this; it lives
// in the DB config store, so pin it here (config-as-code, survives DB wipes).
const COMPONENT_ENTRY_TITLES: Record<string, string> = {
  'homepage.slider-slide': 'altText',
  // NOTE: relations are NOT usable here — server validation accepts them but
  // the 5.39 admin edit form crashes rendering `{connect, disconnect}` state
  // as the row label. Text fields only; the *_Override fields render blank
  // when unset (the related deal/coupon supplies the real title at runtime).
  'home.hero-product': 'titleOverride',
  'home.top-offer-item': 'offerTextOverride',
  'home.exclusive-item': 'titleOverride',
  'home.coupon-card-item': 'titleOverride',
  'home.bank-offer-item': 'subtitle',
  'home.explore-tab': 'labelOverride',
  'home.explore-offer-tab': 'labelOverride',
  'home.step': 'title',
  'home.why-feature': 'label',
  'home.top-offers': 'heading',
  'home.popular-stores': 'heading',
  'home.deal-list': 'heading',
  'home.cg-exclusive': 'heading',
  'home.explore-deals': 'heading',
  'home.explore-offers': 'heading',
  'home.offer-list': 'heading',
  'home.newly-added': 'heading',
  'home.bank-offers': 'heading',
  'home.how-it-works': 'heading',
  'home.faq-block': 'heading',
  'home.popular-searches': 'heading',
  'home.latest-insights': 'heading',
  'deal-day.deals-by-store': 'heading',
  'deal-day.store-tab': 'labelOverride',
  'deal-day.telegram-deals': 'heading',
  'deal-day.telegram-deal-item': 'titleOverride',
  'deal-day.section-heading': 'heading',
  'shared.cta': 'label',
  'shared.telegram-cta': 'heading',
  'shared.newsletter': 'heading',
  'shared.section-header': 'heading',
  'shared.paragraph': 'body',
  'shared.icon-card': 'title',
  'shared.stat': 'label',
  // Year over title: a collapsed timeline reads as 2011 / 2014 / 2018, which
  // is what an editor scans for when reordering milestones.
  'shared.milestone': 'year',
  'shared.logo-item': 'name',
  'shared.breadcrumb-item': 'label',
  'about.hero': 'heading',
  'about.founder': 'name',
  'career.hero': 'heading',
  'career.benefit-card': 'title',
  'career.value-card': 'title',
  'career.jobs-section': 'heading',
  'career.life': 'imageAlt',
  'career.job-detail-copy': 'formHeading',
  'contact.hero': 'heading',
  'contact.contact-method': 'title',
  'contact.topic': 'label',
  'contact.form': 'heading',
  'faq.category': 'title',
  'faq.faq-item': 'question',
  'faq.support-cta': 'heading',
  'error-page.hero': 'heading',
  'error-page.link-card': 'title',
  'error-page.explore': 'heading',
  'error-page.trust-banner': 'heading',
  'nav.link': 'label',
  'nav.category-section': 'title',
  'footer.link-section': 'title',
  'footer.social-link': 'platform',
  'footer.country': 'name',
};

async function ensureComponentEntryTitles(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('components');
  if (!service) return;

  for (const [uid, mainField] of Object.entries(COMPONENT_ENTRY_TITLES)) {
    try {
      const component = service.findComponent(uid);
      if (!component) continue;
      if (!strapi.components[uid as any]?.attributes?.[mainField]) {
        strapi.log.warn(`[content-manager] ${uid} has no field "${mainField}" — entry title skipped`);
        continue;
      }

      const config = await service.findConfiguration(component);
      if (config?.settings?.mainField === mainField) continue;

      await service.updateConfiguration(component, {
        ...config,
        settings: { ...config.settings, mainField },
      });
      strapi.log.info(`[content-manager] entry title for ${uid} → ${mainField}`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] failed to set entry title for ${uid}: ${err?.message ?? err}`
      );
    }
  }
}

// Native relation search reads mainField from the SOURCE component relation
// metadata. This configuration is strictly for Content Manager: it changes
// which visible text Admin searches and never touches public query filters,
// relation data, or ISR.
async function ensureAdminRelationSearchFields(
  strapi: Core.Strapi
): Promise<void> {
  const grouped = groupAdminRelationSearchFields(
    getAdminRelationSearchFields(strapi)
  );
  const failed: string[] = [];

  for (const [uid, fields] of grouped) {
    try {
      const ok = await ensureAdminRelationSearchFieldsForUid(
        strapi,
        uid,
        fields
      );
      if (!ok) failed.push(uid);
    } catch (err: any) {
      strapi.log.error(
        `[content-manager] admin relation search for ${uid} failed: ${err?.message ?? err}`
      );
      failed.push(uid);
    }
  }

  if (failed.length > 0) {
    strapi.log.error(
      `[content-manager] admin relation search configuration failed for `
      + `${failed.join(', ')} — title search in these pickers may fall back to IDs`
    );
  }
}

// A role whose Content Manager read permission on a picker target omits the
// searched text field makes Strapi silently search documentId instead — title
// search then never matches for users of that role only. Surface it at boot;
// never auto-grant (permission seeding elsewhere in this file is deliberate).
async function ensureRelationTargetFieldReadability(
  strapi: Core.Strapi
): Promise<void> {
  const mainFieldByTarget = new Map<string, string>();
  for (const { targetUid, mainField } of getAdminRelationSearchFields(strapi)) {
    mainFieldByTarget.set(targetUid, mainField);
  }
  if (mainFieldByTarget.size === 0) return;

  try {
    const [permissions, roles]: [any[], any[]] = await Promise.all([
      strapi.db.query('admin::permission').findMany({
        where: {
          action: 'plugin::content-manager.explorer.read',
          subject: { $in: [...mainFieldByTarget.keys()] },
        },
        populate: ['role'],
      }),
      strapi.db.query('admin::role').findMany({
        where: { code: { $ne: 'strapi-super-admin' } },
      }),
    ]);

    for (const role of roles) {
      for (const [subject, mainField] of mainFieldByTarget) {
        const rolePermissions = permissions.filter(
          (permission) =>
            permission.subject === subject && permission.role?.id === role.id
        );
        const canReadMainField = rolePermissions.some((permission) => {
          const fields = permission.properties?.fields;
          return !Array.isArray(fields) || fields.includes(mainField);
        });
        if (canReadMainField) continue;

        strapi.log.error(
          `[permissions] role "${role.code}" cannot read ${subject}.${mainField} — `
          + `relation pickers targeting it will silently search documentId for `
          + `these users`
        );
      }
    }
  } catch (err: any) {
    strapi.log.error(
      `[permissions] relation search readability check failed: ${err?.message ?? err}`
    );
  }
}

// Category Section already has an icon field, but its persisted layout placed
// it below the large repeatable Links editor. Keep the same field and move it
// directly below Category so the override is discoverable.
async function ensureNavigationIconPlacement(
  strapi: Core.Strapi
): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('components');
  if (!service) return;

  try {
    const component = service.findComponent('nav.category-section');
    if (!component) return;
    const config = await service.findConfiguration(component);
    const edit = moveEditLayoutFieldAfter(
      config.layouts?.edit ?? [],
      'icon',
      'category',
    );
    if (!edit) return;

    await service.updateConfiguration(component, {
      ...config,
      layouts: { ...config.layouts, edit },
    });
    strapi.log.info(
      '[content-manager] navigation Category icon placed below Category'
    );
  } catch (err: any) {
    strapi.log.warn(
      `[content-manager] navigation icon placement failed: ${err?.message ?? err}`
    );
  }
}

// Field help text pinned into the Content Manager on every boot. Homepage
// image guidance is derived from HOMEPAGE_IMAGE_RULES so the enforced size and
// instruction cannot drift; other business-input guidance is declared here.
// Uses the same DB config store + config-as-code approach as entry titles.
// Exported for hint-coverage.test.ts only.
export const COMPONENT_FIELD_DESCRIPTIONS: Record<string, Record<string, string>> = {};
for (const rule of HOMEPAGE_IMAGE_RULES) {
  (COMPONENT_FIELD_DESCRIPTIONS[rule.componentUid] ??= {})[rule.field] =
    imageRuleDescription(rule);
}
(COMPONENT_FIELD_DESCRIPTIONS['shared.seo'] ??= {}).canonicalUrl =
  'Enter only a URL or site path, for example /airport-tour-coupons/. Do not paste HTML such as <link rel="canonical" href="..." />.';
COMPONENT_FIELD_DESCRIPTIONS['shared.seo'].ogImage =
  'Share-card image shown when the page is shared on social apps. Recommended: at least 1200 × 630 px (1.91:1). Smaller images are allowed but may crop or blur in previews. Leave empty to use the site default card.';
(COMPONENT_FIELD_DESCRIPTIONS['shared.entity-deal-page-seo'] ??= {}).ogImage =
  'Share-card image shown when the deal page is shared on social apps. Recommended: at least 1200 × 630 px (1.91:1). Smaller images are allowed but may crop or blur in previews. Leave empty to use the site default card.';
(COMPONENT_FIELD_DESCRIPTIONS['homepage.slider-slide'] ??= {}).link =
  'Optional banner destination. Use /path/ for a CouponzGuru page or a full http(s) URL. CouponzGuru links open in this tab and remain followed; external links open in a new tab with nofollow. Leave empty for a non-clickable banner.';
(COMPONENT_FIELD_DESCRIPTIONS['deal-day.telegram-deal-item'] ??= {}).deal =
  'The Product Deal shown as a locked Telegram card. Its promo code is never sent to the site for this section.';
COMPONENT_FIELD_DESCRIPTIONS['deal-day.telegram-deal-item'].linkOverride =
  'Optional. Telegram post URL for this deal — used only by this section. Leave empty to send visitors to the deal’s affiliate link. Enter a full http(s) URL.';
COMPONENT_FIELD_DESCRIPTIONS['deal-day.telegram-deal-item'].titleOverride =
  'Optional. Leave blank to use the selected Deal title.';
(COMPONENT_FIELD_DESCRIPTIONS['nav.category-section'] ??= {}).category =
  'Preferred destination. When selected, the menu links to this Category and uses its icon unless an Icon override is uploaded below.';
COMPONENT_FIELD_DESCRIPTIONS['nav.category-section'].url =
  'Optional custom destination used only when no Category is selected. Enter a rooted site path or full http(s) URL.';
COMPONENT_FIELD_DESCRIPTIONS['nav.category-section'].icon =
  'Square menu icon. Leave empty to reuse the selected Category icon; upload one when this group uses a custom URL without a Category. It renders at 24px on desktop and 20px on mobile.';
COMPONENT_FIELD_DESCRIPTIONS['nav.category-section'].links =
  'Ordered child links. They render below the group on desktop and in the mobile drill-down panel; upload each child Icon for the mobile design and enable Bold only for links that need emphasis.';
(COMPONENT_FIELD_DESCRIPTIONS['nav.link'] ??= {}).icon =
  'Optional icon override for category drill-down rows. Leave empty to reuse the linked Category icon; custom category links can upload their own square icon.';
(COMPONENT_FIELD_DESCRIPTIONS['header.coupon-notification'] ??= {}).coupon =
  'Select the Coupon shown in this header notification row.';
COMPONENT_FIELD_DESCRIPTIONS['header.coupon-notification'].titleOverride =
  'Optional. Leave blank to use the selected Coupon title.';
COMPONENT_FIELD_DESCRIPTIONS['header.coupon-notification'].imageOverride =
  'Optional. Leave blank to use the selected Coupon’s related Store, Brand, Bank, or Category media. Maximum 80 × 80 px; a square image is recommended.';
(COMPONENT_FIELD_DESCRIPTIONS['header.product-deal-notification'] ??= {}).productDeal =
  'Select the Product Deal shown in this header notification row.';
COMPONENT_FIELD_DESCRIPTIONS['header.product-deal-notification'].titleOverride =
  'Optional. Leave blank to use the selected Product Deal title.';
COMPONENT_FIELD_DESCRIPTIONS['header.product-deal-notification'].imageOverride =
  'Optional. Leave blank to use the selected Product Deal image. Maximum 80 × 80 px; a square image is recommended.';
(COMPONENT_FIELD_DESCRIPTIONS['header.notification'] ??= {}).coupon =
  'Coupon notifications. Add one row per Coupon; each row can configure its own title and image overrides.';
COMPONENT_FIELD_DESCRIPTIONS['header.notification'].productDeal =
  'Product Deal notifications. Add one row per Product Deal; each row can configure its own title and image overrides.';
// The upload service can select a quality profile only while it still has the
// camera original. The dedicated folder is therefore the explicit editorial
// signal; linking an already-compressed root-folder asset cannot restore lost
// detail later when the Culture entry is saved.
(COMPONENT_FIELD_DESCRIPTIONS['culture.gallery-photo'] ??= {}).image =
  `Upload original photographs to the “${CULTURE_GALLERY_MEDIA_FOLDER_NAME}” Media Library folder, then select them here. ` +
  'Use JPG, PNG or WebP at 2560px or more on the longest side; this folder keeps a 2560px quality-90 WebP master and single-generation responsive images. Other Media Library folders keep the standard lighter profile.';

async function ensureComponentFieldDescriptions(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('components');
  if (!service) return;

  for (const [uid, fields] of Object.entries(COMPONENT_FIELD_DESCRIPTIONS)) {
    try {
      const component = service.findComponent(uid);
      if (!component) continue;

      const config = await service.findConfiguration(component);
      const metadatas = { ...(config.metadatas ?? {}) };
      let changed = false;

      for (const [field, description] of Object.entries(fields)) {
        if (!strapi.components[uid as any]?.attributes?.[field]) {
          strapi.log.warn(`[content-manager] ${uid} has no field "${field}" — description skipped`);
          continue;
        }
        const prev = metadatas[field] ?? {};
        if (prev.edit?.description === description) continue;
        metadatas[field] = { ...prev, edit: { ...(prev.edit ?? {}), description } };
        changed = true;
      }

      if (!changed) continue;
      await service.updateConfiguration(component, { ...config, metadatas });
      strapi.log.info(`[content-manager] field descriptions set for ${uid}`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] field descriptions for ${uid} failed: ${err?.message ?? err}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Editor-facing field hints for every validated field
// ---------------------------------------------------------------------------
// Every field a write-time validator enforces gets a grey description hint
// under it in the admin edit form, visible BEFORE the editor types — so limits
// are learnable without tripping them. Hints for rules living in
// changed-field-validation.ts and text-field-validation.ts are DERIVED from
// those rule tables (single source of truth). Rules owned by other validators
// are mirrored by hand below; each entry names the file it mirrors — keep them
// in step when that validator changes. hint-coverage.test.ts asserts the
// derived tables stay fully wired.

// DERIVED from the same tables the validator enforces (offer-word-limits.ts
// via offer-field-validation.ts), so the hint can never drift from the rule.
// offerText belongs only to Coupons; both offer types carry benefit fields.
const OFFER_WORD_CAP_HINTS = WORD_LIMITS.map(({ field, max }) => ({
  field,
  hint: `Up to ${max} word${max === 1 ? '' : 's'} — fills a fixed card slot.`,
}));
const OFFER_BENEFIT_HINTS = BENEFIT_TEXT_FIELDS.map(({ field, suffix }) => ({
  field,
  hint: benefitFieldHint(suffix),
}));

const VALIDATOR_MIRROR_HINTS: Array<{ uid: string; field: string; hint: string }> = [
  ...[
    { uid: 'api::coupon.coupon', hints: [...OFFER_WORD_CAP_HINTS, ...OFFER_BENEFIT_HINTS] },
    {
      uid: 'api::deal.deal',
      hints: [
        ...OFFER_BENEFIT_HINTS,
        {
          field: 'discount',
          hint: offerAmountFieldHint('the selected prefix and any applicable OFF suffix'),
        },
        {
          field: 'discountPrefix',
          hint: 'Required when a discount amount is entered.',
        },
      ],
    },
  ].flatMap(({ uid, hints }) => [
    ...hints.map(({ field, hint }) => ({ uid, field, hint })),
    {
      uid,
      field: 'logoStore',
      hint:
        'Optional image source only. The site borrows this Store logo; it does ' +
        'not add Store membership, ownership, search matching, or Store-page placement. ' +
        'Hidden and cleared automatically for affiliate-brand offers.',
    },
    // Mirrors checkout-merchant-validation.ts: the reference must resolve to a
    // live row, and it is nulled automatically if that row is later deleted.
    {
      uid,
      field: 'checkoutMerchant',
      hint:
        'Optional. One Store OR Brand — the merchant the shopper actually ' +
        'checks out with. Search the dropdown to see both; each option is ' +
        'tagged Store or Brand. Like Logo Store, this adds no membership, ' +
        'ownership or search matching. Hidden and cleared automatically for ' +
        'affiliate-brand offers.',
    },
    // Mirrors offer-lifecycle-validation.ts: past dates rejected, scheduledAt
    // must precede expiresAt, contentStatus derived from these two dates.
    {
      uid,
      field: 'scheduledAt',
      hint:
        'Optional. Must be in the future and before Expires at; leave empty to ' +
        'publish immediately. Status is set automatically from these dates.',
    },
    {
      uid,
      field: 'expiresAt',
      hint:
        'Optional. Must be in the future and after Scheduled at; leave empty to ' +
        'keep the offer live. Status is set automatically from these dates.',
    },
    // Mirrors offer-lifecycle-validation.ts: no future dates, seeded at go-live,
    // and deliberately NOT part of the published/scheduled/expired state machine.
    {
      uid,
      field: 'publishedOn',
      hint:
        'Drives "newest first" ordering on the site. Set automatically when the ' +
        'offer goes live — move it forward (or use "Bump to top") to resurface ' +
        'this offer above older ones. Cannot be in the future, and never changes ' +
        'the status: re-dating an expired offer leaves it expired.',
    },
  ]),
  // Deal content is optional: the site always renders a pre-calculated
  // Deal Price / MRP / Discount block (src/utils/deal-computed-content.ts);
  // anything written here is shown after it as "Any Other Condition".
  {
    uid: 'api::deal.deal',
    field: 'content',
    hint:
      'Optional. The site automatically shows Deal Price (bold), MRP and ' +
      'Discount from the pricing fields — anything written here appears ' +
      'after them under "Any Other Condition".',
  },
  // Mirrors coupon-type-consistency.ts: code and uniqueCouponPool are mutually
  // exclusive, keyed off couponType.
  {
    uid: 'api::coupon.coupon',
    field: 'code',
    hint:
      'Shared code for "static" coupons. Cleared automatically when Coupon ' +
      'type is "unique".',
  },
  {
    uid: 'api::coupon.coupon',
    field: 'uniqueCouponPool',
    hint:
      'Required when Coupon type is "unique" — codes are handed out from this ' +
      'pool. Cleared automatically for static coupons.',
  },
  // Mirrors festive-offer-consistency.ts (clearing) and the checkFestiveOffer
  // rule in entity-field-validation.ts (both fields required when on). The
  // 60-character cap on the title is NOT restated here — changedFieldHints()
  // derives "Up to 60 characters." from the rule that enforces it, and both
  // hints are appended to the same field.
  ...['api::store.store', 'api::brand.brand'].flatMap((uid) => [
    {
      uid,
      field: 'isFestiveOffer',
      hint:
        'Turns on the festive offer title and description below. Switching it ' +
        'off CLEARS both of them on save — they are not kept in the background.',
    },
    {
      uid,
      field: 'festiveOfferTitle',
      hint: 'Required while "Is festive offer" is on.',
    },
    {
      uid,
      field: 'festiveOfferDescription',
      hint:
        'Required while "Is festive offer" is on. Rendered as formatted text ' +
        'on the site.',
    },
  ]),
  // Mirrors affiliate-offer-consistency.ts: affiliate-brand offers can only
  // select affiliate Brands, and the flag cannot be dropped while referenced.
  {
    uid: 'api::brand.brand',
    field: 'isAffiliateStore',
    hint:
      'Marks this Brand as an affiliate store. Offers with the "Affiliate ' +
      'brand offer" toggle on can only select affiliate Brands. Cannot be ' +
      'switched off while such offers still reference this Brand.',
  },
  // Mirrors redirect-validation.ts: from must be a rooted on-site path that
  // shadows nothing live; to must be a rooted path or absolute http(s) URL
  // and must not close a loop.
  {
    uid: 'api::redirect.redirect',
    field: 'from',
    hint:
      'Path on this site starting with "/", e.g. /old-page. Must not be a ' +
      "live page, a reserved route, or another active redirect's From.",
  },
  {
    uid: 'api::redirect.redirect',
    field: 'to',
    hint:
      'Path starting with "/" or a full http(s):// address. Must not point ' +
      'back at From or close a redirect loop.',
  },
  {
    uid: 'api::menu.menu',
    field: 'topStoresLabel',
    hint:
      'Label used by the desktop and mobile Top Stores navigation trigger and panel heading.',
  },
  {
    uid: 'api::menu.menu',
    field: 'topStoresTitle',
    hint:
      'Label on the All Stores control shown in both desktop and mobile store menus.',
  },
  {
    uid: 'api::menu.menu',
    field: 'topStoresViewAllUrl',
    hint:
      'Destination for the All Stores control. Enter a rooted site path or full http(s) URL.',
  },
  {
    uid: 'api::menu.menu',
    field: 'categoriesLabel',
    hint:
      'Label used by the desktop navigation trigger, desktop mega-menu heading, and mobile Categories panel.',
  },
  {
    uid: 'api::menu.menu',
    field: 'categoriesTitle',
    hint:
      'Label on the All Categories control shown in both desktop and mobile category menus.',
  },
  {
    uid: 'api::menu.menu',
    field: 'categoriesPopularStoresTitle',
    hint:
      'Heading above the first four configured Top Stores in the mobile Categories drill-down.',
  },
  {
    uid: 'api::menu.menu',
    field: 'categoriesViewAllUrl',
    hint:
      'Destination for the All Categories control. Enter a rooted site path or full http(s) URL.',
  },
  {
    uid: 'api::menu.menu',
    field: 'notification',
    hint:
      'Header notifications are managed together here. Add as many Coupon and Product Deal rows as needed.',
  },
  // Mirrors identity-validation.ts: name unique per type; slug unique across
  // all four taxonomies and off the reserved-route list.
  ...['store', 'brand', 'category', 'bank'].flatMap((name) => [
    {
      uid: `api::${name}.${name}`,
      field: 'name',
      hint:
        `Unique among ${name.endsWith('y') ? `${name.slice(0, -1)}ies` : `${name}s`} — ` +
        'compared ignoring capitalisation and surrounding spaces.',
    },
    {
      uid: `api::${name}.${name}`,
      field: 'slug',
      hint:
        'Public URL segment. Must be unique across stores, brands, categories ' +
        'and banks, and must not match a reserved page or an active redirect.',
    },
    {
      uid: `api::${name}.${name}`,
      field: 'showTrendingDeals',
      hint:
        'Show automatically selected live Product Deals on this entity page. ' +
        'Turn this off to hide the entire Trending Deals section.',
    },
  ]),
];

// Merge the three hint sources. When several validators constrain the same
// field the sentences are concatenated (required-ness first, then format
// limits, then the mirrored notes), so the editor sees one combined hint.
// Exported for hint-coverage.test.ts only.
export const CONTENT_TYPE_FIELD_HINTS: Record<string, Record<string, string>> = {};
{
  const componentHints: Record<string, Record<string, string>> = {};
  const append = (
    table: Record<string, Record<string, string>>,
    key: string,
    field: string,
    hint: string,
  ) => {
    if (!hint) return;
    const fields = (table[key] ??= {});
    const prev = fields[field];
    fields[field] = prev ? (prev.includes(hint) ? prev : `${prev} ${hint}`) : hint;
  };

  for (const entry of textFieldHints()) {
    if (entry.componentUid) {
      append(componentHints, entry.componentUid, entry.field, entry.hint);
    } else {
      append(CONTENT_TYPE_FIELD_HINTS, entry.uid, entry.field, entry.hint);
    }
  }
  for (const { uid, field, hint } of changedFieldHints()) {
    append(CONTENT_TYPE_FIELD_HINTS, uid, field, hint);
  }
  for (const { componentUid, field, hint } of changedFieldSeoHints()) {
    append(componentHints, componentUid, field, hint);
  }
  for (const { uid, field, hint } of VALIDATOR_MIRROR_HINTS) {
    append(CONTENT_TYPE_FIELD_HINTS, uid, field, hint);
  }
  // Component hints ride the existing component pass. An explicit description
  // declared above (homepage images, the canonicalUrl HTML warning) always
  // wins over a derived hint — skip keys already present.
  for (const [componentUid, fields] of Object.entries(componentHints)) {
    for (const [field, hint] of Object.entries(fields)) {
      if (COMPONENT_FIELD_DESCRIPTIONS[componentUid]?.[field]) continue;
      (COMPONENT_FIELD_DESCRIPTIONS[componentUid] ??= {})[field] = hint;
    }
  }
}

// Editor-facing LABELS for top-level attributes whose auto-derived name reads
// badly. Content-manager titlecases the attribute name, so `publishedOn`
// surfaces as "Published On" — nearly indistinguishable from Strapi's own
// internal `publishedAt`, which is exactly the confusion this field exists to
// remove. Applied to BOTH the edit and list metadata: `publishedOn` is a
// sortable list column, so the table header needs the same name the Publishing
// panel uses or the two views disagree about what the field is called.
const CONTENT_TYPE_FIELD_LABELS: Record<string, Record<string, string>> = {
  'api::coupon.coupon': {
    publishedOn: 'Published date',
    logoStore: 'Logo Store (image only)',
    checkoutMerchant: 'Checkout merchant (Store or Brand)',
    isForAffiliateBrand: 'Affiliate brand offer',
  },
  'api::deal.deal': {
    publishedOn: 'Published date',
    logoStore: 'Logo Store (image only)',
    checkoutMerchant: 'Checkout merchant (Store or Brand)',
    isForAffiliateBrand: 'Affiliate brand offer',
  },
  'api::menu.menu': {
    notification: 'Notification',
    topStoresLabel: 'Top Stores navigation label',
    topStoresTitle: 'All Stores button label',
    topStoresViewAllUrl: 'All Stores button URL',
    categoriesLabel: 'Categories navigation label',
    categoriesTitle: 'All Categories button label',
    categoriesPopularStoresTitle: 'Mobile Popular Stores heading',
    categoriesViewAllUrl: 'All Categories button URL',
  },
  ...Object.fromEntries(
    ['store', 'category', 'bank'].map((name) => [
      `api::${name}.${name}`,
      { showTrendingDeals: 'Show Trending Deals' },
    ]),
  ),
  // Brand gets the shared label plus its own — an explicit key after the
  // spread REPLACES the spread's entry, so both must live here together.
  'api::brand.brand': {
    showTrendingDeals: 'Show Trending Deals',
    isAffiliateStore: 'Affiliate Store',
  },
};

// Content-type counterpart of ensureComponentFieldDescriptions: pins the
// merged hints into metadatas[attr].edit.description (and the labels above into
// metadatas[attr].edit.label) for top-level attributes. Same DB config store +
// config-as-code + idempotent-boot approach — second restart compares equal and
// logs nothing.
async function ensureFieldDescriptions(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  const uids = new Set([
    ...Object.keys(CONTENT_TYPE_FIELD_HINTS),
    ...Object.keys(CONTENT_TYPE_FIELD_LABELS),
  ]);

  for (const uid of uids) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType) continue;

      const config = await service.findConfiguration(contentType);
      const metadatas = { ...(config.metadatas ?? {}) };
      let changed = false;

      const fields = CONTENT_TYPE_FIELD_HINTS[uid] ?? {};
      const labels = CONTENT_TYPE_FIELD_LABELS[uid] ?? {};

      for (const field of new Set([...Object.keys(fields), ...Object.keys(labels)])) {
        if (!contentType.attributes?.[field]) {
          strapi.log.warn(`[content-manager] ${uid} has no field "${field}" — description skipped`);
          continue;
        }
        const description = fields[field];
        const label = labels[field];
        const mainField = field === 'logoStore' ? 'name' : undefined;
        const prev = metadatas[field] ?? {};
        const descriptionSettled =
          description === undefined || prev.edit?.description === description;
        const labelSettled =
          label === undefined ||
          (prev.edit?.label === label && prev.list?.label === label);
        const mainFieldSettled =
          mainField === undefined || prev.edit?.mainField === mainField;
        if (descriptionSettled && labelSettled && mainFieldSettled) continue;

        metadatas[field] = {
          ...prev,
          edit: {
            ...(prev.edit ?? {}),
            ...(description === undefined ? {} : { description }),
            ...(label === undefined ? {} : { label }),
            ...(mainField === undefined ? {} : { mainField }),
          },
          // The list header reads metadatas[field].list.label, a separate key
          // from the edit one — set both or the table column keeps the
          // auto-derived "Published On".
          list: {
            ...(prev.list ?? {}),
            ...(label === undefined ? {} : { label }),
          },
        };
        changed = true;
      }

      if (!changed) continue;
      await service.updateConfiguration(contentType, {
        settings: config.settings,
        metadatas,
        layouts: config.layouts,
        options: config.options,
      });
      strapi.log.info(`[content-manager] field descriptions set for ${uid}`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] field descriptions for ${uid} failed: ${err?.message ?? err}`
      );
    }
  }
}

// Single types' edit-view headers show their mainField — pin it to the
// `title` attribute ("Homepage"/"Menu"/"Footer") instead of opaque IDs.
const SINGLE_TYPE_ENTRY_TITLES = [
  'api::homepage.homepage',
  'api::deal-of-the-day-page.deal-of-the-day-page',
  'api::independence-day-sale-page.independence-day-sale-page',
  'api::menu.menu',
  'api::footer.footer',
  'api::global.global',
  'api::error-page.error-page',
  'api::career-page.career-page',
  'api::contact-page.contact-page',
  'api::faq-page.faq-page',
  'api::testimonials-page.testimonials-page',
  'api::partner-with-us-page.partner-with-us-page',
  'api::privacy-policy-page.privacy-policy-page',
  'api::terms-and-conditions-page.terms-and-conditions-page',
  'api::affiliate-disclosure-page.affiliate-disclosure-page',
  'api::culture-page.culture-page',
] as const;

async function ensureSingleTypeEntryTitles(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  for (const uid of SINGLE_TYPE_ENTRY_TITLES) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType?.attributes?.title) continue;

      const config = await service.findConfiguration(contentType);
      if (config?.settings?.mainField === 'title') continue;

      await service.updateConfiguration(contentType, {
        ...config,
        settings: { ...config.settings, mainField: 'title' },
      });
      strapi.log.info(`[content-manager] entry title for ${uid} → title`);
    } catch (err: any) {
      strapi.log.warn(`[content-manager] entry title for ${uid} failed: ${err?.message ?? err}`);
    }
  }
}

// Single-type section labels/help text live in src/constants/*-sections.ts
// (the homepage set is shared with the admin bundle). Pinned into the
// content-manager view config on every boot — manual "Configure the view"
// edits to these attributes will not stick; edit the shared constant instead.
async function ensureSectionLabels(
  strapi: Core.Strapi,
  uid: string,
  labels: SectionLabel[],
): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  try {
    const contentType = strapi.contentType(uid as any);
    if (!contentType) return;

    const config = await service.findConfiguration(contentType);

    const metadatas = { ...(config.metadatas ?? {}) };
    let metaChanged = false;
    for (const { attr, label, description } of labels) {
      if (!contentType.attributes?.[attr]) {
        strapi.log.warn(`[content-manager] ${uid} has no attribute "${attr}" — label skipped`);
        continue;
      }
      const prev = metadatas[attr] ?? {};
      if (prev.edit?.label === label && prev.edit?.description === description) continue;
      metadatas[attr] = { ...prev, edit: { ...(prev.edit ?? {}), label, description } };
      metaChanged = true;
    }

    // Edit-form order = live page order: one row per attribute in the order
    // above, keeping each cell's stored size; attributes added later (not in
    // the list yet) are appended at the end rather than dropped.
    const prevEdit: any[][] = config.layouts?.edit ?? [];
    const cellsByName = new Map<string, any>();
    for (const row of prevEdit) for (const cell of row) cellsByName.set(cell.name, cell);

    const listed = new Set(labels.map(({ attr }) => attr));
    const ordered = labels.map(({ attr }) => cellsByName.get(attr)).filter(Boolean);
    const leftovers = [...cellsByName.values()].filter((cell) => !listed.has(cell.name));
    const nextEdit = [...ordered, ...leftovers].map((cell) => [cell]);

    const layoutChanged = JSON.stringify(nextEdit) !== JSON.stringify(prevEdit);
    if (!metaChanged && !layoutChanged) return;

    await service.updateConfiguration(contentType, {
      settings: config.settings,
      metadatas,
      layouts: { ...config.layouts, edit: layoutChanged ? nextEdit : prevEdit },
      options: config.options,
    });
    strapi.log.info(`[content-manager] ${uid} section labels & form order pinned`);
  } catch (err: any) {
    strapi.log.warn(
      `[content-manager] ${uid} section labels failed: ${err?.message ?? err}`
    );
  }
}

// When an editor picks a coupon/deal/category/bank in a homepage component
// and leaves the override text empty, snapshot the related record's title
// into the override after save — so admin rows always carry a visible label.
// Runs on the component rows directly (db layer), never re-enters the
// document service, and touches only EMPTY override fields.
const OVERRIDE_FILLS: Array<{
  componentUid: string;
  overrideField: string;
  relationField: string;
  relationLabel: string;
}> = [
  { componentUid: 'home.hero-product', overrideField: 'titleOverride', relationField: 'deal', relationLabel: 'title' },
  { componentUid: 'home.top-offer-item', overrideField: 'offerTextOverride', relationField: 'coupon', relationLabel: 'title' },
  { componentUid: 'home.exclusive-item', overrideField: 'titleOverride', relationField: 'coupon', relationLabel: 'title' },
  { componentUid: 'home.coupon-card-item', overrideField: 'titleOverride', relationField: 'coupon', relationLabel: 'title' },
  { componentUid: 'home.explore-tab', overrideField: 'labelOverride', relationField: 'category', relationLabel: 'name' },
  { componentUid: 'home.explore-offer-tab', overrideField: 'labelOverride', relationField: 'category', relationLabel: 'name' },
  { componentUid: 'home.bank-offer-item', overrideField: 'subtitle', relationField: 'bank', relationLabel: 'shortDescription' },
  { componentUid: 'deal-day.store-tab', overrideField: 'labelOverride', relationField: 'store', relationLabel: 'name' },
  { componentUid: 'deal-day.telegram-deal-item', overrideField: 'titleOverride', relationField: 'deal', relationLabel: 'title' },
];

async function fillHomepageOverrides(strapi: Core.Strapi): Promise<void> {
  for (const fill of OVERRIDE_FILLS) {
    const rows = await strapi.db.query(fill.componentUid as any).findMany({
      where: { $or: [{ [fill.overrideField]: null }, { [fill.overrideField]: '' }] },
      populate: [fill.relationField],
    });

    for (const row of rows) {
      const label = row[fill.relationField]?.[fill.relationLabel];
      if (typeof label === 'string' && label.trim()) {
        await strapi.db.query(fill.componentUid as any).update({
          where: { id: row.id },
          data: { [fill.overrideField]: label.trim() },
        });
      }
    }
  }
}

// Single types only Super Admin may manage. Footer & Global Settings drive the
// whole site's chrome, so a stray edit is high-blast-radius (QC: restrict to
// Super Admin). Enforced as config-as-code: every boot strips the
// content-manager (explorer) permissions for these subjects from every
// non-super-admin admin role, so re-granting them in the Roles UI will not
// stick — the same stance as ensurePublicReadPermissions above. Super Admin
// bypasses permission checks entirely, so it always keeps access.
const SUPER_ADMIN_ONLY_SUBJECTS = ['api::footer.footer', 'api::global.global'];

async function restrictSingleTypesToSuperAdmin(strapi: Core.Strapi): Promise<void> {
  try {
    const roles = await strapi.db.query('admin::role').findMany({ select: ['id', 'code'] });
    let removed = 0;
    for (const role of roles) {
      if (role.code === 'strapi-super-admin') continue;
      const perms = await strapi.db.query('admin::permission').findMany({
        where: { role: role.id, subject: { $in: SUPER_ADMIN_ONLY_SUBJECTS } },
        select: ['id', 'action'],
      });
      const ids = perms
        .filter((p: any) => String(p.action).startsWith('plugin::content-manager.explorer'))
        .map((p: any) => p.id);
      if (ids.length) {
        await strapi.db.query('admin::permission').deleteMany({ where: { id: { $in: ids } } });
        removed += ids.length;
      }
    }
    if (removed > 0) {
      strapi.log.info(
        `[permissions] removed ${removed} Footer/Global permission(s) from non-super-admin roles`
      );
    }
  } catch (err: any) {
    strapi.log.warn(`[permissions] super-admin lock failed: ${err?.message ?? err}`);
  }
}

// Surface the coupon/deal `contentStatus` (published/scheduled/expired) as a
// column in the admin list view so editors can see and filter by it — expired
// offers are already hidden from the public API, but the admin list mixed them
// in with no signal (QC: separate expired). Idempotent: appends the column
// once, after hideRelationsFromContentManager has trimmed the relation columns.
async function ensureOfferListStatusColumn(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  for (const uid of ['api::coupon.coupon', 'api::deal.deal']) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType?.attributes?.contentStatus) continue;

      const config = await service.findConfiguration(contentType);
      const list: string[] = config.layouts?.list ?? [];
      if (list.includes('contentStatus')) continue;

      await service.updateConfiguration(contentType, {
        settings: config.settings,
        metadatas: config.metadatas,
        layouts: { ...config.layouts, list: [...list, 'contentStatus'] },
        options: config.options,
      });
      strapi.log.info(`[content-manager] added contentStatus column to ${uid} list`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] failed to add status column to ${uid}: ${err?.message ?? err}`
      );
    }
  }
}

// Content-manager sizes a `string` input at 6 of 12 columns, so a Coupon's
// title renders half-width beside offerText. Title is the longest value an
// editor types and the one they scan the form for, so give it a whole row.
// Same DB config store + config-as-code approach as the layouts above:
// resizing it back in "Configure the view" will not survive a restart.
const EDIT_FULL_WIDTH_FIELDS: Record<string, string[]> = {
  'api::coupon.coupon': ['title'],
};

async function ensureFullWidthEditFields(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  for (const [uid, fields] of Object.entries(EDIT_FULL_WIDTH_FIELDS)) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType) continue;

      const config = await service.findConfiguration(contentType);
      let edit: EditLayout = config.layouts?.edit ?? [];
      const widened: string[] = [];

      for (const field of fields) {
        if (!contentType.attributes?.[field]) {
          strapi.log.warn(`[content-manager] ${uid} has no field "${field}" — full width skipped`);
          continue;
        }
        const next = pinFieldToFullRow(edit, field);
        if (!next) continue;
        edit = next;
        widened.push(field);
      }

      if (!widened.length) continue;
      await service.updateConfiguration(contentType, {
        settings: config.settings,
        metadatas: config.metadatas,
        layouts: { ...config.layouts, edit },
        options: config.options,
      });
      strapi.log.info(`[content-manager] ${uid} full-width fields: ${widened.join(', ')}`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] full-width layout for ${uid} failed: ${err?.message ?? err}`
      );
    }
  }
}

// The admin list view can only sort by a column it DISPLAYS, and the default
// layout is just the first four listable attributes — which is why scheduling
// dates could not be sorted on offers, and why Bank offered nothing worth
// ordering by. Pin the useful sortable columns per list. Bank deliberately
// skips slug (sorts the same as name), the long descriptions and the logo
// (media is never sortable).
const LIST_SORT_COLUMNS: Record<string, string[]> = {
  'api::coupon.coupon': ['publishedOn', 'scheduledAt', 'expiresAt'],
  'api::deal.deal': ['publishedOn', 'scheduledAt', 'expiresAt'],
  'api::bank.bank': ['name', 'isVerified', 'ratingAverage', 'ratingCount'],
};

async function ensureSortableListColumns(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  for (const [uid, columns] of Object.entries(LIST_SORT_COLUMNS)) {
    try {
      const contentType = strapi.contentType(uid as any);
      if (!contentType) continue;

      const usable = columns.filter((name) => {
        const attribute = contentType.attributes?.[name];
        if (!attribute) {
          strapi.log.warn(`[content-manager] ${uid} has no field "${name}" — column skipped`);
          return false;
        }
        if (!isSortableListColumn(attribute)) {
          strapi.log.warn(
            `[content-manager] ${uid}.${name} is a ${attribute.type} — not sortable, column skipped`
          );
          return false;
        }
        return true;
      });
      if (!usable.length) continue;

      const config = await service.findConfiguration(contentType);
      const prevList: string[] = config.layouts?.list ?? [];
      const nextList = appendListColumns(prevList, usable);

      // Displaying a column is not enough: the header renders a sort control
      // only when its metadata says sortable, and that flag is togglable per
      // field in "Configure the view". Re-assert it for the columns we pin.
      const metadatas = { ...(config.metadatas ?? {}) };
      const unsortable = usable.filter((name) => metadatas[name]?.list?.sortable === false);
      for (const name of unsortable) {
        const prev = metadatas[name];
        metadatas[name] = { ...prev, list: { ...prev.list, sortable: true } };
      }

      if (!nextList && !unsortable.length) continue;
      await service.updateConfiguration(contentType, {
        settings: config.settings,
        metadatas,
        layouts: { ...config.layouts, list: nextList ?? prevList },
        options: config.options,
      });
      strapi.log.info(
        `[content-manager] ${uid} sortable columns pinned: ${(nextList ?? prevList)
          .slice(prevList.length)
          .concat(unsortable.map((name) => `${name} (re-enabled)`))
          .join(', ')}`
      );
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] sortable columns for ${uid} failed: ${err?.message ?? err}`
      );
    }
  }
}

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

    // Entity Deal-page settings endpoints, mounted on the ADMIN router rather
    // than under src/api/entity-deal-page/routes.
    //
    // registerAPIRoutes forces `type: 'content-api'` on every router loaded
    // from src/api/*/routes, and `route.info.type` is what selects the auth
    // strategy set. The content API serves only api-token and
    // users-permissions, so an admin-panel session authenticating these routes
    // there is impossible — and `ctx.state.user` would be a
    // plugin::users-permissions.user, which super-admin-only must never look up
    // against the unrelated admin::user id space.
    //
    // Registering here is safe: the user `register` lifecycle runs before
    // `server.initRouting()` (Strapi.register → Strapi.bootstrap). The admin
    // router mounts with an empty prefix, so these serve at
    // /entity-deal-page/pages — there is no /api segment.
    const entityDealPageAdminPolicies = [
      'admin::isAuthenticatedAdmin',
      'global::super-admin-only',
    ];
    strapi.server.routes({
      type: 'admin',
      prefix: '/entity-deal-page',
      routes: [
        {
          method: 'GET',
          path: '/pages',
          handler: 'api::entity-deal-page.entity-deal-page.adminList',
          config: { policies: entityDealPageAdminPolicies },
        },
        {
          method: 'PATCH',
          path: '/pages/:kind/:documentId',
          handler: 'api::entity-deal-page.entity-deal-page.adminUpdate',
          config: { policies: entityDealPageAdminPolicies },
        },
        // Same handler under PUT. PATCH is the documented verb and the correct
        // one for a partial merge, but the admin panel's fetch client
        // (useFetchClient) only exposes get/post/put/del — no patch — and the
        // settings screen must not reimplement admin token handling just to
        // reach this endpoint. Both verbs merge; neither replaces.
        {
          method: 'PUT',
          path: '/pages/:kind/:documentId',
          handler: 'api::entity-deal-page.entity-deal-page.adminUpdate',
          config: { policies: entityDealPageAdminPolicies },
        },
      ],
    } as any);

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

    // Coupon layout is deliberately outside Content Manager's generic
    // relation update route. GET remains authenticated-only so restricted
    // editors can see saved counts and an actionable disabled-state reason;
    // the controller applies both the feature action and model read/update
    // capability before candidates, preview or writes are allowed.
    strapi.server.routes({
      type: 'admin',
      prefix: '/entity-coupon-layout',
      routes: [
        {
          method: 'GET',
          path: '/refresh/:outboxId',
          handler:
            'api::entity-coupon-layout.entity-coupon-layout.refresh',
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
        {
          method: 'GET',
          path: '/:kind/:documentId',
          handler: 'api::entity-coupon-layout.entity-coupon-layout.get',
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
        {
          method: 'GET',
          path: '/:kind/:documentId/candidates',
          handler:
            'api::entity-coupon-layout.entity-coupon-layout.candidates',
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
        {
          method: 'POST',
          path: '/:kind/:documentId/preview',
          handler:
            'api::entity-coupon-layout.entity-coupon-layout.preview',
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
        {
          method: 'PUT',
          path: '/:kind/:documentId',
          handler: 'api::entity-coupon-layout.entity-coupon-layout.replace',
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
      ],
    } as any);

    // Edit-lock endpoints for the Content Manager edit view (RecordLockPanel
    // in src/admin/app.tsx). Admin router for the same reason as the
    // entity-deal-page settings routes above: src/api/*/routes cannot
    // authenticate an admin session.
    strapi.server.routes({
      type: 'admin',
      prefix: '/record-lock',
      routes: [
        {
          method: 'POST',
          path: '/acquire',
          handler: 'api::record-lock.record-lock.acquire',
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
        {
          method: 'POST',
          path: '/release',
          handler: 'api::record-lock.record-lock.release',
          config: { policies: ['admin::isAuthenticatedAdmin'] },
        },
      ],
    } as any);

    // Enforce edit locks server-side. The RecordLockPanel warning alone would
    // be advisory — an admin who ignores it (or opened the entry before the
    // panel loaded) could still overwrite the holder's work. Scoped to
    // Content Manager requests carrying an admin user so crons, the ISR
    // outbox, redeem flows and other server-initiated writes are untouched.
    strapi.documents.use(async (context: any, next: any) => {
      // Cheap action gate FIRST: this middleware sits in front of every
      // document-service call — findMany/findOne/count on public API
      // requests, crons, the ISR outbox — and getModel() is an O(registry)
      // scan, so it must only run for actions that can possibly be enforced.
      const enforceable =
        LOCK_ENFORCED_ACTIONS.has(context.action) ||
        context.action === 'create';
      if (!enforceable) return next();
      const isSingleType =
        strapi.getModel(context.uid as any)?.kind === 'singleType';
      // Single types additionally enforce `create`: their FIRST-ever save
      // runs as the create action (no document row exists yet), but they are
      // locked regardless of existence — without this, two admins could race
      // on a never-saved single type straight past each other's lock.
      // Collection-type create stays exempt: nothing exists to lock.
      if (context.action === 'create' && !isSingleType) return next();
      const documentId = context.params?.documentId;
      if (
        !isSingleType &&
        (typeof documentId !== 'string' || documentId === '')
      ) {
        return next();
      }
      const ctx = strapi.requestContext.get();
      const user = ctx?.state?.user;
      if (!user || !ctx?.request?.url?.startsWith('/content-manager/')) {
        return next();
      }
      // The record-lock service resolves the single-type pseudo id itself —
      // pass documentId through as-is (undefined for single types).
      const holder = await strapi
        .service('api::record-lock.record-lock')
        .activeHolder(context.uid, isSingleType ? undefined : documentId);
      // No active lock: ALLOW. Locks exist only while an edit view is open
      // on this entry — list-view row delete, bulk publish/unpublish and
      // plugin content types (which the panel never locks) all arrive
      // without one and must keep working. This guard's only job is to
      // protect a HELD lock from every other session.
      if (!holder) return next();
      if (holder.adminUserId !== user.id) {
        throw new errors.ApplicationError(
          `This entry is currently being edited by ${holder.holderName}. ` +
            'Come back later — your change was NOT saved.',
        );
      }
      const leaseId =
        ctx.get?.(RECORD_LOCK_LEASE_HEADER) ??
        ctx.request?.headers?.[RECORD_LOCK_LEASE_HEADER];
      if (typeof leaseId !== 'string' || holder.leaseId !== leaseId) {
        // Same admin, but the write does not come from the tab holding the
        // lease (another tab, a list-view bulk action, a reload's new
        // session) — the holding tab's work must not be overwritten.
        throw new errors.ApplicationError(
          'This entry is locked by another of your browser tabs. Your change ' +
            'was NOT saved. Finish there, or use "Take over editing here" on ' +
            'this entry’s edit screen.',
        );
      }
      return next();
    });

    strapi.documents.use(async (context: any, next: any) => {
      if (!DOCUMENT_WRITE_ACTIONS.has(context.action)) return next();

      // Normalise the payload, then run every editor-facing validator and
      // report ALL of their problems in one error — see
      // src/utils/write-validation/run.ts for the pipeline and
      // src/utils/write-validation/steps.ts for the ordered step registry.
      // Before this was extracted, twelve validators were awaited inline here
      // and the first to throw hid the other eleven, so an editor fixed one
      // problem per save.
      //
      // Slug and redirect invariants are validated with plain reads and
      // committed by an INDEPENDENT write — two concurrent saves can both pass
      // validation on the same committed snapshot and both commit: one flat
      // route claimed by two taxonomy types (the ISR server silently drops the
      // loser), case-folded duplicate redirect `from`s, or /a→/b + /b→/a
      // closing a cycle. A unique index on the NORMALIZED values cannot be
      // added over legacy duplicates (identity-validation.ts), so the pipeline
      // serializes that window with one advisory lock per invariant domain,
      // and hands the release back here because the lock must stay held until
      // the write below has COMMITTED. No-op on non-Postgres; on lock failure
      // the save proceeds unserialized (the pre-existing rare race, never an
      // outage).
      const releaseWriteLock = await runWriteValidation(strapi, context);
      try {
        // Redirect `note` is editor-only metadata, but the redirect UID scopes
        // to a FULL sweep (scopes.ts). Read the material fields before the
        // write so a note-only edit can skip the rebuild entirely (redirects
        // have draftAndPublish:false — update IS the live write). A failed
        // read means unknown before-state → keep the sweep.
        let redirectBefore: Record<string, unknown> | null = null;
        if (
          context.uid === 'api::redirect.redirect' &&
          context.action === 'update' &&
          context.params?.documentId
        ) {
          try {
            redirectBefore = await strapi
              .documents('api::redirect.redirect')
              .findOne({
                documentId: context.params.documentId,
                fields: ['from', 'to', 'statusCode', 'active'] as any,
              });
          } catch {
            redirectBefore = null;
          }
        }

        // Was this offer live before the write? Only the expiry cron feeds
        // `changedOffers`, so an editor unpublishing by hand in Content
        // Manager reached no cleanup at all and left the coupon sitting in
        // curated relations until the NIGHTLY full scan — up to a day of a
        // dead Top Pick in a layout, and a layout the save then refused.
        // Expiry and delete were already covered (the cron flips status and
        // feeds itself; deletes cascade); this closes the remaining path.
        let offerWasPublished = false;
        if (
          offerEntityTypeFromUid(context.uid) &&
          context.params?.documentId &&
          ['update', 'unpublish', 'discardDraft'].includes(context.action)
        ) {
          try {
            const before: any = await strapi
              .documents(context.uid)
              .findOne({
                documentId: context.params.documentId,
                fields: ['contentStatus'] as any,
              });
            offerWasPublished = before?.contentStatus === 'published';
          } catch {
            offerWasPublished = false;
          }
        }

        // Offer changes: capture relations BEFORE the write. For deletes the
        // doc disappears entirely; for updates a relation may be REMOVED — the
        // removed store/bank/category/brand page must also rebuild, so the
        // final scope is the union of before + after relations.
        let preScope: ScopeRequest | null = null;
        if (['delete', 'update', 'publish', 'unpublish', 'discardDraft'].includes(context.action)) {
          try {
            preScope = await preDeleteScope(
              strapi,
              context.uid,
              context.params?.documentId,
              context.action
            );
          } catch {
            preScope = null;
          }
        }

        let entityIdentityBefore: { name?: unknown; slug?: unknown } | null = null;
        if (
          context.action === 'update' &&
          isPopularSearchEntityUid(context.uid) &&
          context.params?.documentId
        ) {
          try {
            entityIdentityBefore = await strapi.documents(context.uid).findOne({
              documentId: context.params.documentId,
              fields: ['name', 'slug'] as any,
            });
          } catch {
            entityIdentityBefore = null;
          }
        }

        // Festive fields BEFORE the write. The content-manager form submits
        // the full document, so computeScope cannot tell "festive edited"
        // from "festive merely present" by looking at the payload — without
        // this snapshot every Store/Brand save would escalate to a full-site
        // rebuild (see festiveOfferChanged in isr-outbox/scopes.ts). A failed
        // read stays null, which fails toward invalidation, never away.
        let festiveOfferBefore: FestiveOfferSnapshot | null = null;
        if (
          context.action === 'update' &&
          FESTIVE_OFFER_ENTITY_UIDS.has(context.uid) &&
          context.params?.documentId
        ) {
          try {
            festiveOfferBefore = await strapi.documents(context.uid).findOne({
              documentId: context.params.documentId,
              fields: [
                'isFestiveOffer',
                'festiveOfferTitle',
                'festiveOfferDescription',
              ] as any,
            });
          } catch {
            festiveOfferBefore = null;
          }
        }

        return await runContentTransaction(
          strapi,
          () => next(),
          async (result, trx) => {
            if (
              context.action === 'update' &&
              changesEntityOfferMembership(context.uid, context.params?.data)
            ) {
              // `trx`, not a pool connection: the write above still holds this
              // row's lock until this callback returns, so a second connection
              // touching it would deadlock with no timeout.
              await touchEntityPageUpdatedAt(
                strapi,
                trx,
                context.uid,
                result,
                context.params?.documentId,
              );
            }

            // checkoutMerchant is a custom STRING field, not a relation, so
            // deleting a Store or Brand leaves every offer that pointed at it
            // holding a reference to a row that is gone — the one thing a
            // foreign key's ON DELETE SET NULL would have handled for free.
            // Do it by hand, in this transaction, so the clear commits with
            // the delete or not at all.
            //
            // strapi.db.query joins the ambient transaction through
            // AsyncLocalStorage (AGENTS.md); a raw strapi.db.connection write
            // here would take a second pool connection and deadlock against
            // the row locks the delete still holds.
            if (
              context.action === 'delete' &&
              context.params?.documentId &&
              (context.uid === 'api::store.store' ||
                context.uid === 'api::brand.brand')
            ) {
              try {
                const cleared = await clearDeletedCheckoutMerchant(
                  strapi,
                  context.uid === 'api::store.store' ? 'store' : 'brand',
                  context.params.documentId,
                );
                if (cleared > 0) {
                  strapi.log.info(
                    `[${CHECKOUT_MERCHANT_FIELD}] cleared ${cleared} offer ` +
                      `reference(s) to deleted ${context.uid} ` +
                      `${context.params.documentId}`,
                  );
                }
              } catch (err: any) {
                // Never block the delete on the cleanup. A leftover reference
                // is caught by validateCheckoutMerchantForWrite on the next
                // save of that offer, which is a recoverable state; a delete
                // that half-fails inside a content transaction is not.
                strapi.log.warn(
                  `[${CHECKOUT_MERCHANT_FIELD}] cleanup failed for ` +
                    `${context.uid} ${context.params.documentId}: ` +
                    `${err?.message ?? err}`,
                );
              }
            }

            if (
              [
                'api::homepage.homepage',
                'api::deal-of-the-day-page.deal-of-the-day-page',
              ].includes(context.uid) &&
              ['create', 'update', 'publish'].includes(context.action)
            ) {
              try {
                await fillHomepageOverrides(strapi);
              } catch (err: any) {
                strapi.log.warn(
                  `[homepage] override auto-fill failed: ${err?.message ?? err}`,
                );
              }
            }

            const documentId =
              (result as any)?.documentId ?? context.params?.documentId;
            const afterScope =
              context.action === 'delete' && preScope
                ? null
                : await computeScope(
                    strapi,
                    context.uid,
                    context.action,
                    documentId,
                    context.params?.data,
                    festiveOfferBefore,
                  );
            let scope =
              context.action === 'delete'
                ? preScope ?? afterScope
                : mergeScope(preScope, afterScope);

            if (
              entityIdentityBefore &&
              isPopularSearchEntityUid(context.uid) &&
              documentId
            ) {
              const entityIdentityAfter: any = await strapi
                .documents(context.uid)
                .findOne({
                  documentId,
                  fields: ['name', 'slug'] as any,
                });
              if (
                entityPublicIdentityChanged(
                  entityIdentityBefore,
                  entityIdentityAfter,
                )
              ) {
                scope = mergeScope(scope, {
                  full: true,
                  refreshScopes: ['routes'],
                });
              }
            }

            // Popular-search leaderboard change detection was removed here by
            // deliberate product decision: it cost two full live-catalogue
            // scans per qualifying offer write (one inside this transaction)
            // solely to broadcast {full:true} when the global top-10 fallback
            // shifted. Sparse pages' borrowed rail may now drift until the
            // nightly unconditional {all:true} consistency event re-renders
            // everything (config/cron-tasks.ts) — an accepted ≤24h bound.

            if (
              scope &&
              redirectBefore &&
              isRedirectNoteOnlyChange(redirectBefore, context.params?.data)
            ) {
              logIsrOutbox(
                strapi,
                'info',
                'isr.outbox.redirect_note_only_skipped',
                { uid: context.uid, action: context.action, documentId },
              );
              scope = null;
            }

            // Strip this offer out of curated relations the moment it stops
            // being live. Runs INSIDE the write transaction (the Query Engine
            // picks up the ambient one), so a renderer can never observe the
            // page mid-way: either the unpublish and the relation removal are
            // both visible, or neither is. The entity pages are already in
            // `preScope`, so this needs no extra invalidation of its own.
            if (offerWasPublished && documentId) {
              try {
                const after: any = await strapi
                  .documents(context.uid)
                  .findOne({
                    documentId,
                    fields: ['contentStatus'] as any,
                  });
                if (after && after.contentStatus !== 'published') {
                  await removeInactiveCuratedOfferRelations(strapi, new Date(), {
                    [context.uid]: [documentId],
                  } as any);
                }
              } catch (err: any) {
                // Never fail the editor's write for this: the five-minute and
                // nightly passes still converge.
                strapi.log.warn(
                  `[curated-offers] inline cleanup failed for ${context.uid} ${documentId}: `
                  + `${err?.message ?? err}`,
                );
              }
            }

            const offerInvalidations: OfferInvalidation[] = [];
            const entityType = offerEntityTypeFromUid(context.uid);
            if (
              entityType &&
              documentId &&
              [
                'create',
                'clone',
                'update',
                'publish',
                'unpublish',
                'discardDraft',
                'delete',
              ].includes(context.action)
            ) {
              offerInvalidations.push({ entityType, documentId });
            }

            if (!scope && offerInvalidations.length === 0) return null;
            return {
              payload: createOutboxPayload(scope ?? {}, offerInvalidations),
              reason: `${context.uid} ${context.action}`,
            };
          },
          (event) => {
            if (!event) return;
            // Only after the database commit: renderers must never observe
            // invalidation before the content and its durable outbox event.
            purgeResponseCaches();
            purgeEntityPopularSearchCatalog();
            logIsrOutbox(strapi, 'info', 'isr.outbox.enqueued', {
              outboxId: event.id,
              eventKey: event.eventKey,
              reason: event.reason,
              payload: outboxPayloadSummary(event.payload),
              uid: context.uid,
              action: context.action,
            });
            wakeIsrOutbox();
          },
        );
      } finally {
        if (releaseWriteLock) await releaseWriteLock();
      }
    });
  },

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    // Seed only once. The marker intentionally survives later manual
    // revocation, so a boot never grants this permission back behind an
    // administrator's back.
    //
    // The marker key is versioned because the action used to be registered in
    // THIS lifecycle, which silently deleted the granted row on every boot
    // (see the registration site in `register` for why). Databases seeded
    // under the old key hold the marker but no permission, so they would never
    // be re-seeded. Bumping the key re-seeds each of them exactly once.
    try {
      const store = strapi.store({
        type: 'plugin',
        name: 'entity-coupon-layout',
      });
      const seeded = await store.get({ key: 'editor-permission-seeded-v2' });
      if (!seeded) {
        const editor = await strapi.db.query('admin::role').findOne({
          where: { code: 'strapi-editor' },
          select: ['id'],
        });
        if (editor) {
          const existing = await strapi.db.query('admin::permission').findOne({
            where: {
              role: editor.id,
              action: ENTITY_COUPON_LAYOUT_ACTION,
            },
            select: ['id'],
          });
          if (!existing) {
            await strapi.db.query('admin::permission').create({
              data: {
                action: ENTITY_COUPON_LAYOUT_ACTION,
                subject: null,
                properties: {},
                conditions: [],
                role: editor.id,
              },
            });
          }
        }
        await store.set({
          key: 'editor-permission-seeded-v2',
          value: true,
        });
      }
    } catch (err: any) {
      strapi.log.warn(
        `[permissions] entity Coupon layout Editor seed failed: ${err?.message ?? err}`,
      );
    }
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

    // User migrations run before Strapi's schema sync, so fresh databases do
    // not have the search tables when those migrations first execute. Retry
    // the same structural reconciliation here on every boot, after schema
    // sync. Healthy indexes are inspection-only; optional DDL failures are
    // logged and retried on the next boot without making Strapi unavailable.
    // Resolve from the application root rather than this compiled module's
    // directory: production runs dist/src/index.js while Strapi migrations
    // remain under <app>/database.
    const contentContractPath = join(
      (strapi as any).dirs.app.root,
      'database',
      'content-contract-reconciliation.js'
    );
    const { reconcileContentContractAfterSchemaSync } = require(
      contentContractPath
    );
    await reconcileContentContractAfterSchemaSync(
      (strapi as any).db.connection,
      strapi.log
    );

    const siteSelectionPath = join(
      (strapi as any).dirs.app.root,
      'database',
      'site-selection-reconciliation.js'
    );
    const { reconcileSiteSelectionsAfterSchemaSync } = require(
      siteSelectionPath
    );
    await reconcileSiteSelectionsAfterSchemaSync(
      (strapi as any).db.connection,
      strapi.log
    );

    // This page originally reused the Homepage category component. It now has
    // a festival-only component so Content Manager can enforce max: 4 without
    // reducing Homepage's eight-tab allowance. Preserve already-authored tabs
    // after the new component tables exist; repeated boots are a no-op.
    const festivalCategoryTabsPath = join(
      (strapi as any).dirs.app.root,
      'database',
      'festival-category-tabs-reconciliation.js'
    );
    const { reconcileFestivalCategoryTabsAfterSchemaSync } = require(
      festivalCategoryTabsPath
    );
    await reconcileFestivalCategoryTabsAfterSchemaSync(
      (strapi as any).db.connection,
      strapi.log
    );

    const searchIndexMigrationPath = join(
      (strapi as any).dirs.app.root,
      'database',
      'search-index-migration.js'
    );
    const { reconcileSearchIndexesAfterSchemaSync } = require(
      searchIndexMigrationPath
    );
    await reconcileSearchIndexesAfterSchemaSync(
      (strapi as any).db.connection,
      strapi.log
    );
    const uniqueCodeIntegrityPath = join(
      (strapi as any).dirs.app.root,
      'database',
      'unique-code-integrity.js'
    );
    const { reconcileUniqueCodeIntegrityAfterSchemaSync } = require(
      uniqueCodeIntegrityPath
    );
    await reconcileUniqueCodeIntegrityAfterSchemaSync(
      (strapi as any).db.connection,
      strapi.log
    );
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
