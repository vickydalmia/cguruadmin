import type { Core } from '@strapi/strapi';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async publicFind(ctx: any) {
    const service = strapi.service(
      'api::site-configuration.site-configuration',
    ) as any;
    return ctx.send({ data: await service.publicSettings() });
  },

  async adminFind(ctx: any) {
    const service = strapi.service(
      'api::site-configuration.site-configuration',
    ) as any;
    return ctx.send({ data: await service.adminSettings() });
  },

  async adminLanguages(ctx: any) {
    const service = strapi.service(
      'api::site-configuration.site-configuration',
    ) as any;
    return ctx.send({ data: await service.selectableLanguages() });
  },

  async adminOfferCountries(ctx: any) {
    const service = strapi.service(
      'api::site-configuration.site-configuration',
    ) as any;
    return ctx.send({ data: await service.selectableOfferCountries() });
  },

  async adminEnabledOfferCountries(ctx: any) {
    const service = strapi.service(
      'api::site-configuration.site-configuration',
    ) as any;
    return ctx.send({ data: await service.enabledOfferCountries() });
  },

  async adminUpdate(ctx: any) {
    const service = strapi.service(
      'api::site-configuration.site-configuration',
    ) as any;
    return ctx.send({
      data: await service.update(ctx.request?.body?.data ?? ctx.request?.body),
    });
  },
});
