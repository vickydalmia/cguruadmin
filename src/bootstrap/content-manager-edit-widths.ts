// Content-manager EDIT-FORM ARRANGEMENT, pinned on every boot
// (config-as-code): full-row field widths and field placement moves. One of
// the five content-manager view-config modules split out of the old
// bootstrap/content-manager-layouts.ts.
import type { Core } from '@strapi/strapi';
import {
  moveEditLayoutFieldAfter,
  pinFieldToFullRow,
  type EditLayout,
} from '../utils/content-manager-layout';

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
