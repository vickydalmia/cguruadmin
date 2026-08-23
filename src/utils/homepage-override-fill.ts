import type { Core } from '@strapi/strapi';

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

export async function fillHomepageOverrides(strapi: Core.Strapi): Promise<void> {
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
