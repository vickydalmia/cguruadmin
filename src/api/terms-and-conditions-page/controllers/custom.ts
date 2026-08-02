import type { Core } from '@strapi/strapi';
import { sendLegalPage } from '../../../utils/legal-page-controller';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async termsAndConditionsPageFull(ctx: any) {
    return sendLegalPage(
      strapi,
      ctx,
      'api::terms-and-conditions-page.terms-and-conditions-page',
    );
  },
});
