import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { getAllTermMappings } from "../utils/id-maps.js";
import { resolveYoastVariables } from "../utils/yoast-vars.js";
import { insertComponent } from "../utils/strapi-insert.js";
import { logger } from "../utils/logger.js";

export async function runSeoBackfill(): Promise<void> {
  logger.info("=== Phase 9: SEO Backfill ===");

  // Check which entities already have SEO components
  const tablesWithSeo = ["stores", "brands", "categories", "banks"];

  let backfilled = 0;

  for (const table of tablesWithSeo) {
    // Find entities without SEO components
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

    // For taxonomy tables, try to get SEO from Yoast indexable
    if (["stores", "brands", "categories", "banks"].includes(table)) {
      // Try wp_yoast_indexable for term SEO
      try {
        const yoastRows = await wpQuery<{
          object_id: number;
          title: string | null;
          description: string | null;
        }>(`
          SELECT object_id, title, description
          FROM wp_yoast_indexable
          WHERE object_type = 'term'
          AND object_sub_type = 'category'
        `);

        const yoastMap = new Map(
          yoastRows.map((r) => [r.object_id, { title: r.title, description: r.description }])
        );
        const termMappings = getAllTermMappings();

        for (const entity of needsSeo) {
          // Find the WP term_id for this entity
          for (const [wpTermId, ref] of termMappings) {
            if (ref.id === entity.id && ref.table === table) {
              const yoast = yoastMap.get(wpTermId);
              if (yoast && (yoast.title || yoast.description)) {
                const metaTitle = resolveYoastVariables(
                  yoast.title,
                  entity.name || ""
                );
                await insertComponent(
                  "components_shared_seos",
                  {
                    meta_title: metaTitle || null,
                    meta_description: yoast.description || null,
                    canonical_url: null,
                  },
                  table,
                  entity.id,
                  "seo",
                  "shared.seo"
                );
                backfilled++;
              }
              break;
            }
          }
        }
      } catch {
        logger.warn(`wp_yoast_indexable not available for ${table} SEO backfill`);
      }
    }
  }

  logger.info(`SEO backfill complete: ${backfilled} components added`);
}
