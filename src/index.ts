import type { Core } from '@strapi/strapi';
import { join } from 'node:path';
import { DOTD_SECTION_LABELS, DOTD_UID } from './constants/deal-of-the-day-sections';
import { HOMEPAGE_IMAGE_RULES, imageRuleDescription } from './constants/homepage-images';
import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_UID,
  type SectionLabel,
} from './constants/homepage-sections';
import { purgeResponseCaches } from './middlewares/cache';
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
import type {
  OfferInvalidation,
  ScopeRequest,
} from './isr-outbox/types';
import {
  computeScope,
  isRedirectNoteOnlyChange,
  preDeleteScope,
} from './isr-outbox/scopes';
import {
  appendListColumns,
  isSortableListColumn,
  pinFieldToFullRow,
  type EditLayout,
} from './utils/content-manager-layout';
import {
  changedFieldHints,
  changedFieldSeoHints,
  validateChangedFields,
} from './utils/changed-field-validation';
import { validateEntityFieldsForWrite } from './utils/entity-field-validation';
import {
  isEntityTopPickUid,
  validateEntityTopPickCoupons,
} from './utils/entity-top-pick-validation';
import { validateDealOfTheDaySectionLimits } from './utils/deal-of-the-day-validation';
import { validateHomepageImages } from './utils/homepage-image-validation';
import {
  isCouponUid,
  normaliseCouponTypeFields,
  validateCouponTypeFields,
} from './utils/coupon-type-consistency';
import { isIdentityUid, validateIdentity } from './utils/identity-validation';
import {
  isOfferLifecycleUid,
  validateOfferLifecycle,
} from './utils/offer-lifecycle-validation';
import { validateOfferFieldsForWrite, WORD_LIMITS } from './utils/offer-field-validation';
import { validateRedirect } from './utils/redirect-validation';
import { sanitizeRichtextData } from './utils/sanitize-richtext';
import { acquireWriteSerializationLock } from './utils/write-serialization';
import { isHumanWrite } from './utils/write-origin';
import {
  normaliseTextFields,
  textFieldHints,
  validateTextFieldsForWrite,
} from './utils/text-field-validation';
import { registerCuratedOfferRelationQueryFilter } from './utils/curated-offer-relations';
import { ensureTransparentDealImageForWrite } from './utils/deal-image-upload';
import {
  changesEntityOfferMembership,
  touchEntityPageUpdatedAt,
} from './utils/entity-page-timestamp';

const HIDE_FROM_EDIT: Record<string, string[]> = {
  'api::deal.deal': ['stores', 'brands', 'categories', 'banks'],
  'api::coupon.coupon': ['stores', 'brands', 'categories', 'banks'],
  'api::store.store': ['topPickCoupons'],
  'api::brand.brand': ['topPickCoupons'],
  'api::bank.bank': ['topPickCoupons'],
  'api::category.category': ['topPickCoupons'],
};

// The offer lifecycle fields are edited ONLY in the Publishing side panel
// (src/admin/components/PublishingPanel.tsx), which presents them as a derived
// status badge plus "goes live" / "ends" choices. Leaving them in the main form
// too would give an editor two controls for one value — including a
// contentStatus dropdown that looks editable but is overwritten on every save.
// Unlike HIDE_FROM_EDIT these stay in the LIST layout: they are exactly the
// columns editors sort and filter offers by.
const HIDE_FROM_EDIT_FORM_ONLY: Record<string, string[]> = {
  'api::coupon.coupon': ['contentStatus', 'publishedOn', 'scheduledAt', 'expiresAt'],
  'api::deal.deal': ['contentStatus', 'publishedOn', 'scheduledAt', 'expiresAt'],
};

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
      const hidden = new Set(fieldsToHide);

      const prevEdit = config.layouts?.edit ?? [];
      const prevList = config.layouts?.list ?? [];

      const nextEdit = prevEdit
        .map((row: any[]) => row.filter((cell) => !hidden.has(cell.name)))
        .filter((row: any[]) => row.length > 0);
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

// Word caps are DERIVED from WORD_LIMITS in offer-field-validation.ts (the same
// table the validator enforces), so the number in the hint can never drift from
// the number in the rule.
const OFFER_WORD_CAP_HINTS = WORD_LIMITS.map(({ field, max }) => ({
  field,
  hint: `Up to ${max} word${max === 1 ? '' : 's'} — fills a fixed card slot.`,
}));

const VALIDATOR_MIRROR_HINTS: Array<{ uid: string; field: string; hint: string }> = [
  ...['api::coupon.coupon', 'api::deal.deal'].flatMap((uid) => [
    ...OFFER_WORD_CAP_HINTS.map(({ field, hint }) => ({ uid, field, hint })),
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
  'api::coupon.coupon': { publishedOn: 'Published date' },
  'api::deal.deal': { publishedOn: 'Published date' },
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
        const prev = metadatas[field] ?? {};
        const descriptionSettled =
          description === undefined || prev.edit?.description === description;
        const labelSettled =
          label === undefined ||
          (prev.edit?.label === label && prev.list?.label === label);
        if (descriptionSettled && labelSettled) continue;

        metadatas[field] = {
          ...prev,
          edit: {
            ...(prev.edit ?? {}),
            ...(description === undefined ? {} : { description }),
            ...(label === undefined ? {} : { label }),
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
  'api::menu.menu',
  'api::footer.footer',
  'api::global.global',
  'api::error-page.error-page',
  'api::career-page.career-page',
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
  register({ strapi }: { strapi: Core.Strapi }) {
    // NOTE: no custom /_health route — Strapi core already serves /_health
    // (all methods, 204, no auth) and registers it BEFORE this lifecycle,
    // so a route here would be dead code. The docker healthcheck and
    // deploy.sh curl both hit the built-in.

    strapi.documents.use(async (context: any, next: any) => {
      if (!DOCUMENT_WRITE_ACTIONS.has(context.action)) return next();

      // "Clean as you touch": a human editing in the admin must save a FULLY
      // valid record — every rule enforced on the whole record, including
      // dirty untouched fields on WordPress-migrated rows. The status cron
      // (partial {contentStatus} writes over possibly-dirty rows) has no HTTP
      // request context, so it stays grandfathered/touched-only and never
      // throws on migrated data. Computed once; passed to each validator.
      const strictWrite = isHumanWrite(strapi);

      // Richtext fields hold HTML rendered raw on the public site — enforce
      // the migration-era allowlist on every write, whatever the editor.
      if (['create', 'update', 'clone'].includes(context.action)) {
        sanitizeRichtextData(context.uid, context.params?.data);
        // Trim/collapse before ANY validator reads a value, so what is checked
        // is byte-identical to what is stored. Collapse is string-only —
        // collapsing a text/richtext field would destroy paragraph breaks.
        normaliseTextFields(context.uid, context.action, context.params?.data);
      }

      // Product Deal media is a transparent-only contract. The dedicated
      // admin uploader normally finishes this work before the form changes,
      // while this server-side guard covers direct API callers and legacy
      // opaque media selected into a Deal. A provider/credit failure rejects
      // only the attempted image change and returns an inline field error.
      if (
        context.uid === 'api::deal.deal' &&
        ['create', 'update', 'clone'].includes(context.action)
      ) {
        await ensureTransparentDealImageForWrite(
          strapi,
          context.params?.data,
        );
      }

      // A coupon owns exactly one of `code` / `uniqueCouponPool`. The admin
      // hides the irrelevant one, which means it is OMITTED from the payload
      // and the stored value stays attached — clear it explicitly. No-ops when
      // couponType is absent, so the cron's partial updates never detach a
      // scheduled coupon's pool.
      if (
        isCouponUid(context.uid) &&
        ['create', 'update', 'clone'].includes(context.action)
      ) {
        normaliseCouponTypeFields(context.params?.data);
        await validateCouponTypeFields(
          strapi,
          context.action,
          context.params?.data,
          context.params?.documentId,
          strictWrite,
        );
      }

      // Constraints introduced on populated fields cannot live in the Strapi
      // schema: the admin sends a full form on update and schema validation
      // cannot grandfather an unchanged legacy value. Validate only creates,
      // clones, and actual field changes after comparing with the stored row.
      if (['create', 'update', 'clone'].includes(context.action)) {
        await validateChangedFields(
          strapi,
          context.uid,
          context.action,
          context.params?.data,
          context.params?.documentId,
          strictWrite,
        );
      }

      // Homepage section images must match their Figma sizes exactly — reject
      // the save before any side effect (ISR enqueue, cache purge, override
      // fill). Already-attached files are grandfathered inside the validator.
      if (
        context.uid === 'api::homepage.homepage' &&
        ['create', 'update'].includes(context.action)
      ) {
        await validateHomepageImages(strapi, context.params?.data);
      }

      if (
        context.uid === 'api::deal-of-the-day-page.deal-of-the-day-page' &&
        ['create', 'update'].includes(context.action)
      ) {
        await validateDealOfTheDaySectionLimits(strapi, context.params?.data);
      }

      if (
        isEntityTopPickUid(context.uid) &&
        ['create', 'update'].includes(context.action)
      ) {
        await validateEntityTopPickCoupons(
          strapi,
          context.uid,
          context.params?.data,
          context.params?.documentId,
        );
      }

      // Offer badge / cashback / bank texts are word-capped so they fit the
      // fixed card slots — reject over-long values with an inline field error.
      if (
        ['api::coupon.coupon', 'api::deal.deal'].includes(context.uid) &&
        ['create', 'update', 'clone'].includes(context.action)
      ) {
        await validateOfferFieldsForWrite(
          strapi,
          context.uid,
          context.action,
          context.params?.data,
          context.params?.documentId,
          strictWrite,
        );
      }

      // Taxonomy cross-field checks (rating range, FAQ-enabled-but-empty, brand
      // required SEO) — reject with an inline field error instead of a raw 500.
      if (['create', 'update', 'clone'].includes(context.action)) {
        await validateEntityFieldsForWrite(
          strapi,
          context.uid,
          context.action,
          context.params?.data,
          context.params?.documentId,
          strictWrite,
        );
      }

      // contentStatus is DERIVED from scheduledAt/expiresAt, never editor-set.
      // Merges the payload over the stored row before deriving — deriving from
      // the payload alone would read the cron's partial {contentStatus} update
      // as "no dates" and flip every expired offer back to published, forever.
      if (
        isOfferLifecycleUid(context.uid) &&
        ['create', 'update', 'clone'].includes(context.action)
      ) {
        await validateOfferLifecycle(
          strapi,
          context.uid,
          context.action,
          context.params?.data,
          context.params?.documentId,
          strictWrite,
        );
      }

      // Blank-after-trim rejection and required-field enforcement. Only fields
      // the payload actually changes are checked, so a legacy row stays
      // saveable when an editor touches something else on the same form.
      if (['create', 'update', 'clone'].includes(context.action)) {
        await validateTextFieldsForWrite(
          strapi,
          context.uid,
          context.action,
          context.params?.data,
          context.params?.documentId,
          strictWrite,
        );
      }

      // Slug and redirect invariants below are validated with plain reads and
      // committed by an INDEPENDENT write — two concurrent saves can both pass
      // validation on the same committed snapshot and both commit: one flat
      // route claimed by two taxonomy types (the ISR server silently drops the
      // loser), case-folded duplicate redirect `from`s, or /a→/b + /b→/a
      // closing a cycle. A unique index on the NORMALIZED values cannot be
      // added over legacy duplicates (identity-validation.ts), so serialize
      // the validate+commit window with one advisory lock per invariant domain
      // instead. No-op on non-Postgres; on lock failure the save proceeds
      // unserialized (the pre-existing rare race, never an outage).
      const writeLockDomain = ['create', 'update', 'clone'].includes(context.action)
        ? isIdentityUid(context.uid)
          ? ('identity' as const)
          : context.uid === 'api::redirect.redirect'
            ? ('redirect' as const)
            : null
        : null;
      const releaseWriteLock = writeLockDomain
        ? await acquireWriteSerializationLock(strapi, writeLockDomain)
        : null;
      try {
        // Name unique per type, slug unique across all four taxonomies (the
        // public URL space is flat, so a Bank and a Store sharing a slug is a
        // real route collision), and no collision with a reserved Astro route.
        if (['create', 'update', 'clone'].includes(context.action)) {
          await validateIdentity(
            strapi,
            context.uid,
            context.action,
            context.params?.data,
            context.params?.documentId,
            strictWrite,
          );
        }

        // Redirects are evaluated by the storefront middleware on EVERY request,
        // before routing, with no code review between the editor and production.
        // A `from` shadowing a live entity or a reserved page makes that page
        // unreachable site-wide, so reject that, self-redirects, and any write
        // that closes a loop across the existing active rules.
        if (['create', 'update', 'clone'].includes(context.action)) {
          await validateRedirect(
            strapi,
            context.uid,
            context.action,
            context.params?.data,
            context.params?.documentId,
            strictWrite,
          );
        }

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

        return await runContentTransaction(
          strapi,
          () => next(),
          async (result) => {
            if (
              context.action === 'update' &&
              changesEntityOfferMembership(context.uid, context.params?.data)
            ) {
              await touchEntityPageUpdatedAt(
                strapi,
                context.uid,
                result,
                context.params?.documentId,
              );
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
                  );
            let scope =
              context.action === 'delete'
                ? preScope ?? afterScope
                : mergeScope(preScope, afterScope);

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
    // Content Manager's relation picker queries the immediate component UID,
    // not the Homepage / Deal of the Day single type. A request-scoped Query
    // Engine lifecycle filter keeps only live Coupons/Deals in those pickers
    // while leaving the normal offer collection views fully manageable.
    registerCuratedOfferRelationQueryFilter(strapi);

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
    await ensurePublicReadPermissions(strapi);
    await restrictSingleTypesToSuperAdmin(strapi);
    await ensureUploadSettings(strapi);
    await ensureComponentEntryTitles(strapi);
    await ensureComponentFieldDescriptions(strapi);
    await ensureFieldDescriptions(strapi);
    await ensureSingleTypeEntryTitles(strapi);
    await ensureOfferListStatusColumn(strapi);
    await ensureSortableListColumns(strapi);
    await ensureFullWidthEditFields(strapi);
    await ensureSectionLabels(strapi, HOMEPAGE_UID, HOMEPAGE_SECTION_LABELS);
    await ensureSectionLabels(strapi, DOTD_UID, DOTD_SECTION_LABELS);

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
