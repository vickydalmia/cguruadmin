import type { Core } from '@strapi/strapi';
import { DOTD_SECTION_LABELS, DOTD_UID } from './constants/deal-of-the-day-sections';
import { HOMEPAGE_IMAGE_RULES, imageRuleDescription } from './constants/homepage-images';
import {
  HOMEPAGE_SECTION_LABELS,
  HOMEPAGE_UID,
  type SectionLabel,
} from './constants/homepage-sections';
import { purgeResponseCaches } from './middlewares/cache';
import { destroyRebuildQueue, enqueue, type ScopeRequest } from './static-deployment/queue';
import { computeScope, preDeleteScope } from './static-deployment/scopes';
import { validateEntityFields } from './utils/entity-field-validation';
import {
  isEntityTopPickUid,
  validateEntityTopPickCoupons,
} from './utils/entity-top-pick-validation';
import { validateDealOfTheDaySectionLimits } from './utils/deal-of-the-day-validation';
import { validateHomepageImages } from './utils/homepage-image-validation';
import { validateOfferFields } from './utils/offer-field-validation';
import { sanitizeRichtextData } from './utils/sanitize-richtext';

const HIDE_FROM_EDIT: Record<string, string[]> = {
  'api::deal.deal': ['stores', 'brands', 'categories', 'banks'],
  'api::coupon.coupon': ['stores', 'brands', 'categories', 'banks'],
  'api::store.store': ['topPickCoupons'],
  'api::brand.brand': ['topPickCoupons'],
  'api::bank.bank': ['topPickCoupons'],
  'api::category.category': ['topPickCoupons'],
};

async function hideRelationsFromContentManager(strapi: Core.Strapi): Promise<void> {
  const service: any = strapi.plugin('content-manager').service('content-types');
  if (!service) return;

  for (const [uid, fieldsToHide] of Object.entries(HIDE_FROM_EDIT)) {
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
      const nextList = prevList.filter((name: string) => !hidden.has(name));

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
      strapi.log.info(`[content-manager] hid relations from ${uid} layout`);
    } catch (err: any) {
      strapi.log.warn(
        `[content-manager] failed to rewrite layout for ${uid}: ${err?.message ?? err}`
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
  ...['homepage', 'global', 'menu', 'footer'].map(
    (name) => `api::${name}.${name}.find`
  ),
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

// Field help text under each size-enforced homepage media field, derived from
// HOMEPAGE_IMAGE_RULES so the enforced size and the admin instruction can
// never drift apart. Same DB config store + config-as-code approach as the
// entry titles above.
const COMPONENT_FIELD_DESCRIPTIONS: Record<string, Record<string, string>> = {};
for (const rule of HOMEPAGE_IMAGE_RULES) {
  (COMPONENT_FIELD_DESCRIPTIONS[rule.componentUid] ??= {})[rule.field] =
    imageRuleDescription(rule);
}
COMPONENT_FIELD_DESCRIPTIONS['homepage.slider-slide'].mobileImage +=
  ' Optional — when empty, the desktop image is cropped on mobile.';

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

// Single types' edit-view headers show their mainField — pin it to the
// `title` attribute ("Homepage"/"Menu"/"Footer") instead of wp_<hash> ids.
const SINGLE_TYPE_ENTRY_TITLES = [
  'api::homepage.homepage',
  'api::deal-of-the-day-page.deal-of-the-day-page',
  'api::menu.menu',
  'api::footer.footer',
  'api::global.global',
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

export default {
  register({ strapi }: { strapi: Core.Strapi }) {
    // NOTE: no custom /_health route — Strapi core already serves /_health
    // (all methods, 204, no auth) and registers it BEFORE this lifecycle,
    // so a route here would be dead code. The docker healthcheck and
    // deploy.sh curl both hit the built-in.

    strapi.documents.use(async (context: any, next: any) => {
      // Richtext fields hold HTML rendered raw on the public site — enforce
      // the migration-era allowlist on every write, whatever the editor.
      if (['create', 'update', 'clone'].includes(context.action)) {
        sanitizeRichtextData(context.uid, context.params?.data);
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
        ['create', 'update'].includes(context.action)
      ) {
        validateOfferFields(context.params?.data);
      }

      // Taxonomy cross-field checks (rating range, FAQ-enabled-but-empty, brand
      // required SEO) — reject with an inline field error instead of a raw 500.
      if (['create', 'update'].includes(context.action)) {
        validateEntityFields(context.uid, context.action, context.params?.data);
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

      const result = await next();

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
          strapi.log.warn(`[homepage] override auto-fill failed: ${err?.message ?? err}`);
        }
      }

      // Rebuild scope — never fails the save (deployment-runbook.md §3).
      try {
        const documentId =
          (result as any)?.documentId ?? context.params?.documentId;
        let scope =
          context.action === 'delete' && preScope
            ? preScope
            : await computeScope(strapi, context.uid, context.action, documentId);

        // Union before+after relation pages for offer updates (a store
        // removed from a coupon must rebuild too).
        if (scope && preScope && context.action !== 'delete') {
          scope = {
            full: Boolean(scope.full || preScope.full),
            homepage: Boolean(scope.homepage || preScope.homepage),
            slugs: [...new Set([...(scope.slugs ?? []), ...(preScope.slugs ?? [])])],
          };
        }

        if (scope) {
          // Cached /homepage-full & /site-chrome responses predate this edit;
          // purge so revalidate renders never bake stale data into Redis.
          purgeResponseCaches();
          enqueue(strapi, scope, `${context.uid} ${context.action}`);
        }
      } catch (err: any) {
        strapi.log.warn(`[rebuild] scope computation failed: ${err?.message ?? err}`);
      }

      return result;
    });
  },

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await hideRelationsFromContentManager(strapi);
    await ensurePublicReadPermissions(strapi);
    await restrictSingleTypesToSuperAdmin(strapi);
    await ensureUploadSettings(strapi);
    await ensureComponentEntryTitles(strapi);
    await ensureComponentFieldDescriptions(strapi);
    await ensureSingleTypeEntryTitles(strapi);
    await ensureOfferListStatusColumn(strapi);
    await ensureSectionLabels(strapi, HOMEPAGE_UID, HOMEPAGE_SECTION_LABELS);
    await ensureSectionLabels(strapi, DOTD_UID, DOTD_SECTION_LABELS);

    strapi.log.info(
      `[rebuild] ${process.env.REBUILD_ENABLED === 'true' ? 'ENABLED' : 'disabled (log-only)'} — scopes computed on every content change`
    );
  },

  destroy() {
    destroyRebuildQueue();
  },
};
