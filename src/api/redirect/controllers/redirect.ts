import { factories } from '@strapi/strapi';

// The core `find` action is granted to the public role
// (src/bootstrap/permissions.ts, run from bootstrap)
// so the ISR frontend can page in the active redirect table. That grant makes
// every query parameter on this route attacker-controlled: a stock core
// controller would honour `?filters[active][$eq]=false` (enumerating planned /
// disabled redirects before they go live) and `?fields=note` (reading the
// editors' internal notes — now also `private` in the schema as a second
// layer). The only production consumer (cguru-ui get-redirects.ts) always asks
// for active rows projected to from/to/statusCode, so the query shape is
// FORCED here instead of trusted: caller-supplied filters, fields, sort and
// populate are discarded; only pagination survives, clamped to the consumer's
// 100-per-page window. Delegating to `super.find` keeps the standard core
// `{ data, meta: { pagination } }` envelope the frontend parses.

// What an anonymous caller can read about a redirect rule, and nothing else.
// `active` is included (it is always `true` here) so the resolver's
// `item.active === false` guard keeps seeing a value.
const PUBLIC_REDIRECT_FIELDS = ['from', 'to', 'statusCode', 'active'];

// Matches REDIRECT_PAGE_SIZE in cguru-ui get-redirects.ts (and Strapi's own
// REST default ceiling).
const MAX_PAGE_SIZE = 100;

const toPositiveInt = (raw: unknown, fallback: number): number => {
  const parsed = Math.trunc(Number(raw));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
};

export default factories.createCoreController('api::redirect.redirect', () => ({
  async find(ctx: any) {
    const pagination =
      ctx.query && typeof ctx.query.pagination === 'object' && ctx.query.pagination !== null
        ? (ctx.query.pagination as Record<string, unknown>)
        : {};

    ctx.query = {
      fields: PUBLIC_REDIRECT_FIELDS,
      filters: { active: { $eq: true } },
      // The consumer sends no sort, and Postgres without one may repeat or drop
      // rows across its page walk. `from` is unique, so this is a total order.
      sort: { from: 'asc' },
      pagination: {
        page: toPositiveInt(pagination.page, 1),
        pageSize: Math.min(toPositiveInt(pagination.pageSize, MAX_PAGE_SIZE), MAX_PAGE_SIZE),
      },
    };

    return super.find(ctx);
  },
}));
