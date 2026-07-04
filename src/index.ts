import type { Core } from '@strapi/strapi';
import { purgeResponseCaches } from './middlewares/cache';
import { destroyRebuildQueue, enqueue, type ScopeRequest } from './static-deployment/queue';
import { computeScope, preDeleteScope } from './static-deployment/scopes';

const HIDE_FROM_EDIT: Record<string, string[]> = {
  'api::deal.deal': ['stores', 'brands', 'categories', 'banks', 'tags'],
  'api::coupon.coupon': ['stores', 'brands', 'categories', 'banks', 'tags'],
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
  ...['store', 'brand', 'category', 'bank', 'tag'].flatMap(
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
  'home.step': 'title',
  'home.why-feature': 'label',
  'home.top-offers': 'heading',
  'home.popular-stores': 'heading',
  'home.deal-list': 'heading',
  'home.cg-exclusive': 'heading',
  'home.explore-deals': 'heading',
  'home.newly-added': 'heading',
  'home.bank-offers': 'heading',
  'home.how-it-works': 'heading',
  'home.faq-block': 'heading',
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

// Single types' edit-view headers show their mainField — pin it to the
// `title` attribute ("Homepage"/"Menu"/"Footer") instead of wp_<hash> ids.
const SINGLE_TYPE_ENTRY_TITLES = [
  'api::homepage.homepage',
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
  { componentUid: 'home.bank-offer-item', overrideField: 'subtitle', relationField: 'bank', relationLabel: 'shortDescription' },
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

export default {
  register({ strapi }: { strapi: Core.Strapi }) {
    strapi.server.routes([
      {
        method: 'GET',
        path: '/_health',
        handler(ctx) {
          ctx.status = 204;
        },
      },
    ]);

    strapi.documents.use(async (context: any, next: any) => {
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
            context.params?.documentId
          );
        } catch {
          preScope = null;
        }
      }

      const result = await next();

      if (
        context.uid === 'api::homepage.homepage' &&
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
    await ensureUploadSettings(strapi);
    await ensureComponentEntryTitles(strapi);
    await ensureSingleTypeEntryTitles(strapi);

    strapi.log.info(
      `[rebuild] ${process.env.REBUILD_ENABLED === 'true' ? 'ENABLED' : 'disabled (log-only)'} — scopes computed on every content change`
    );
  },

  destroy() {
    destroyRebuildQueue();
  },
};
