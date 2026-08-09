import type { Core } from '@strapi/strapi';

import { ENTITY_COUPON_LAYOUT_ACTION } from '../api/entity-coupon-layout/services/entity-coupon-layout';

export async function seedEntityCouponLayoutEditorPermission(
  strapi: Core.Strapi,
): Promise<void> {
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
}
