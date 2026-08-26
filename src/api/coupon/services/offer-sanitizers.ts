// Offer SANITIZERS: the content-API query/output sanitization boundary,
// including unique-code redaction. One of the modules split out of the
// coupon controller (see ../controllers/custom.ts).
import type { Core } from '@strapi/strapi';

export function contentType(strapi: Core.Strapi, uid: string) {
  return strapi.contentType(uid as any) as any;
}

export async function sanitizeDocumentQuery(
  strapi: Core.Strapi,
  ctx: any,
  uid: string,
  query: Record<string, any>,
) {
  const schema = contentType(strapi, uid);
  await strapi.contentAPI.validate.query(query, schema, { auth: ctx.state.auth });
  return await strapi.contentAPI.sanitize.query(query, schema, { auth: ctx.state.auth });
}

/**
 * A unique offer's `code` column is never the code a visitor gets — those are
 * drawn one at a time from the pool through the redeem flow. New writes already
 * clear it (normaliseCouponTypeFields), but rows that predate that normaliser
 * still carry a stale shared code, and `code` is on the public field list. The
 * UI gates on `couponType` and would not render it; this makes sure it never
 * reaches the wire in the first place.
 *
 * Applied at the two sanitizers every offer response passes through, rather
 * than at each of the ~8 call sites, so a new endpoint cannot forget it.
 */
export function redactUniqueOfferCode(data: any): any {
  if (Array.isArray(data)) return data.map(redactUniqueOfferCode);
  if (!data || typeof data !== 'object') return data;
  if (data.couponType !== 'unique' || data.code == null) return data;
  return { ...data, code: null };
}

export async function sanitizeDocumentOutput(
  strapi: Core.Strapi,
  ctx: any,
  uid: string,
  data: any,
) {
  const schema = contentType(strapi, uid);
  return redactUniqueOfferCode(
    (await strapi.contentAPI.sanitize.output(data, schema, {
      auth: ctx.state.auth,
    })) as any,
  );
}

export async function sanitizePublicDocumentQuery(
  strapi: Core.Strapi,
  uid: string,
  query: Record<string, any>,
) {
  const schema = contentType(strapi, uid);
  await strapi.contentAPI.validate.query(query, schema, { auth: undefined });
  return await strapi.contentAPI.sanitize.query(query, schema, {
    auth: undefined,
  });
}

export async function sanitizePublicDocumentOutput(
  strapi: Core.Strapi,
  uid: string,
  data: any,
) {
  const schema = contentType(strapi, uid);
  return redactUniqueOfferCode(
    (await strapi.contentAPI.sanitize.output(data, schema, {
      auth: undefined,
    })) as any,
  );
}
