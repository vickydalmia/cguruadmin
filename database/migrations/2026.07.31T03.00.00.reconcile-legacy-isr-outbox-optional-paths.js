"use strict";

const TABLE = "isr_outbox";
const ENTITY_UIDS = [
  "api::store.store",
  "api::brand.brand",
  "api::category.category",
  "api::bank.bank",
];
const ENTITY_TARGETED_REASONS = new Set(
  ENTITY_UIDS.flatMap((uid) => [
    `${uid} update`,
    `${uid} publish`,
    `${uid} unpublish`,
    `${uid} discardDraft`,
  ]),
);
const OFFER_DELETE_REASONS = new Set([
  "api::coupon.coupon delete",
  "api::deal.deal delete",
]);
const SINGLE_SKIPPED_PATH = /^gateway skipped 1 path\(s\): (\/[^\s,]+)$/;
const OFFER_DETAIL_PATH = /^\/(?:coupon|deal)\/[1-9]\d*\/$/;

function parsePayload(value) {
  try {
    const payload = typeof value === "string" ? JSON.parse(value) : value;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : null;
  } catch {
    return null;
  }
}

/**
 * Older durable commands treated conditional entity Deal pages as required,
 * and offer-deletion commands could predate the gateway's durable removal log.
 * The gateway correctly refreshed the route inventory, accepted every live
 * path, then returned the absent path as skipped. That left an otherwise-
 * complete durable event retrying forever.
 *
 * Repair only the two shapes whose absence is expected and only when the
 * gateway's skipped path is present in the original bounded path list. Unknown
 * routes remain visible failures instead of being silently acknowledged.
 */
function reconcileLegacyPayload(row) {
  const skippedPath = String(row.last_error ?? "").match(
    SINGLE_SKIPPED_PATH,
  )?.[1];
  if (!skippedPath) return null;

  const expectedAbsentPath =
    ((ENTITY_TARGETED_REASONS.has(String(row.reason))
      || String(row.reason).startsWith("api::deal.deal "))
      && skippedPath.endsWith("-deals/"))
    || (OFFER_DELETE_REASONS.has(String(row.reason))
      && OFFER_DETAIL_PATH.test(skippedPath));
  if (!expectedAbsentPath) return null;

  const payload = parsePayload(row.payload);
  if (!payload || !Array.isArray(payload.paths)) return null;
  if (!payload.paths.includes(skippedPath)) return null;
  if (
    payload.optionalPaths !== undefined
    && !Array.isArray(payload.optionalPaths)
  ) {
    return null;
  }

  const optionalPaths = [...new Set(payload.optionalPaths ?? [])];
  if (optionalPaths.includes(skippedPath)) return null;
  optionalPaths.push(skippedPath);
  return { ...payload, optionalPaths };
}

module.exports = {
  async up(knex) {
    if (!(await knex.schema.hasTable(TABLE))) return;

    const rows = await knex(TABLE)
      .select("id", "payload", "reason", "last_error")
      .whereIn("status", ["pending", "processing"])
      .whereNotNull("last_error")
      .where("last_error", "like", "gateway skipped 1 path(s): /%");

    for (const row of rows) {
      const payload = reconcileLegacyPayload(row);
      if (!payload) continue;

      // Do not change status, leases, attempts, or scheduling. A dispatcher in
      // an older sibling container may currently own a processing row during a
      // rolling deployment. Updating only the durable payload lets that attempt
      // finish normally; its next retry reads the repaired command.
      await knex(TABLE)
        .where({ id: row.id })
        .whereIn("status", ["pending", "processing"])
        .update({ payload: JSON.stringify(payload) });
    }
  },
  reconcileLegacyPayload,
};
