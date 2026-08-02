// Admin-only endpoints behind the edit-lock panel. Both routes are mounted on
// the ADMIN router in src/index.ts (routers loaded from src/api are forced to
// content-api, which an admin session cannot authenticate — same reasoning as
// the entity-deal-page settings endpoints).

const badRequest = (ctx: any, message: string) => {
  ctx.status = 400;
  ctx.body = { error: message };
};

const readParams = (ctx: any): { model: string; documentId: string } | null => {
  const { model, documentId } = ctx.request.body ?? {};
  if (typeof model !== 'string' || !model.startsWith('api::')) return null;
  if (typeof documentId !== 'string' || documentId.trim() === '') return null;
  return { model, documentId };
};

export default {
  /** Acquire or heartbeat-refresh the caller's lock on one entry. */
  async acquire(ctx: any) {
    const params = readParams(ctx);
    if (!params) return badRequest(ctx, 'model and documentId are required');
    const result = await strapi
      .service('api::record-lock.record-lock')
      .acquire(params.model, params.documentId, ctx.state.user);
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = result;
  },

  /** Release the caller's lock (no-op if held by someone else). */
  async release(ctx: any) {
    const params = readParams(ctx);
    if (!params) return badRequest(ctx, 'model and documentId are required');
    await strapi
      .service('api::record-lock.record-lock')
      .release(params.model, params.documentId, ctx.state.user);
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = { released: true };
  },
};
