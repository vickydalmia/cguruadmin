import { pgQuery } from "../db/pg-client.js";
import { getAllTermMappings } from "../utils/id-maps.js";
import {
  loadYoastSiteConfig,
  resolveTermSeo,
} from "../utils/yoast-term-seo.js";
import { insertComponent } from "../utils/strapi-insert.js";
import { clean } from "../utils/sanitize.js";
import { logger } from "../utils/logger.js";

/**
 * Backfill SEO components for entities phase 03 somehow left without one.
 * Uses the SAME Yoast resolution as phase 03 (per-term overrides from
 * wpseo_taxonomy_meta → taxonomy templates from wpseo_titles → name
 * fallback), so both paths can never disagree about what a term's SEO is.
 */
export async function runSeoBackfill(): Promise<void> {
  logger.info("=== Phase 9: SEO Backfill ===");

  const tablesWithSeo = ["stores", "brands", "categories", "banks"];
  const yoastSite = await loadYoastSiteConfig();
  const termMappings = getAllTermMappings();

  let backfilled = 0;

  for (const table of tablesWithSeo) {
    const entitiesWithSeo = await pgQuery<{ entity_id: number }>(`
      SELECT entity_id FROM "${table}_cmps"
      WHERE field = 'seo' AND component_type = 'shared.seo'
    `);
    const hasSeo = new Set(entitiesWithSeo.map((r) => r.entity_id));

    const allEntities = await pgQuery<{ id: number; name?: string }>(`
      SELECT id, "name"
      FROM "${table}"
    `);

    const needsSeo = allEntities.filter((e) => !hasSeo.has(e.id));
    if (needsSeo.length === 0) continue;

    logger.info(`${table}: ${needsSeo.length} entities need SEO backfill`);

    for (const entity of needsSeo) {
      // Find the WP term for this entity to reach its Yoast data.
      let wpTermId: number | null = null;
      for (const [candidateTermId, ref] of termMappings) {
        if (ref.id === entity.id && ref.table === table) {
          wpTermId = candidateTermId;
          break;
        }
      }

      const entityName = entity.name || "";
      const seo =
        wpTermId !== null
          ? resolveTermSeo(yoastSite, {
              termId: wpTermId,
              taxonomy: "category",
              termName: entityName,
            })
          : {
              metaTitle: null,
              metaDescription: null,
              canonicalUrl: null,
              noIndex: false,
            };

      // Same fallbacks and caps as phase 03, so the two paths converge.
      const metaTitle = (clean(seo.metaTitle) || entityName).slice(0, 70);
      const metaDescription = (
        clean(seo.metaDescription) ||
        `${entityName} coupons, offers and deals.`
      ).slice(0, 170);
      if (!metaTitle) continue;

      await insertComponent(
        "components_shared_seos",
        {
          meta_title: metaTitle,
          meta_description: metaDescription,
          canonical_url: seo.canonicalUrl,
          no_index: seo.noIndex,
        },
        table,
        entity.id,
        "seo",
        "shared.seo"
      );
      backfilled++;
    }
  }

  logger.info(`SEO backfill complete: ${backfilled} components added`);
}
