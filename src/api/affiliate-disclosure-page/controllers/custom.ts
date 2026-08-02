import type { Core } from '@strapi/strapi';
import { sendLegalPage } from '../../../utils/legal-page-controller';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async affiliateDisclosurePageFull(ctx: any) {
    return sendLegalPage(
      strapi,
      ctx,
      'api::affiliate-disclosure-page.affiliate-disclosure-page',
    );
  },
});
