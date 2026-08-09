import type { Core } from '@strapi/strapi';

import { CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME } from '../constants/checkout-merchant';
import { registerDocumentMiddlewares } from '../document-middlewares/register-document-middlewares';
import { registerAdminRoutes } from './admin-routes';

export async function registerApplication(strapi: Core.Strapi): Promise<void> {
  // The Checkout Merchant custom field, which is what lets ONE dropdown
  // offer Stores and Brands together in the main edit form (a relation can
  // only target one content type — src/constants/checkout-merchant.ts has
  // the full reasoning).
  //
  // Registering HERE is mandatory, not stylistic: Strapi.register() runs the
  // user register lifecycle and only THEN calls convertCustomFieldType(),
  // which swaps `"type": "customField"` in the offer schemas for this
  // field's underlying `string`. Register any later and both schemas fail to
  // load with "Could not find Custom Field: global::checkout-merchant".
  //
  // No `plugin` key, so the registry derives the `global::` uid the two
  // schema.json files name. The admin half registers the matching Input in
  // src/admin/app.tsx.
  strapi.customFields.register({
    name: CHECKOUT_MERCHANT_CUSTOM_FIELD_NAME,
    type: 'string',
    inputSize: { default: 6, isResizable: true },
  });

  await registerAdminRoutes(strapi);
  registerDocumentMiddlewares(strapi);
}
