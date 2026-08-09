import type { Core } from '@strapi/strapi';

import {
  HOMEPAGE_IMAGE_RULES,
  imageRuleDescription,
} from '../../constants/homepage-images';

// The seeds below are NOT the full table: content-type-field-hints.ts merges
// its validator-mirror hints INTO this object at module-evaluation time.
// Import COMPONENT_FIELD_DESCRIPTIONS via src/index.ts or alongside
// content-type-field-hints (as bootstrap does) — importing this module alone
// yields the unmerged seeds.
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
export async function ensureComponentFieldDescriptions(strapi: Core.Strapi): Promise<void> {
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
