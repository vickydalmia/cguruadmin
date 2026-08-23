import type { Core } from '@strapi/strapi';
import {
  appendListColumns,
  isSortableListColumn,
  moveEditLayoutFieldAfter,
  pinFieldToFullRow,
  removeEditLayoutFields,
  type EditLayout,
} from '../utils/content-manager-layout';
import { type SectionLabel } from '../constants/homepage-sections';
import { AFFILIATE_OFFER_TOGGLE_FIELD } from '../constants/affiliate-offer';
import { OFFER_TAXONOMY_FIELDS } from '../constants/offer-taxonomy';

const HIDE_FROM_EDIT: Record<string, string[]> = {
  // Hidden here BECAUSE the Taxonomies panel owns them — the panel builds its
  // sections from the same OFFER_TAXONOMY_FIELDS constant
  // (src/admin/features/taxonomy-panel/config.ts), keeping the pair in sync.
  'api::deal.deal': [...OFFER_TAXONOMY_FIELDS],
  'api::coupon.coupon': [...OFFER_TAXONOMY_FIELDS],
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
// src/admin/features/taxonomy-panel) next to the Store/Brand pickers it gates
// — a second main-form control would duplicate it.
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
  AFFILIATE_OFFER_TOGGLE_FIELD,
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
  'festival.coupon-category-tab': 'labelOverride',
  'festival.coupon-store-tab': 'labelOverride',
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

export async function ensureComponentEntryTitles(strapi: Core.Strapi): Promise<void> {
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

// Category Section already has an icon field, but its persisted layout placed
// it below the large repeatable Links editor. Keep the same field and move it
// directly below Category so the override is discoverable.
export async function ensureNavigationIconPlacement(
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

export async function ensureSingleTypeEntryTitles(strapi: Core.Strapi): Promise<void> {
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
export async function ensureSectionLabels(
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

// Surface the coupon/deal `contentStatus` (published/scheduled/expired) as a
// column in the admin list view so editors can see and filter by it — expired
// offers are already hidden from the public API, but the admin list mixed them
// in with no signal (QC: separate expired). Idempotent: appends the column
// once, after hideRelationsFromContentManager has trimmed the relation columns.
export async function ensureOfferListStatusColumn(strapi: Core.Strapi): Promise<void> {
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

export async function ensureFullWidthEditFields(strapi: Core.Strapi): Promise<void> {
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

export async function ensureSortableListColumns(strapi: Core.Strapi): Promise<void> {
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
