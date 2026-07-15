import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { setTermMapping } from "../utils/id-maps.js";
import { resolveMediaRef } from "../utils/media-resolver.js";
import { parseFaqRepeater } from "../utils/acf-repeater.js";
import { resolveYoastVariables } from "../utils/yoast-vars.js";
import { deduplicateSlug } from "../utils/slug-dedup.js";
import {
  generateDocumentId,
  getEntityIdByDocumentId,
  insertComponent,
  linkMedia,
  linkContentMedia,
} from "../utils/strapi-insert.js";
import { clean, cleanHtml, cleanSlug } from "../utils/sanitize.js";
import { parseDecimal, parseInteger } from "../utils/price.js";
import { rewriteContentMedia } from "../utils/content-media.js";
import { logger } from "../utils/logger.js";

interface WpTerm {
  term_id: number;
  name: string;
  slug: string;
  parent: number;
  description: string;
  count: number;
  choose_type: string | null;
  short_desc: string | null;
  image_ref: string | null;
  image_alt: string | null;
  faq_enabled: string | null;
  rating_avg: string | null;
  rating_count: string | null;
}

const TYPE_TO_TABLE: Record<string, string> = {
  Store: "stores",
  Brand: "brands",
  Category: "categories",
  Bank: "banks",
};

const TYPE_TO_STRAPI_TYPE: Record<string, string> = {
  Store: "api::store.store",
  Brand: "api::brand.brand",
  Category: "api::category.category",
  Bank: "api::bank.bank",
};

export async function runTaxonomies(): Promise<void> {
  logger.info("=== Phase 3: Taxonomy Migration ===");

  // Get all category terms with their metadata
  const terms = await wpQuery<WpTerm>(`
    SELECT
      t.term_id,
      t.name,
      t.slug,
      tt.parent,
      tt.description,
      tt.count,
      MAX(CASE WHEN tm.meta_key='choose_type' THEN tm.meta_value END) AS choose_type,
      MAX(CASE WHEN tm.meta_key='store_short_description' THEN tm.meta_value END) AS short_desc,
      MAX(CASE WHEN tm.meta_key='store_cat_image' THEN tm.meta_value END) AS image_ref,
      MAX(CASE WHEN tm.meta_key='store_image_alt' THEN tm.meta_value END) AS image_alt,
      MAX(CASE WHEN tm.meta_key='enable_faq_schema' THEN tm.meta_value END) AS faq_enabled,
      MAX(CASE WHEN pm.meta_key='_kksr_avg' THEN pm.meta_value END) AS rating_avg,
      MAX(CASE WHEN pm.meta_key='_kksr_casts' THEN pm.meta_value END) AS rating_count
    FROM wp_terms t
    JOIN wp_term_taxonomy tt ON t.term_id = tt.term_id AND tt.taxonomy = 'category'
    LEFT JOIN wp_termmeta tm ON t.term_id = tm.term_id
      AND tm.meta_key IN ('choose_type','store_short_description','store_cat_image','store_image_alt','enable_faq_schema')
    LEFT JOIN wp_postmeta pm ON t.term_id = pm.post_id
      AND pm.meta_key IN ('_kksr_avg','_kksr_casts')
    GROUP BY t.term_id, t.name, t.slug, tt.parent, tt.description, tt.count
    ORDER BY t.term_id
  `);

  logger.info(`Found ${terms.length} category terms`);

  // Build a slug lookup map: term_id → slug (for parent chain resolution)
  const slugByTermId = new Map<number, string>();
  const parentByTermId = new Map<number, number>();
  for (const term of terms) {
    slugByTermId.set(term.term_id, cleanSlug(term.slug) || term.slug);
    if (term.parent && term.parent !== 0) {
      parentByTermId.set(term.term_id, term.parent);
    }
  }

  // Build full hierarchical slug: walks up parent chain → "grandparent-parent-child"
  function buildFullSlug(termId: number): string {
    const parts: string[] = [];
    let current: number | undefined = termId;
    const visited = new Set<number>();
    while (current && !visited.has(current)) {
      visited.add(current);
      const s = slugByTermId.get(current);
      if (s) parts.unshift(s);
      current = parentByTermId.get(current);
    }
    return parts.join("/");
  }

  // Log hierarchy depth info
  let maxDepth = 0;
  for (const term of terms) {
    let depth = 0;
    let current: number | undefined = term.term_id;
    const visited = new Set<number>();
    while (current && !visited.has(current)) {
      visited.add(current);
      depth++;
      current = parentByTermId.get(current);
    }
    if (depth > maxDepth) maxDepth = depth;
    if (depth > 1) {
      logger.info(`  Hierarchy: ${term.name} (depth ${depth}) → slug: ${buildFullSlug(term.term_id)}`);
    }
  }
  logger.info(`Max taxonomy depth: ${maxDepth}`);

  // Get all FAQ meta rows upfront
  const faqMeta = await wpQuery<{
    term_id: number;
    meta_key: string;
    meta_value: string;
  }>(`
    SELECT term_id, meta_key, meta_value
    FROM wp_termmeta
    WHERE meta_key LIKE 'faq_items%'
    ORDER BY term_id, meta_key
  `);

  // Group FAQ meta by term_id
  const faqMetaByTerm = new Map<
    number,
    Array<{ meta_key: string; meta_value: string }>
  >();
  for (const row of faqMeta) {
    if (!faqMetaByTerm.has(row.term_id)) {
      faqMetaByTerm.set(row.term_id, []);
    }
    faqMetaByTerm.get(row.term_id)!.push({
      meta_key: row.meta_key,
      meta_value: row.meta_value,
    });
  }

  // Get Yoast SEO data for terms
  const yoastTermData = await wpQuery<{
    term_id: number;
    meta_key: string;
    meta_value: string;
  }>(`
    SELECT term_id, meta_key, meta_value
    FROM wp_termmeta
    WHERE meta_key IN ('_yoast_wpseo_title', '_yoast_wpseo_metadesc')
    ORDER BY term_id
  `);

  const yoastByTerm = new Map<
    number,
    { title?: string; description?: string }
  >();
  for (const row of yoastTermData) {
    if (!yoastByTerm.has(row.term_id)) {
      yoastByTerm.set(row.term_id, {});
    }
    const entry = yoastByTerm.get(row.term_id)!;
    if (row.meta_key === "_yoast_wpseo_title") {
      entry.title = row.meta_value;
    } else if (row.meta_key === "_yoast_wpseo_metadesc") {
      entry.description = row.meta_value;
    }
  }

  const counts: Record<string, number> = {
    Store: 0,
    Brand: 0,
    Category: 0,
    Bank: 0,
    Unknown: 0,
  };

  for (const term of terms) {
    const chooseType = term.choose_type || "Store"; // Default to Store if missing
    const table = TYPE_TO_TABLE[chooseType];
    const strapiType = TYPE_TO_STRAPI_TYPE[chooseType];

    if (!table) {
      logger.warn(
        `Unknown choose_type '${chooseType}' for term ${term.term_id} (${term.name}). Defaulting to Store.`
      );
      counts.Unknown++;
      // Default to stores
      await insertTerm(
        term,
        "stores",
        "api::store.store",
        faqMetaByTerm,
        yoastByTerm,
        buildFullSlug
      );
      continue;
    }

    counts[chooseType]++;
    await insertTerm(term, table, strapiType, faqMetaByTerm, yoastByTerm, buildFullSlug);
  }

  logger.info(`Taxonomy migration complete:`);
  for (const [type, count] of Object.entries(counts)) {
    if (count > 0) logger.info(`  ${type}: ${count}`);
  }
}

async function insertTerm(
  term: WpTerm,
  table: string,
  strapiType: string,
  faqMetaByTerm: Map<number, Array<{ meta_key: string; meta_value: string }>>,
  yoastByTerm: Map<number, { title?: string; description?: string }>,
  buildFullSlug: (termId: number) => string
): Promise<void> {
  const documentId = generateDocumentId(`term:${table}:${term.term_id}`);
  const slug = deduplicateSlug(buildFullSlug(term.term_id), table);
  const faqEnabled = term.faq_enabled === "1";
  const ratingAverage = parseDecimal(term.rating_avg);
  const ratingCount = parseInteger(term.rating_count) ?? 0;

  // Build column list based on table type
  const isCategory = table === "categories";

  // Upload + rewrite images embedded in the term description so none are
  // left pointing at the old WordPress uploads URL.
  const descriptionMedia = await rewriteContentMedia(cleanHtml(term.description));

  const columns = [
    "document_id",
    "name",
    "slug",
    "description",
    "short_description",
    ...(isCategory ? [] : ["logo_alt"]),
    "rating_average",
    "rating_count",
    "is_verified",
    "faq_enabled",
    "published_at",
    "created_at",
    "updated_at",
    "locale",
  ];

  const values = [
    documentId,
    clean(term.name) || term.name,
    slug,
    descriptionMedia.html,
    clean(term.short_desc),
    ...(isCategory ? [] : [clean(term.image_alt)]),
    ratingAverage,
    ratingCount,
    table === "stores",
    faqEnabled,
    new Date().toISOString(),
    new Date().toISOString(),
    new Date().toISOString(),
    null,
  ];

  const placeholders = values.map((_, i) => `$${i + 1}`);

  try {
    const result = await pgQuery<{ id: number }>(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
       VALUES (${placeholders.join(", ")})
       ON CONFLICT ("document_id") DO UPDATE SET
         "description" = EXCLUDED."description"
       RETURNING id`,
      values
    );

    const entityId =
      result[0]?.id ?? (await getEntityIdByDocumentId(table, documentId));
    if (!entityId) {
      logger.warn(`Could not resolve entity id for term ${term.term_id} (${term.name}) in ${table}`);
      return;
    }

    // Store mapping
    setTermMapping(term.term_id, {
      id: entityId,
      documentId,
      type: strapiType,
      table,
    });

    // Link media (logo/icon)
    const fileId = await resolveMediaRef(term.image_ref);
    if (fileId) {
      const field = isCategory ? "icon" : "logo";
      await linkMedia(fileId, entityId, strapiType, field);
    }

    await linkContentMedia(
      descriptionMedia.fileIds,
      entityId,
      strapiType,
      "description"
    );

    // Insert FAQ components
    const termFaqMeta = faqMetaByTerm.get(term.term_id);
    if (termFaqMeta && faqEnabled) {
      const faqItems = parseFaqRepeater(termFaqMeta);
      for (let i = 0; i < faqItems.length; i++) {
        await insertComponent(
          "components_shared_faq_items",
          { question: faqItems[i].question, answer: faqItems[i].answer },
          table,
          entityId,
          "faqs",
          "shared.faq-item",
          i + 1
        );
      }
      if (faqItems.length > 0) {
        logger.debug(
          `  Inserted ${faqItems.length} FAQ items for ${term.name}`
        );
      }
    }

    // Insert SEO component
    const yoast = yoastByTerm.get(term.term_id);
    if (yoast && (yoast.title || yoast.description)) {
      const metaTitle = clean(resolveYoastVariables(yoast.title || null, term.name));
      const metaDescription = clean(yoast.description || null);

      if (metaTitle || metaDescription) {
        await insertComponent(
          "components_shared_seos",
          {
            meta_title: metaTitle || null,
            meta_description: metaDescription,
            canonical_url: null,
          },
          table,
          entityId,
          "seo",
          "shared.seo"
        );
      }
    }
  } catch (err: any) {
    logger.error(
      `Failed to insert term ${term.term_id} (${term.name}) into ${table}: ${err.message}`
    );
  }
}
