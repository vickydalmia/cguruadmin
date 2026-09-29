import { factories } from '@strapi/strapi';
import { listTelegramProcessing, listStoredTelegramPosts, retryTelegramProcessing, requestTelegramPhotoCheck } from '../../../telegram/admin-processing';

export default factories.createCoreController('api::telegram.telegram', ({ strapi }) => ({
  async checkProcessing(ctx: any) {
    const { revision } = ctx.request.body ?? {};
    if (!/^[a-f0-9]{64}$/.test(ctx.params.id ?? '') || !Number.isSafeInteger(revision)) return ctx.badRequest('Invalid check request');
    if (!(await requestTelegramPhotoCheck(strapi, ctx.params.id, revision))) {
      ctx.status = 409; ctx.body = { error: 'The worker is busy or the message changed. Refresh and try again.' }; return;
    }
    ctx.body = { queued: true };
  },
  async storedPosts(ctx: any) {
    const page = Number(ctx.query.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 1000) return ctx.badRequest('Invalid page');
    ctx.body = await listStoredTelegramPosts(strapi, page);
  },
  async processing(ctx: any) {
    const page = Number(ctx.query.page ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 10) return ctx.badRequest('Invalid page');
    ctx.body = await listTelegramProcessing(strapi, page);
  },
  async retryProcessing(ctx: any) {
    const { revision, newProcessing = false } = ctx.request.body ?? {};
    if (!/^[a-f0-9]{64}$/.test(ctx.params.id ?? '') || !Number.isSafeInteger(revision) || typeof newProcessing !== 'boolean') return ctx.badRequest('Invalid retry request');
    const queued = await retryTelegramProcessing(strapi, ctx.params.id, revision, newProcessing);
    if (!queued) { ctx.status = 409; ctx.body = { error: 'The worker is busy or the message changed. Refresh and try again.' }; return; }
    ctx.body = { queued: true };
  },
}));
