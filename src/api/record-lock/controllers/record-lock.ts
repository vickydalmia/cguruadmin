// Admin-only endpoints behind the edit-lock panel. Both routes are mounted on
// the ADMIN router by src/register/admin-routes.ts (routers loaded from
// src/api are forced to
// content-api, which an admin session cannot authenticate — same reasoning as
// the entity-deal-page settings endpoints).

const badRequest = (ctx: any, message: string) => {
  ctx.status = 400;
  ctx.body = { error: message };
};

const LEASE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LockParams = {
  model: string;
  documentId: string | undefined;
  leaseId: string;
  takeover: boolean;
};

const readParams = (ctx: any): LockParams | null => {
  const { model, documentId, leaseId, takeover } = ctx.request.body ?? {};
  if (typeof model !== 'string' || !model.startsWith('api::')) return null;
  // Unknown models must be rejected, not locked: the service resolves single
  // types by looking the model up, and a typo'd uid would otherwise acquire
  // a well-formed lock that guards nothing.
  const contentModel = strapi.getModel(model as any) as any;
  if (!contentModel) return null;
  // Single types OMIT documentId — the record-lock service is the only place
  // that knows their pseudo id. Collection types must name their entry.
  if (contentModel.kind === 'singleType') {
    if (documentId !== undefined && typeof documentId !== 'string') return null;
  } else if (typeof documentId !== 'string' || documentId.trim() === '') {
    return null;
  }
  if (typeof leaseId !== 'string' || !LEASE_ID_PATTERN.test(leaseId))
    return null;
  if (takeover !== undefined && typeof takeover !== 'boolean') return null;
  return {
    model,
    documentId: typeof documentId === 'string' ? documentId : undefined,
    leaseId,
    takeover: takeover === true,
  };
};

export default {
  /** Acquire or heartbeat-refresh the caller's lock on one entry. */
  async acquire(ctx: any) {
    const params = readParams(ctx);
    if (!params) {
      return badRequest(ctx, 'model, leaseId and (for collection types) documentId are required');
    }
    const result = await strapi
      .service('api::record-lock.record-lock')
      .acquire(params.model, params.documentId, params.leaseId, ctx.state.user, {
        takeover: params.takeover,
      });
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = result;
  },

  /** Release the caller's lock (no-op if held by someone else). */
  async release(ctx: any) {
    const params = readParams(ctx);
    if (!params) {
      return badRequest(ctx, 'model, leaseId and (for collection types) documentId are required');
    }
    const released = await strapi
      .service('api::record-lock.record-lock')
      .release(params.model, params.documentId, params.leaseId, ctx.state.user);
    ctx.set('Cache-Control', 'private, no-store');
    ctx.body = { released };
  },
};
