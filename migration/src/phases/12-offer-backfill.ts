import { unserialize } from "php-serialize";
import pLimit from "p-limit";
import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { getPostMapping, ensureTermMapping } from "../utils/id-maps.js";
import { insertLink } from "../utils/strapi-insert.js";
import { logger } from "../utils/logger.js";

/** Valid values for the Strapi `offerType` enum (stored as text in `offer_type`). */
const OFFER_TYPES = new Set([
  "exclusive",
  "newly_added",
  "electronics",
  "fashion",
  "travel",
  "food",
]);

interface PrimaryStoreLinkTable {
  table: string;
  dealCol: string;
  storeCol: string;
}

/**
 * Phase 12 — Backfill two newly-added Strapi fields from WordPress data:
 *
 * 1. `offer_type` on coupons and deals, from the `offer_type` postmeta key
 *    (unknown/missing values are left null).
 * 2. The deal.primaryStore manyToOne relation, from the ACF `deal_store`
 *    postmeta key (a store term ID, possibly PHP-serialized).
 *
 * Safe to re-run: offer_type uses plain UPDATEs, primaryStore links use
 * delete-then-insert per deal.
 */
export async function runOfferBackfill(): Promise<void> {
  logger.info("=== Phase 12: Offer Backfill (offerType + primaryStore) ===");

  // Guard against stale ID maps: if the Strapi tables are empty, the persisted
  // maps belong to a different database (e.g. after switching
  // PG_CONNECTION_STRING) and every row-id lookup would fail with FK errors.
  const [{ count: dealCount }] = await pgQuery<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM deals"
  );
  if (Number(dealCount) === 0) {
    throw new Error(
      "Strapi `deals` table is empty but checkpoints/ID maps exist from a previous run " +
        "against a different database. Run a full clean migration instead: npm run migrate -- --clean"
    );
  }

  // Fetch the relevant meta for all migrated post types (same post scope as
  // Phases 07/08: published/scheduled regular posts).
  const rows = await wpQuery<{
    post_id: number;
    meta_key: string;
    meta_value: string;
  }>(`
    SELECT pm.post_id, pm.meta_key, pm.meta_value
    FROM wp_postmeta pm
    JOIN wp_posts p ON p.ID = pm.post_id
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
      AND pm.meta_key IN ('offer_type', 'deal_store')
    ORDER BY pm.post_id
  `);

  const metaByPost = new Map<number, Record<string, string>>();
  for (const row of rows) {
    if (!metaByPost.has(row.post_id)) metaByPost.set(row.post_id, {});
    metaByPost.get(row.post_id)![row.meta_key] = row.meta_value;
  }

  logger.info(`Found ${metaByPost.size} posts with offer_type/deal_store meta`);

  let couponsUpdated = 0;
  let dealsUpdated = 0;
  let linksWritten = 0;
  let skipped = 0;

  // ── 1. offer_type backfill ──────────────────────────────────────────

  const hasCouponCol = await hasColumn("coupons", "offer_type");
  const hasDealCol = await hasColumn("deals", "offer_type");
  if (!hasCouponCol) {
    logger.warn(
      "coupons.offer_type column not found — run the Strapi schema migration first. Skipping coupon offerType backfill."
    );
  }
  if (!hasDealCol) {
    logger.warn(
      "deals.offer_type column not found — run the Strapi schema migration first. Skipping deal offerType backfill."
    );
  }

  // Group entity ids by target table + normalized offer type for bulk UPDATEs.
  const offerTypeGroups = new Map<string, number[]>();

  for (const [postId, meta] of metaByPost) {
    if (!meta.offer_type) continue;

    const ref = getPostMapping(postId);
    if (!ref) {
      skipped++;
      continue; // post was never migrated
    }

    const offerType = normalizeOfferType(meta.offer_type);
    if (!offerType) {
      skipped++; // unknown value → leave null
      continue;
    }

    if (ref.table === "coupons" && !hasCouponCol) continue;
    if (ref.table === "deals" && !hasDealCol) continue;
    if (ref.table !== "coupons" && ref.table !== "deals") {
      skipped++;
      continue;
    }

    const key = `${ref.table}|${offerType}`;
    if (!offerTypeGroups.has(key)) offerTypeGroups.set(key, []);
    offerTypeGroups.get(key)!.push(ref.id);
  }

  for (const [key, entityIds] of offerTypeGroups) {
    const [table, offerType] = key.split("|");
    const updated = await pgQuery<{ id: number }>(
      `UPDATE "${table}" SET "offer_type" = $1 WHERE id = ANY($2::int[]) RETURNING id`,
      [offerType, entityIds]
    );
    if (table === "coupons") couponsUpdated += updated.length;
    else dealsUpdated += updated.length;
  }

  // ── 2. primaryStore backfill (deals only) ───────────────────────────

  const linkTable = await detectPrimaryStoreLinkTable();
  if (!linkTable) {
    logger.warn(
      "deals primaryStore link table (expected deals_primary_store_lnk) not found — " +
        "run the Strapi schema migration first, then re-run this phase. Skipping primaryStore backfill."
    );
  } else {
    logger.info(
      `Using link table ${linkTable.table} (${linkTable.dealCol}, ${linkTable.storeCol}) for deal.primaryStore`
    );

    // Resolve WP term IDs → Strapi store rows
    const pairs: Array<{ dealId: number; storeId: number }> = [];

    for (const [postId, meta] of metaByPost) {
      if (!meta.deal_store) continue;

      const ref = getPostMapping(postId);
      if (!ref || ref.table !== "deals") {
        skipped++;
        continue; // not a migrated deal
      }

      const termId = parseAcfTermId(meta.deal_store);
      if (!termId) {
        skipped++;
        continue;
      }

      const storeRef = await ensureTermMapping(termId);
      if (!storeRef || storeRef.table !== "stores") {
        skipped++;
        continue; // unmapped term, or term maps to a non-store collection
      }

      pairs.push({ dealId: ref.id, storeId: storeRef.id });
    }

    if (pairs.length > 0) {
      // Delete-then-insert for idempotency: primaryStore is manyToOne, so a
      // deal must never end up with two link rows even if the value changed.
      const dealIds = pairs.map((p) => p.dealId);
      await pgQuery(
        `DELETE FROM "${linkTable.table}" WHERE "${linkTable.dealCol}" = ANY($1::int[])`,
        [dealIds]
      );

      const limit = pLimit(20);
      await Promise.all(
        pairs.map((pair) =>
          limit(async () => {
            try {
              await insertLink(linkTable.table, {
                [linkTable.dealCol]: pair.dealId,
                [linkTable.storeCol]: pair.storeId,
              });
              linksWritten++;
            } catch (err: any) {
              skipped++;
              logger.error(
                `Failed to link primaryStore for deal ${pair.dealId}: ${err.message}`
              );
            }
          })
        )
      );
    }
  }

  logger.info(
    `Offer backfill complete: ${couponsUpdated} coupons updated with offerType, ` +
      `${dealsUpdated} deals updated, ${linksWritten} primaryStore links written, ${skipped} skipped`
  );
}

// ── Schema detection ─────────────────────────────────────────────────

async function hasColumn(table: string, column: string): Promise<boolean> {
  const rows = await pgQuery(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

/**
 * Finds the Strapi v5 link table for deal.primaryStore empirically. The
 * conventional name is `deals_primary_store_lnk`, but we verify against
 * information_schema (excluding the plural `deals_stores_lnk` used by the
 * stores manyToMany relation) so the phase fails gracefully when the Strapi
 * schema hasn't been migrated yet.
 */
async function detectPrimaryStoreLinkTable(): Promise<PrimaryStoreLinkTable | null> {
  const tables = await pgQuery<{ table_name: string }>(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name LIKE 'deals\\_%store%\\_lnk' ESCAPE '\\'
       AND table_name <> 'deals_stores_lnk'`
  );

  const names = tables.map((t) => t.table_name);
  const table = names.includes("deals_primary_store_lnk")
    ? "deals_primary_store_lnk"
    : names[0];
  if (!table) return null;

  const cols = await pgQuery<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1`,
    [table]
  );
  const colNames = cols.map((c) => c.column_name);

  const dealCol = colNames.includes("deal_id")
    ? "deal_id"
    : colNames.find((c) => c.startsWith("deal") && c.endsWith("_id"));
  const storeCol = colNames.includes("store_id")
    ? "store_id"
    : colNames.find((c) => c !== dealCol && c.includes("store") && c.endsWith("_id"));

  if (!dealCol || !storeCol) {
    logger.warn(
      `Link table ${table} exists but expected columns not found (have: ${colNames.join(", ")})`
    );
    return null;
  }

  return { table, dealCol, storeCol };
}

// ── Helpers ──────────────────────────────────────────────────────────

function normalizeOfferType(raw: string): string | null {
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return OFFER_TYPES.has(normalized) ? normalized : null;
}

/**
 * Parses an ACF term-reference meta value into a WP term ID. Depending on the
 * ACF field config the value is either a plain ID ("123") or a PHP-serialized
 * array (`a:1:{i:0;s:3:"123";}`).
 */
function parseAcfTermId(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10);
  }

  // PHP-serialized value (array, string, or int)
  if (/^[asiO]:/.test(trimmed)) {
    try {
      const parsed = unserialize(trimmed);
      const first = Array.isArray(parsed)
        ? parsed[0]
        : parsed !== null && typeof parsed === "object"
          ? Object.values(parsed)[0]
          : parsed;
      const id = parseInt(String(first), 10);
      return isNaN(id) ? null : id;
    } catch {
      return null;
    }
  }

  const fallback = parseInt(trimmed, 10);
  return isNaN(fallback) ? null : fallback;
}
