/**
 * One-time backfill for Coupon/Deal `checkoutMerchant`.
 *
 * WHY: `checkoutMerchant` was added to both offer schemas after the catalogue
 * already existed, so it is NULL on every row. It is the field the festive
 * offer keys off — a Store or Brand with `isFestiveOffer` on restyles every
 * offer whose checkout merchant points at it — so until it is populated,
 * switching a campaign on changes nothing on the site.
 *
 * The derivation is the one the product owner specified:
 *
 *   first Store  →  else first Brand  →  else logoStore
 *
 * "First" means the editor's relation order: the many-to-many link tables carry
 * a `coupon_ord` / `deal_ord` column and the public API returns rows in that
 * order, so the backfill must sort by it or it would pick a different merchant
 * than the site would have shown. The logoStore link table is many-to-one and
 * has no ord column (see utils/offer-relations.ts).
 *
 * ONE-TIME, not a rule. Offers created after this runs are left to the editor:
 * the field is a manual choice, and a blank one simply gets no festive
 * treatment. Re-running is safe and fills only what is still blank.
 *
 * Targets whatever PG_CONNECTION_STRING resolves to (the DEPLOYED database).
 * Dry-run prints the counts it would write; applying requires the host
 * confirmation flag:
 *
 *   yarn backfill:checkout-merchant                              # dry-run
 *   yarn backfill:checkout-merchant --apply --yes-i-mean-<host>  # write
 *
 * NOTE: writes via SQL, bypassing the documents middleware. That is deliberate
 * — going through the document service would emit one ISR outbox event per
 * offer and flood the queue for what is a single bulk change. Cached pages stay
 * stale until the next rebuild, so trigger a full regeneration afterwards.
 */

import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";
import path from "path";
import { fileURLToPath } from "url";

type OfferTable = "coupons" | "deals";

type OfferDescriptor = {
  table: OfferTable;
  ownerColumn: "coupon_id" | "deal_id";
  orderColumn: "coupon_ord" | "deal_ord";
};

const OFFER_TABLES: readonly OfferDescriptor[] = [
  { table: "coupons", ownerColumn: "coupon_id", orderColumn: "coupon_ord" },
  { table: "deals", ownerColumn: "deal_id", orderColumn: "deal_ord" },
];

/** Mirrors formatCheckoutMerchant() in src/constants/checkout-merchant.ts. */
type MerchantSource = "store" | "brand" | "logoStore";

type PendingRow = {
  id: number;
  merchant: string | null;
  source: MerchantSource | null;
};

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await pgQuery(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

/**
 * Three LATERAL lookups, one per step of the chain, each an index seek on the
 * link table. Deliberately NOT an OR-of-EXISTS: that shape inflated planner
 * costs badly enough on this database to trip JIT compilation and turn a fast
 * query into a 17-second one (see the same note in
 * backfill-entity-updated-at.ts).
 *
 * `document_id`, not `id`: checkoutMerchant stores the Strapi 5 documentId.
 */
function pendingSql(offer: OfferDescriptor): string {
  const { table, ownerColumn, orderColumn } = offer;

  const manyToMany = (
    linkTable: string,
    targetTable: string,
    targetColumn: string,
    kind: string,
  ) => `
      LEFT JOIN LATERAL (
        SELECT '${kind}:' || t."document_id" AS ref
        FROM "${linkTable}" l
        JOIN "${targetTable}" t ON t."id" = l."${targetColumn}"
        WHERE l."${ownerColumn}" = o."id"
        ORDER BY l."${orderColumn}" NULLS LAST, t."id"
        LIMIT 1
      ) ${kind}_ref ON TRUE`;

  return `
    SELECT o."id",
           COALESCE(store_ref.ref, brand_ref.ref, logo_ref.ref) AS merchant,
           CASE
             WHEN store_ref.ref IS NOT NULL THEN 'store'
             WHEN brand_ref.ref IS NOT NULL THEN 'brand'
             WHEN logo_ref.ref  IS NOT NULL THEN 'logoStore'
           END AS source
    FROM "${table}" o
    ${manyToMany(`${table}_stores_lnk`, "stores", "store_id", "store")}
    ${manyToMany(`${table}_brands_lnk`, "brands", "brand_id", "brand")}
    LEFT JOIN LATERAL (
      SELECT 'store:' || s."document_id" AS ref
      FROM "${table}_logo_store_lnk" l
      JOIN "stores" s ON s."id" = l."store_id"
      WHERE l."${ownerColumn}" = o."id"
      LIMIT 1
    ) logo_ref ON TRUE
    WHERE o."checkout_merchant" IS NULL
       OR btrim(o."checkout_merchant") = ''`;
}

async function backfillOfferTable(
  offer: OfferDescriptor,
  apply: boolean,
): Promise<void> {
  const { table } = offer;

  // The column only exists once Strapi has booted against this database with
  // the new schema. Without this guard the query fails with a bare Postgres
  // error that reads like a bug rather than "restart Strapi first".
  if (!(await columnExists(table, "checkout_merchant"))) {
    logger.error(
      `${table}: no "checkout_merchant" column. Start Strapi once against this ` +
        `database so it applies the schema, then re-run.`,
    );
    process.exitCode = 1;
    return;
  }

  const rows = await pendingRows(offer);
  const derivable = rows.filter((row) => row.merchant);
  const counts: Record<MerchantSource, number> = {
    store: 0,
    brand: 0,
    logoStore: 0,
  };
  for (const row of derivable) {
    if (row.source) counts[row.source] += 1;
  }
  const orphans = rows.length - derivable.length;

  logger.info(
    `${table}: ${rows.length} blank, ${derivable.length} derivable ` +
      `${apply ? "to update" : "would change"} ` +
      `(store ${counts.store}, brand ${counts.brand}, logoStore ${counts.logoStore})`,
  );
  if (orphans > 0) {
    // Not a failure: an offer with no Store, Brand or logoStore has no merchant
    // to name, and a blank checkoutMerchant simply means no festive treatment.
    logger.warn(
      `${table}: ${orphans} row(s) left blank — no Store, Brand or logoStore attached.`,
    );
  }
  if (!apply || derivable.length === 0) return;

  const CHUNK = 500;
  let done = 0;
  for (let i = 0; i < derivable.length; i += CHUNK) {
    const chunk = derivable.slice(i, i + CHUNK);
    const tuples: string[] = [];
    const params: Array<number | string> = [];
    chunk.forEach((row, idx) => {
      const base = idx * 2;
      tuples.push(`($${base + 1}::int, $${base + 2}::text)`);
      params.push(row.id, row.merchant as string);
    });

    // Re-assert the blank check in the UPDATE: between the SELECT above and
    // this write an editor could have set the field by hand, and their choice
    // outranks a derived default.
    await pgQuery(
      `UPDATE "${table}" AS o
         SET "checkout_merchant" = v.merchant
       FROM (VALUES ${tuples.join(", ")}) AS v(id, merchant)
       WHERE o."id" = v.id
         AND (o."checkout_merchant" IS NULL OR btrim(o."checkout_merchant") = '')`,
      params,
    );
    done += chunk.length;
    logger.info(`${table}: updated ${done}/${derivable.length}`);
  }
}

async function pendingRows(offer: OfferDescriptor): Promise<PendingRow[]> {
  return pgQuery<PendingRow>(pendingSql(offer));
}

export async function runCheckoutMerchantBackfill(apply: boolean): Promise<void> {
  for (const offer of OFFER_TABLES) {
    await backfillOfferTable(offer, apply);
  }
  if (!apply) {
    logger.info("Dry-run complete — pass --apply --yes-i-mean-<host> to write.");
  } else {
    logger.info(
      "Done. Trigger a full site regeneration: these SQL writes bypass the " +
        "documents middleware, so no ISR events were emitted.",
    );
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;
  logger.info(
    `backfill-checkout-merchant target host: ${host} (${apply ? "APPLY" : "dry-run"})`,
  );
  if (apply && !process.argv.includes(`--yes-i-mean-${host}`)) {
    logger.error(
      `Refusing to write: --apply sets checkoutMerchant on every blank Coupon ` +
        `and Deal on ${host}. Re-run with --yes-i-mean-${host} to confirm.`,
    );
    process.exit(1);
  }

  try {
    await runCheckoutMerchantBackfill(apply);
  } catch (err: any) {
    logger.error(`Backfill failed: ${err.message}`);
    logger.error(err.stack);
    process.exitCode = 1;
  } finally {
    await closePg();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
