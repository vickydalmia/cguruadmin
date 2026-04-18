import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { setTagMapping } from "../utils/id-maps.js";
import { deduplicateSlug } from "../utils/slug-dedup.js";
import { generateDocumentId, getEntityIdByDocumentId } from "../utils/strapi-insert.js";
import { clean, cleanSlug } from "../utils/sanitize.js";
import { logger } from "../utils/logger.js";

export async function runTags(): Promise<void> {
  logger.info("=== Phase 4: Tags Migration ===");

  const tags = await wpQuery<{
    term_id: number;
    name: string;
    slug: string;
  }>(`
    SELECT t.term_id, t.name, t.slug
    FROM wp_terms t
    JOIN wp_term_taxonomy tt ON t.term_id = tt.term_id AND tt.taxonomy = 'post_tag'
    ORDER BY t.term_id
  `);

  logger.info(`Found ${tags.length} tags`);

  let inserted = 0;
  for (const tag of tags) {
    const documentId = generateDocumentId(`tag:${tag.term_id}`);
    const slug = deduplicateSlug(cleanSlug(tag.slug) || tag.slug, "tags");

    try {
      const result = await pgQuery<{ id: number }>(
        `INSERT INTO "tags" ("document_id", "name", "slug", "created_at", "updated_at", "published_at", "locale")
         VALUES ($1, $2, $3, NOW(), NOW(), NOW(), $4)
         ON CONFLICT ("document_id") DO NOTHING
         RETURNING id`,
        [documentId, clean(tag.name) || tag.name, slug, null]
      );

      const entityId =
        result[0]?.id ?? (await getEntityIdByDocumentId("tags", documentId));
      if (entityId) {
        setTagMapping(tag.term_id, {
          id: entityId,
          documentId,
          type: "api::tag.tag",
          table: "tags",
        });
        inserted++;
      }
    } catch (err: any) {
      logger.error(
        `Failed to insert tag ${tag.term_id} (${tag.name}): ${err.message}`
      );
    }
  }

  logger.info(`Tags migration complete: ${inserted} inserted`);
}
