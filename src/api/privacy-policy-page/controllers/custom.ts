import type { Core } from '@strapi/strapi';
import { sendLegalPage } from '../../../utils/legal-page-controller';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async privacyPolicyPageFull(ctx: any) {
    return sendLegalPage(
      strapi,
      ctx,
      'api::privacy-policy-page.privacy-policy-page',
    );
  },
});
