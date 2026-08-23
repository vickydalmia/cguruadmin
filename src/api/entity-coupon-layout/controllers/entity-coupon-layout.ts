import type { Core } from '@strapi/strapi';
import { ENTITY_COUPON_LAYOUT_ACTION } from '../services/entity-coupon-layout';
import { CouponLayoutError } from '../services/entity-coupon-layout-parse';
import { readIsrOutboxConfig } from '../../../isr-outbox/config';

function can(ability: any, action: string, subject?: string): boolean {
  try {
    return Boolean(ability?.can(action, subject));
  } catch {
    return false;
  }
}

function entityUid(kind: unknown): string | null {
  const value = String(kind ?? '').toLowerCase();
  return ['store', 'brand', 'category', 'bank'].includes(value)
    ? `api::${value}.${value}`
    : null;
}

export async function isCouponLayoutSuperAdmin(
  strapi: Core.Strapi,
  ctx: any,
): Promise<boolean> {
  // Do not rely on `userAbility.can(customAction)`: Super Admin bypasses
  // normal permission checks in Strapi, but a newly registered custom action
  // is not necessarily present in the ability generated for an existing
  // session. Resolve the persisted admin role exactly as the
  // super-admin-only policy does.
  const userId = Number(ctx.state?.user?.id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const user: any = await strapi.db.query('admin::user').findOne({
    where: { id: userId },
    populate: { roles: { select: ['code'] } },
  });
  return (
    Array.isArray(user?.roles) &&
    user.roles.some((role: any) => role?.code === 'strapi-super-admin')
  );
}

async function capabilities(
  strapi: Core.Strapi,
  ctx: any,
  kind: unknown,
  rawDocumentId: unknown,
) {
  const uid = entityUid(kind);
  const ability = ctx.state?.userAbility;
  if (await isCouponLayoutSuperAdmin(strapi, ctx)) {
    return {
      canRead: true,
      canUpdate: true,
      canManageLayout: true,
      reason: null,
    };
  }
  const feature = can(ability, ENTITY_COUPON_LAYOUT_ACTION);
  const allowedForEntity = async (action: string) => {
    if (!uid) return false;
    const manager = strapi
      .service('admin::permission')
      .createPermissionsManager({ ability, action, model: uid });
    if (!manager.isAllowed) return false;
    const permissionQuery = manager.getQuery();
    const entity = await strapi.db.query(uid as any).findOne({
      where: {
        $and: [
          { documentId: String(rawDocumentId ?? '') },
          ...(permissionQuery ? [permissionQuery] : []),
        ],
      },
      select: ['id'],
    } as any);
    return Boolean(entity);
  };
  const [read, update] = await Promise.all([
    allowedForEntity('plugin::content-manager.explorer.read'),
    allowedForEntity('plugin::content-manager.explorer.update'),
  ]);
  return {
    canRead: read,
    canUpdate: update,
    canManageLayout: feature && read && update,
    reason: !feature
      ? 'Your role does not include Manage entity coupon layout.'
      : !read || !update
        ? `Your role needs read and update access to this ${String(kind)}.`
        : null,
  };
}

function handleError(ctx: any, error: unknown) {
  if (error instanceof CouponLayoutError) {
    ctx.status = error.status;
    ctx.body = {
      error: {
        status: error.status,
        name: error.code,
        message: error.message,
        details: error.details ?? {},
      },
    };
    return;
  }
  throw error;
}

export default ({ strapi }: { strapi: Core.Strapi }) => {
  const service = () =>
    strapi.service(
      'api::entity-coupon-layout.entity-coupon-layout',
    ) as any;

  return {
    async get(ctx: any) {
      try {
        const result = await service().get(
          ctx.params?.kind,
          ctx.params?.documentId,
        );
        const caps = await capabilities(
          strapi,
          ctx,
          ctx.params?.kind,
          ctx.params?.documentId,
        );
        ctx.send({
          ...result,
          ...(!caps.canManageLayout
            ? { topPickCoupons: [], orderedCoupons: [] }
            : {}),
          capabilities: caps,
        });
      } catch (error) {
        handleError(ctx, error);
      }
    },

    async candidates(ctx: any) {
      const caps = await capabilities(
        strapi,
        ctx,
        ctx.params?.kind,
        ctx.params?.documentId,
      );
      if (!caps.canManageLayout) return ctx.forbidden(caps.reason);
      try {
        ctx.send(
          await service().candidates(
            ctx.params?.kind,
            ctx.params?.documentId,
            ctx.query ?? {},
          ),
        );
      } catch (error) {
        handleError(ctx, error);
      }
    },

    async preview(ctx: any) {
      const caps = await capabilities(
        strapi,
        ctx,
        ctx.params?.kind,
        ctx.params?.documentId,
      );
      if (!caps.canManageLayout) return ctx.forbidden(caps.reason);
      try {
        ctx.send(
          await service().preview(
            ctx.params?.kind,
            ctx.params?.documentId,
            ctx.request?.body?.data ?? ctx.request?.body,
          ),
        );
      } catch (error) {
        handleError(ctx, error);
      }
    },

    async replace(ctx: any) {
      const caps = await capabilities(
        strapi,
        ctx,
        ctx.params?.kind,
        ctx.params?.documentId,
      );
      if (!caps.canManageLayout) return ctx.forbidden(caps.reason);
      try {
        const result = await service().replace(
            ctx.params?.kind,
            ctx.params?.documentId,
            ctx.request?.body?.data ?? ctx.request?.body,
          );
        // Keep the response contract identical to GET. The admin replaces its
        // loaded layout state with this successful save response; omitting
        // capabilities made the Arrange button look unauthorized until a
        // reload fetched the layout again.
        ctx.send({ ...result, capabilities: caps });
      } catch (error) {
        handleError(ctx, error);
      }
    },

    async refresh(ctx: any) {
      // `outboxId` is a bare incrementing integer, so this endpoint is an
      // enumeration surface over the WHOLE outbox — not just this caller's
      // saves. Gated only by isAuthenticatedAdmin it let any admin of any role
      // walk 1..N and read last_error and delivery_receipt (which carries the
      // invalidated paths) for every event the system ever queued, while each
      // call fired an unthrottled authenticated request at the gateway. Same
      // capability the other handlers require.
      if (!(await isCouponLayoutSuperAdmin(strapi, ctx))) {
        const ability = ctx.state?.userAbility;
        if (!can(ability, ENTITY_COUPON_LAYOUT_ACTION)) {
          return ctx.forbidden(
            'You do not have permission to manage Coupon layout.',
          );
        }
      }

      const id = String(ctx.params?.outboxId ?? '');
      if (!/^\d+$/.test(id)) return ctx.badRequest('Invalid outbox id');
      const row = await strapi.db.connection('isr_outbox')
        .where({ id })
        .select([
          'id',
          'status',
          'attempt_count',
          'last_error',
          'accepted_at',
          'delivery_receipt',
          'delivered_at',
        ])
        .first();
      if (!row) return ctx.notFound('Refresh event not found');
      // A malformed column must not 500 out of a handler that otherwise
      // degrades gracefully (see the deliberate catch around the gateway
      // probe below).
      let receipt: any = null;
      try {
        receipt =
          typeof row.delivery_receipt === 'string'
            ? JSON.parse(row.delivery_receipt)
            : row.delivery_receipt;
      } catch {
        receipt = null;
      }
      let state =
        row.status === 'delivered'
          ? 'accepted'
          : row.status === 'processing'
            ? 'retrying'
            : row.status === 'pending' && Number(row.attempt_count) > 0
              ? 'retrying'
              : row.status === 'pending'
                ? 'queued'
                : 'failed';
      let render: unknown = null;
      if (state === 'accepted' && Array.isArray(receipt?.paths)) {
        try {
          const config = readIsrOutboxConfig();
          const params = new URLSearchParams();
          for (const path of receipt.paths) {
            params.append('path', String(path.path));
            params.append('version', String(path.version));
          }
          const response = await fetch(
            `${config.gatewayUrl}/internal/isr/render-status?${params}`,
            {
              headers: {
                authorization: `Bearer ${config.adminSecret}`,
                accept: 'application/json',
              },
              signal: AbortSignal.timeout(config.requestTimeoutMs),
            },
          );
          if (response.ok) {
            render = await response.json();
            if ((render as any)?.state === 'rendered') state = 'rendered';
            if ((render as any)?.state === 'failed') state = 'failed';
          }
        } catch {
          // Accepted remains useful progress even if status probing is down.
        }
      }
      // Only what the panel renders. `last_error` and the delivery receipt are
      // internal delivery detail — the receipt in particular lists invalidated
      // paths — and the panel shows neither.
      ctx.send({
        outboxId: id,
        state,
        attemptCount: Number(row.attempt_count),
        acceptedAt: row.accepted_at ?? null,
        deliveredAt: row.delivered_at ?? null,
      });
    },
  };
};
