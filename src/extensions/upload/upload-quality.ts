import { AsyncLocalStorage } from 'node:async_hooks';
import { errors } from '@strapi/utils';

type UploadQuality = 'default' | 'high';
const qualityContext = new AsyncLocalStorage<UploadQuality>();

export function currentUploadQuality(): UploadQuality | undefined {
  return qualityContext.getStore();
}

/** Keep concurrent upload choices isolated and leave Strapi permissions intact. */
export function applyUploadQualityControllers(plugin: any): void {
  const controller = plugin.controllers?.['admin-upload'];
  if (!controller) return;
  for (const action of ['uploadFiles', 'replaceFile']) {
    const original = controller[action];
    if (!original) continue;
    controller[action] = function (ctx: any) {
      const quality = ctx.request?.body?.imageQuality;
      if (quality !== undefined && quality !== 'default' && quality !== 'high') {
        throw new errors.ValidationError('Choose Default or High image quality.');
      }
      return qualityContext.run(quality, () => original.call(this, ctx));
    };
  }
}
