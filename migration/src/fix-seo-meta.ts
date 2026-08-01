import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { wpQuery, closeWp } from "./db/wp-client.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { loadMaps, getAllTermMappings } from "./utils/id-maps.js";
import {
  loadYoastSiteConfig,
  resolveTermSeo,
} from "./utils/yoast-term-seo.js";
import { clean } from "./utils/sanitize.js";
import { syncSinglesSeo } from "./utils/singles-seo.js";
import { replaceMedia } from "./utils/strapi-insert.js";
import { uploadMediaOnDemand } from "./phases/02-media-upload.js";
import { logger } from "./utils/logger.js";

/**
 * Repair meta title / description / canonical / noindex on ALREADY-IMPORTED
 * entities using the correct Yoast resolution (wpseo_taxonomy_meta overrides
 * → wpseo_titles templates), fixing rows imported by the old wp_termmeta
 * lookup that never found anything.
 *
 *   yarn fix:seo-meta                              # dry run (default)
 *   yarn fix:seo-meta --apply --yes-i-mean-<host>  # write
 *
 * Targeted UPDATEs on components_shared_seos only — minutes, not a re-import.
 */

const TABLES = ["stores", "brands", "categories", "banks"] as const;

interface SeoRow {
  entity_id: number;
  name: string;
  seo_id: number;
  meta_title: string | null;
  meta_description: string | null;
  canonical_url: string | null;
  no_index: boolean | null;
  og_title: string | null;
  og_description: string | null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const host = new URL(config.pg.connectionString).hostname;
  if (apply && !process.argv.includes(`--yes-i-mean-${host}`)) {
    logger.error(
      `Refusing to write: --apply updates SEO components on ${host}. ` +
        `Re-run with --apply --yes-i-mean-${host} to confirm.`,
    );
    process.exitCode = 1;
    return;
  }

  loadMaps();
  const termMappings = getAllTermMappings();
  if (termMappings.size === 0) {
    throw new Error(
      "No term mappings found (.checkpoints/termIdMap.json) — run the " +
        "migration first; this script repairs already-imported entities.",
    );
  }
  const yoastSite = await loadYoastSiteConfig();
  logger.info(
    `Yoast config: separator "${yoastSite.separator}", ` +
      `site "${yoastSite.siteName}", ` +
      `${Object.keys(yoastSite.overrides.category ?? {}).length} category override(s)`,
  );

  // WP term text needed for %%term_description%% and the description fallback.
  const wpTerms = await wpQuery<{
    term_id: number;
    description: string;
    short_desc: string | null;
  }>(`
    SELECT t.term_id, tt.description,
           MAX(CASE WHEN tm.meta_key='store_short_description' THEN tm.meta_value END) AS short_desc
    FROM wp_terms t
    JOIN wp_term_taxonomy tt ON t.term_id = tt.term_id AND tt.taxonomy='category'
    LEFT JOIN wp_termmeta tm ON t.term_id = tm.term_id AND tm.meta_key='store_short_description'
    GROUP BY t.term_id, tt.description
  `);
  const wpTermById = new Map(wpTerms.map((t) => [t.term_id, t]));

  // Strapi entity id → WP term id, per table.
  const wpTermByEntity = new Map<string, number>();
  for (const [wpTermId, ref] of termMappings) {
    wpTermByEntity.set(`${ref.table}:${ref.id}`, wpTermId);
  }

  let changed = 0;
  let unchanged = 0;
  let unmapped = 0;
  let processed = 0;
  const samples: string[] = [];

  for (const table of TABLES) {
    const rows = await pgQuery<SeoRow>(`
      SELECT e.id AS entity_id, e.name, s.id AS seo_id,
             s.meta_title, s.meta_description, s.canonical_url, s.no_index,
             s.og_title, s.og_description
      FROM "${table}" e
      JOIN "${table}_cmps" cmp
        ON cmp.entity_id = e.id
       AND cmp.field = 'seo'
       AND cmp.component_type = 'shared.seo'
      JOIN components_shared_seos s ON s.id = cmp.cmp_id
      ORDER BY e.id
    `);

    for (const row of rows) {
      processed++;
      if (processed % 500 === 0) {
        logger.info(
          `SEO repair progress: ${processed} entities checked ` +
            `(${changed} ${apply ? "updated" : "to update"})`,
        );
      }
      const wpTermId = wpTermByEntity.get(`${table}:${row.entity_id}`);
      if (wpTermId === undefined) {
        unmapped++;
        continue;
      }
      const wpTerm = wpTermById.get(wpTermId);
      const plainTermDescription = clean(
        wpTerm?.description?.replace(/<[^>]*>/gu, " "),
      );

      const seo = resolveTermSeo(yoastSite, {
        termId: wpTermId,
        taxonomy: "category",
        termName: row.name,
        termDescription: plainTermDescription || undefined,
      });
      // No term-content fallback — Yoast → short description → generic only.
      const yoastDescription = clean(seo.metaDescription);
      const shortDescription = clean(wpTerm?.short_desc);
      const nextTitle = (clean(seo.metaTitle) || row.name).slice(0, 70);
      const nextDescription = (
        yoastDescription ||
        shortDescription ||
        `${row.name} coupons, offers and deals.`
      ).slice(0, 170);
      const descSource = yoastDescription
        ? yoastSite.overrides.category?.[wpTermId]?.wpseo_desc
          ? "yoast-override"
          : "yoast-template"
        : shortDescription
          ? "short-desc"
          : "generic";
      const titleSource = clean(seo.metaTitle)
        ? yoastSite.overrides.category?.[wpTermId]?.wpseo_title
          ? "yoast-override"
          : "yoast-template"
        : "name-fallback";
      const nextCanonical = seo.canonicalUrl;
      const nextNoIndex = seo.noIndex;

      const same =
        row.meta_title === nextTitle &&
        row.meta_description === nextDescription &&
        (row.canonical_url ?? null) === (nextCanonical ?? null) &&
        Boolean(row.no_index) === nextNoIndex &&
        (row.og_title ?? null) === (seo.ogTitle ?? null) &&
        (row.og_description ?? null) === (seo.ogDescription ?? null) &&
        !seo.ogImageAttachmentId;
      if (same) {
        unchanged++;
        continue;
      }

      changed++;
      if (samples.length < 10) {
        samples.push(
          `${table}/${row.name}:\n` +
            `    title [${titleSource}]: "${row.meta_title}" → "${nextTitle}"\n` +
            `    desc  [${descSource}]: "${(row.meta_description ?? "").slice(0, 60)}…" → ` +
            `"${nextDescription}"` +
            (nextNoIndex !== Boolean(row.no_index)
              ? `\n    noIndex: ${Boolean(row.no_index)} → ${nextNoIndex}`
              : "") +
            (nextCanonical ? `\n    canonical: ${nextCanonical}` : ""),
        );
      }

      if (apply) {
        await pgQuery(
          `UPDATE components_shared_seos
              SET meta_title = $1,
                  meta_description = $2,
                  canonical_url = $3,
                  no_index = $4,
                  og_title = $5,
                  og_description = $6
            WHERE id = $7`,
          [
            nextTitle,
            nextDescription,
            nextCanonical,
            nextNoIndex,
            seo.ogTitle,
            seo.ogDescription,
            row.seo_id,
          ],
        );
        // Per-term OG image via the normal media pipeline (manifest-reused).
        if (seo.ogImageAttachmentId) {
          try {
            const ogFileId = await uploadMediaOnDemand(seo.ogImageAttachmentId);
            if (ogFileId) {
              await replaceMedia(ogFileId, row.seo_id, "shared.seo", "ogImage");
            }
          } catch (err: any) {
            logger.warn(`OG image for ${table}/${row.name} failed: ${err.message}`);
          }
        }
      }
    }
  }

  // Single types (homepage, deal-of-the-day, about/career/contact/faq).
  const singles = await syncSinglesSeo(apply);
  logger.info(
    `Singles SEO ${apply ? "updated" : "planned"}: ${singles.updated.join(", ")}` +
      (singles.ogImagesLinked ? ` (+${singles.ogImagesLinked} OG image(s))` : ""),
  );

  for (const sample of samples) logger.info(`  ${sample}`);
  logger.info(
    `SEO repair ${apply ? "APPLIED" : "dry-run"}: ${changed} to update, ` +
      `${unchanged} already correct, ${unmapped} without a WP mapping`,
  );
  if (!apply) {
    logger.info(
      `Dry-run complete — pass --apply --yes-i-mean-${host} to write.`,
    );
  }
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
      await closePg();
    });
}
