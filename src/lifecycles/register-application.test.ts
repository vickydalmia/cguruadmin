import { describe, expect, it, vi } from 'vitest';

import { ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES } from '../api/entity-coupon-layout/services/entity-coupon-layout';
import { DOCUMENT_MIDDLEWARE_ORDER } from '../document-middlewares/register-document-middlewares';
import { ADMIN_ROUTE_PREFIXES } from './admin-routes';
import { registerApplication } from './register-application';

describe('registerApplication', () => {
  it('preserves route, action, and middleware registration order', async () => {
    const events: string[] = [];
    const documents: any = Object.assign(vi.fn(), {
      use: vi.fn((middleware: Function) => {
        events.push(`middleware:${middleware.name}`);
      }),
    });
    const registerMany = vi.fn(async () => {
      events.push('action:entity-coupon-layout');
    });
    const routes = vi.fn((group: { prefix: string }) => {
      events.push(`routes:${group.prefix}`);
    });
    const registerCustomField = vi.fn(() => {
      events.push('custom-field:checkout-merchant');
    });
    // Real-shaped relation attributes: registration runs the clone-override
    // coverage assertion against these, so the fixture mirrors the schemas
    // (including the deliberately-excluded coupon-layout relations).
    const manyToMany = (target: string) => ({
      type: 'relation',
      relation: 'manyToMany',
      target,
    });
    const offerRelations = {
      stores: manyToMany('api::store.store'),
      brands: manyToMany('api::brand.brand'),
      categories: manyToMany('api::category.category'),
      banks: manyToMany('api::bank.bank'),
    };
    const entityRelations = {
      coupons: manyToMany('api::coupon.coupon'),
      deals: manyToMany('api::deal.deal'),
      topPickCoupons: manyToMany('api::coupon.coupon'),
      orderedCoupons: manyToMany('api::coupon.coupon'),
    };
    const strapi = {
      customFields: { register: registerCustomField },
      server: { routes },
      service: vi.fn(() => ({
        actionProvider: { registerMany },
      })),
      documents,
      contentTypes: {
        'api::coupon.coupon': { attributes: offerRelations },
        'api::deal.deal': { attributes: offerRelations },
        'api::store.store': { attributes: entityRelations },
        'api::brand.brand': { attributes: entityRelations },
      },
    } as any;

    await registerApplication(strapi);

    // The middleware segment is asserted THROUGH the exported order constant,
    // so the constant is pinned to what registration actually does and can
    // no longer drift into decorative documentation.
    expect(events).toEqual([
      'custom-field:checkout-merchant',
      'routes:/entity-deal-page',
      'action:entity-coupon-layout',
      'routes:/entity-coupon-layout',
      'routes:/record-lock',
      ...DOCUMENT_MIDDLEWARE_ORDER.map((name) => `middleware:${name}`),
    ]);
    expect(DOCUMENT_MIDDLEWARE_ORDER).toEqual([
      'recordLockDocumentMiddleware',
      'contentWriteDocumentMiddleware',
    ]);
    expect(registerMany).toHaveBeenCalledWith([
      ENTITY_COUPON_LAYOUT_ACTION_ATTRIBUTES,
    ]);
    // Same for the route prefixes: observed registration order must equal
    // the exported constant.
    expect(routes.mock.calls.map(([group]) => group.prefix)).toEqual([
      ...ADMIN_ROUTE_PREFIXES,
    ]);
  });
});
