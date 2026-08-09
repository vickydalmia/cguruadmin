import type { Core } from '@strapi/strapi';

import {
  appendListColumns,
  isSortableListColumn,
  pinFieldToFullRow,
  type EditLayout,
} from '../../utils/content-manager-layout';

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
