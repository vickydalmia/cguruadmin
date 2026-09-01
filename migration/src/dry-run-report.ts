import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { wpQuery, closeWp } from "./db/wp-client.js";
import { logger } from "./utils/logger.js";
import { shouldImportMigrationOffer } from "./utils/content-status.js";
import { parseExpiryDate } from "./utils/wp-dates.js";
import {
  getWpOfferExpiryRaw,
  type WpOfferExpiryMeta,
} from "./utils/wp-offer-expiry.js";
import {
  hasExcludedTerm,
  loadExcludedStoreNames,
  resolveImportExclusions,
  type TermRowLike,
} from "./utils/import-exclusions.js";
import {
  classifyTaxonomyTerms,
  formatTaxonomyClassificationReport,
} from "./utils/taxonomy-classification.js";

const TYPE_LABELS = ["Store", "Brand", "Category", "Bank"] as const;

const REPORT_CSV = path.resolve(config.stateDir, "dry-run-report.csv");
const EXCLUDED_CSV = path.resolve(config.stateDir, "dry-run-excluded.csv");
const SUMMARY_CSV = path.resolve(config.stateDir, "dry-run-summary.csv");

interface TermTally {
  /** Every fetched post carrying this term. */
  total: number;
  /** Posts that will actually import (lifecycle-valid AND not excluded). */
  valid: number;
  /** Lifecycle-valid posts — for an excluded term, these are the ones the
   * exclusion deletes (the remainder were expired anyway). */
  lifecycleOk: number;
}

interface OfferStats {
  /** Every fetched publish/future post (the funnel's starting total). */
  totalPublished: number;
  /** Posts that would import (lifecycle-valid AND not excluded). */
  valid: number;
  /** Deleted because filed under the Articles tree (counted first). */
  articleExcluded: number;
  /** Deleted because filed under Uncategorized (and not Articles). */
  uncategorizedExcluded: number;
  /** Deleted because filed under a retired store (and not under either rule
   * above — buckets are mutually exclusive so the funnel adds up exactly). */
  storeExcluded: number;
  /** Publish/future posts rejected because their expiry has elapsed. */
  expiredExcluded: number;
  /** term_id → tallies over every fetched post carrying that term. */
  byTerm: Map<number, TermTally>;
}

/**
 * Fetch every candidate WP post of one kind and classify it the same way
 * phases 07/08 will: offer lifecycle first, then the excluded-term rule.
 */
async function collectOfferStats(
  kind: "coupon" | "deal",
  now: Date,
  exclusions: {
    termIds: ReadonlySet<number>;
    articleTermIds: ReadonlySet<number>;
    uncategorizedTermIds: ReadonlySet<number>;
  },
): Promise<OfferStats> {
  const dealPredicate =
    kind === "deal"
      ? `EXISTS (
           SELECT 1 FROM wp_postmeta
           WHERE post_id = p.ID AND meta_key = 'is_deal' AND meta_value = 'yes'
         )`
      : `NOT EXISTS (
           SELECT 1 FROM wp_postmeta
           WHERE post_id = p.ID AND meta_key = 'is_deal' AND meta_value = 'yes'
         )`;
  const posts = await wpQuery<{ ID: number; post_status: string }>(`
    SELECT p.ID, p.post_status
    FROM wp_posts p
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
      AND ${dealPredicate}
  `);

  const batchSize = 5_000;
  const metaByPost = new Map<number, WpOfferExpiryMeta>();
  const termsByPost = new Map<number, number[]>();
  for (let start = 0; start < posts.length; start += batchSize) {
    const ids = posts.slice(start, start + batchSize).map((post) => post.ID);
    const placeholders = ids.map(() => "?").join(",");
    const [metaRows, termRows] = await Promise.all([
      wpQuery<{ post_id: number; meta_key: string; meta_value: string }>(
        `SELECT post_id, meta_key, meta_value
         FROM wp_postmeta
         WHERE post_id IN (${placeholders})
           AND meta_key IN (
             '_action_manager_date',
             '_expiration-date',
             '_expiration-date-status',
             'expiration-date'
           )`,
        ids,
      ),
      wpQuery<{ object_id: number; term_id: number }>(
        `SELECT tr.object_id, tt.term_id
         FROM wp_term_relationships tr
         JOIN wp_term_taxonomy tt
           ON tr.term_taxonomy_id = tt.term_taxonomy_id AND tt.taxonomy = 'category'
         WHERE tr.object_id IN (${placeholders})`,
        ids,
      ),
    ]);
    for (const row of metaRows) {
      const meta = metaByPost.get(row.post_id) ?? {};
      meta[row.meta_key] = row.meta_value;
      metaByPost.set(row.post_id, meta);
    }
    for (const row of termRows) {
      const list = termsByPost.get(row.object_id) ?? [];
      list.push(row.term_id);
      termsByPost.set(row.object_id, list);
    }
  }

  const stats: OfferStats = {
    totalPublished: posts.length,
    valid: 0,
    articleExcluded: 0,
    uncategorizedExcluded: 0,
    storeExcluded: 0,
    expiredExcluded: 0,
    byTerm: new Map(),
  };
  for (const post of posts) {
    const lifecycleOk = shouldImportMigrationOffer({
      postStatus: post.post_status,
      expiresAt: parseExpiryDate(
        getWpOfferExpiryRaw(metaByPost.get(post.ID) ?? {}),
      ),
      now,
    });
    const terms = termsByPost.get(post.ID) ?? [];
    const excluded = hasExcludedTerm(terms, exclusions.termIds);
    const valid = lifecycleOk && !excluded;
    if (valid) stats.valid++;
    else if (!lifecycleOk) stats.expiredExcluded++;
    else if (hasExcludedTerm(terms, exclusions.articleTermIds)) {
      stats.articleExcluded++;
    } else if (hasExcludedTerm(terms, exclusions.uncategorizedTermIds)) {
      stats.uncategorizedExcluded++;
    } else stats.storeExcluded++;

    for (const termId of terms) {
      const tally =
        stats.byTerm.get(termId) ?? { total: 0, valid: 0, lifecycleOk: 0 };
      tally.total++;
      if (valid) tally.valid++;
      if (lifecycleOk) tally.lifecycleOk++;
      stats.byTerm.set(termId, tally);
    }
  }
  return stats;
}

function csvField(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * `yarn migrate:report` — read-only preview of what a full import would
 * bring in, after every exclusion rule (Articles category tree,
 * Uncategorized, retired stores, offer lifecycle). Reads WordPress only;
 * writes only the three dry-run CSV reports beside this workspace.
 */
async function main(): Promise<void> {
  logger.info("=== Import dry-run report (read-only) ===");

  const sourceTerms = await wpQuery<TermRowLike>(`
    SELECT t.term_id, t.name, t.slug, tt.parent,
           MAX(CASE WHEN tm.meta_key='choose_type' THEN tm.meta_value END) AS choose_type
    FROM wp_terms t
    JOIN wp_term_taxonomy tt ON t.term_id = tt.term_id AND tt.taxonomy = 'category'
    LEFT JOIN wp_termmeta tm ON t.term_id = tm.term_id AND tm.meta_key = 'choose_type'
    GROUP BY t.term_id, t.name, t.slug, tt.parent
  `);
  const classification = await classifyTaxonomyTerms(sourceTerms);
  const terms = classification.terms;
  logger.info(formatTaxonomyClassificationReport(classification.report));
  // RAW rows for exclusions (phase 03 parity): classification would erase
  // the Article(s) choose_type signal.
  const exclusions = resolveImportExclusions(
    sourceTerms,
    loadExcludedStoreNames(),
  );

  const now = new Date();
  const couponStats = await collectOfferStats("coupon", now, exclusions);
  const dealStats = await collectOfferStats("deal", now, exclusions);

  // Per-imported-term CSV: type, associated offer counts, how many of those
  // will not import (expired or excluded), and the remaining valid counts.
  const entityCounts: Record<string, number> = {
    Store: 0,
    Brand: 0,
    Category: 0,
    Bank: 0,
  };
  let unknownAsStore = 0;
  const lines: string[] = [
    [
      "term_id",
      "name",
      "slug",
      "type",
      "coupons_associated",
      "coupons_deleted",
      "coupons_valid",
      "deals_associated",
      "deals_deleted",
      "deals_valid",
    ].join(","),
  ];
  const importedTerms = terms
    .filter((term) => !exclusions.termIds.has(term.term_id))
    .map((term) => {
      const chooseType = (term.choose_type || "Store").trim();
      const known = (TYPE_LABELS as readonly string[]).includes(chooseType);
      if (!known) unknownAsStore++;
      const type = known ? chooseType : "Store";
      entityCounts[type]++;
      return { term, type };
    })
    .sort(
      (a, b) =>
        a.type.localeCompare(b.type) || a.term.name.localeCompare(b.term.name),
    );
  for (const { term, type } of importedTerms) {
    const coupons = couponStats.byTerm.get(term.term_id) ?? { total: 0, valid: 0 };
    const deals = dealStats.byTerm.get(term.term_id) ?? { total: 0, valid: 0 };
    lines.push(
      [
        term.term_id,
        csvField(term.name),
        csvField(term.slug),
        type,
        coupons.total,
        coupons.total - coupons.valid,
        coupons.valid,
        deals.total,
        deals.total - deals.valid,
        deals.valid,
      ].join(","),
    );
  }
  fs.writeFileSync(REPORT_CSV, lines.join("\n") + "\n");

  // Second CSV: every EXCLUDED term with what its exclusion deletes.
  // `*_deleted` counts lifecycle-valid posts (they would have imported);
  // the rest of `*_associated` were expired regardless. Unmatched
  // CSV names get a row too, so the whole exclusion list is accounted for.
  const excludedLines: string[] = [
    [
      "term_id",
      "name",
      "slug",
      "reason",
      "coupons_associated",
      "coupons_deleted",
      "deals_associated",
      "deals_deleted",
    ].join(","),
  ];
  const excludedTerms = terms
    .filter((term) => exclusions.termIds.has(term.term_id))
    .map((term) => ({
      term,
      reason: exclusions.articleTermIds.has(term.term_id)
        ? "articles"
        : exclusions.uncategorizedTermIds.has(term.term_id)
          ? "uncategorized"
          : "retired-store",
    }))
    .sort(
      (a, b) =>
        a.reason.localeCompare(b.reason) ||
        a.term.name.localeCompare(b.term.name),
    );
  let excludedStoreCouponsDeleted = 0;
  let excludedStoreDealsDeleted = 0;
  for (const { term, reason } of excludedTerms) {
    const coupons =
      couponStats.byTerm.get(term.term_id) ??
      { total: 0, valid: 0, lifecycleOk: 0 };
    const deals =
      dealStats.byTerm.get(term.term_id) ??
      { total: 0, valid: 0, lifecycleOk: 0 };
    if (reason === "retired-store") {
      excludedStoreCouponsDeleted += coupons.lifecycleOk;
      excludedStoreDealsDeleted += deals.lifecycleOk;
    }
    excludedLines.push(
      [
        term.term_id,
        csvField(term.name),
        csvField(term.slug),
        reason,
        coupons.total,
        coupons.lifecycleOk,
        deals.total,
        deals.lifecycleOk,
      ].join(","),
    );
  }
  for (const name of exclusions.unmatchedStoreNames) {
    excludedLines.push(
      ["", csvField(name), "", "unmatched-name", 0, 0, 0, 0].join(","),
    );
  }
  fs.writeFileSync(EXCLUDED_CSV, excludedLines.join("\n") + "\n");

  // Third CSV: the mutually-exclusive import funnel. Lifecycle expiry is
  // counted first, then Articles, Uncategorized, retired stores, and final.
  const summaryLines: string[] = [
    [
      "kind",
      "total_publish_future",
      "expired_deleted",
      "articles_deleted",
      "uncategorized_deleted",
      "retired_store_deleted",
      "final_imported",
    ].join(","),
  ];
  for (const [kind, stats] of [
    ["coupons", couponStats],
    ["deals", dealStats],
  ] as const) {
    summaryLines.push(
      [
        kind,
        stats.totalPublished,
        stats.expiredExcluded,
        stats.articleExcluded,
        stats.uncategorizedExcluded,
        stats.storeExcluded,
        stats.valid,
      ].join(","),
    );
  }
  summaryLines.push(
    [
      "total",
      couponStats.totalPublished + dealStats.totalPublished,
      couponStats.expiredExcluded + dealStats.expiredExcluded,
      couponStats.articleExcluded + dealStats.articleExcluded,
      couponStats.uncategorizedExcluded + dealStats.uncategorizedExcluded,
      couponStats.storeExcluded + dealStats.storeExcluded,
      couponStats.valid + dealStats.valid,
    ].join(","),
  );
  fs.writeFileSync(SUMMARY_CSV, summaryLines.join("\n") + "\n");

  logger.info("---------------------------------------------");
  logger.info("Would import (after all exclusions):");
  logger.info(
    `  Stores:     ${entityCounts.Store}` +
      (unknownAsStore > 0
        ? `  (includes ${unknownAsStore} unknown-type term(s) defaulting to Store)`
        : ""),
  );
  logger.info(`  Brands:     ${entityCounts.Brand}`);
  logger.info(`  Categories: ${entityCounts.Category}`);
  logger.info(`  Banks:      ${entityCounts.Bank}`);
  logger.info(`  Coupons:    ${couponStats.valid}`);
  logger.info(`  Deals:      ${dealStats.valid}`);
  logger.info("Funnel (published+future → final):");
  logger.info(
    `  Coupons: ${couponStats.totalPublished} total − ` +
      `${couponStats.expiredExcluded} expired − ` +
      `${couponStats.articleExcluded} articles − ` +
      `${couponStats.uncategorizedExcluded} Uncategorized − ` +
      `${couponStats.storeExcluded} retired-store = ${couponStats.valid}`,
  );
  logger.info(
    `  Deals:   ${dealStats.totalPublished} total − ` +
      `${dealStats.expiredExcluded} expired − ` +
      `${dealStats.articleExcluded} articles − ` +
      `${dealStats.uncategorizedExcluded} Uncategorized − ` +
      `${dealStats.storeExcluded} retired-store = ${dealStats.valid}`,
  );
  logger.info(
    `  Article terms (Articles category + descendants): ${exclusions.articleTermIds.size}`,
  );
  logger.info(
    `  Uncategorized terms: ${exclusions.uncategorizedTermIds.size}`,
  );
  logger.info(
    `  Retired stores matched from excluded-stores.csv: ${exclusions.excludedStoreTermIds.size} ` +
      `(deleting ~${excludedStoreCouponsDeleted} coupon(s), ` +
      `~${excludedStoreDealsDeleted} deal(s); per-term sums, a post under two ` +
      `excluded stores counts twice — the dedup'd totals are the lines above)`,
  );
  if (exclusions.unmatchedStoreNames.length > 0) {
    const sample = exclusions.unmatchedStoreNames.slice(0, 10).join("; ");
    logger.warn(
      `  ${exclusions.unmatchedStoreNames.length} listed store name(s) matched ` +
        `no WordPress store term: ${sample}` +
        (exclusions.unmatchedStoreNames.length > 10 ? "; ..." : ""),
    );
  }
  logger.info(`Per-term breakdown written to ${REPORT_CSV}`);
  logger.info(`Excluded-term breakdown written to ${EXCLUDED_CSV}`);
  logger.info(`Funnel summary written to ${SUMMARY_CSV}`);
  logger.info("---------------------------------------------");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main()
    .catch((error) => {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeWp();
    });
}
