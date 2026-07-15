import type { Core } from '@strapi/strapi';
import { isDirectoryKind } from '../services/directory';

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async find(ctx: any) {
    const kind = ctx.params?.kind;
    if (!isDirectoryKind(kind)) {
      return ctx.badRequest('Directory kind must be store, brand, category, or bank');
    }

    const service = strapi.service('api::directory.directory') as any;
    return ctx.send(await service.getDirectory(kind));
  },
});
