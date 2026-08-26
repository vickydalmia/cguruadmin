// Content-manager LIST COLUMNS, pinned on every boot (config-as-code): the
// offer contentStatus column and the sortable columns per list view. One of
// the five content-manager view-config modules split out of the old
// bootstrap/content-manager-layouts.ts.
import type { Core } from '@strapi/strapi';
import {
  appendListColumns,
  isSortableListColumn,
} from '../utils/content-manager-layout';

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
