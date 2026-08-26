// Offer ISR ROUTE INVENTORY: the batched slug walk behind the gateway's
// prerender route list. One of the modules split out of the coupon
// controller (see ../controllers/custom.ts).
import type { Core } from '@strapi/strapi';
import { visibilityFilters } from './offer-projections';

// Route inventory is an internal deployment feed, not a public listing page.
// Production has 10k+ Coupon/Deal documents, so the former 100-row batch size
// required 100+ sequential Document Service queries and regularly exceeded the
// frontend's request timeout. A larger bounded batch keeps memory predictable
// while reducing inventory assembly to roughly a dozen queries.
const ISR_ROUTE_BATCH_SIZE = 1_000;

export async function listIsrOfferRoutes(
  strapi: Core.Strapi,
  uid: 'api::coupon.coupon' | 'api::deal.deal',
  kind: 'coupon' | 'deal',
): Promise<Array<{ path: string; updatedAt?: string }>> {
  const routes: Array<{ path: string; updatedAt?: string }> = [];
  let start = 0;

  while (true) {
    const items: any[] = await strapi.documents(uid).findMany({
      status: 'published',
      filters: visibilityFilters(),
      fields: ['updatedAt'] as any,
      sort: [{ id: 'asc' }] as any,
      start,
      limit: ISR_ROUTE_BATCH_SIZE,
    } as any);
    for (const item of items) {
      const id = Number(item?.id);
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      routes.push({
        path: `/${kind}/${id}/`,
        ...(typeof item.updatedAt === 'string'
          ? { updatedAt: item.updatedAt }
          : {}),
      });
    }
    if (items.length < ISR_ROUTE_BATCH_SIZE) break;
    start += items.length;
  }

  return routes;
}
