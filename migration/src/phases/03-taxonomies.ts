import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { setTermMapping } from "../utils/id-maps.js";
import { resolveMediaRef } from "../utils/media-resolver.js";
import { uploadMediaOnDemand } from "./02-media-upload.js";
import { parseFaqRepeater } from "../utils/acf-repeater.js";
import {
  loadYoastSiteConfig,
  resolveTermSeo,
} from "../utils/yoast-term-seo.js";
import {
  deduplicateSlug,
  primeSlugTracker,
  resetSlugTracker,
} from "../utils/slug-dedup.js";
import {
  generateDocumentId,
  getEntityIdByDocumentId,
  replaceComponents,
  replaceMedia,
  replaceContentMedia,
} from "../utils/strapi-insert.js";
import { clean, cleanHtml, cleanSlug } from "../utils/sanitize.js";
import { normalizeWpDate } from "../utils/wp-dates.js";
import { parseDecimal, parseInteger } from "../utils/price.js";
import { rewriteContentMedia } from "../utils/content-media.js";
import { logger } from "../utils/logger.js";
import { parseResumeFromTermFlag } from "../utils/cli.js";
import { getImportExclusions } from "../utils/import-exclusions.js";

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

/** Honest content dates for a term, derived from the posts filed under it. */
interface TermDates {
  firstPublished: string | null;
  lastModified: string | null;
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
  const resumeFlag = parseResumeFromTermFlag(process.argv.slice(2));
  if (resumeFlag.kind === "invalid") {
    throw new Error(resumeFlag.reason);
  }
  if (resumeFlag.kind === "valid" && process.argv.includes("--clean")) {
    throw new Error(
      "--resume-from-term cannot be combined with --clean because earlier terms were deleted",
    );
  }

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

  // Articles category (+descendants) and retired stores from
  // excluded-stores.csv are never imported; phases 07/08 skip their posts.
  const exclusions = await getImportExclusions();
  logger.info(
    `Import exclusions: ${exclusions.articleTermIds.size} article term(s), ` +
      `${exclusions.excludedStoreTermIds.size} listed store term(s) matched`,
  );
  if (exclusions.unmatchedStoreNames.length > 0) {
    const sample = exclusions.unmatchedStoreNames.slice(0, 10).join("; ");
    logger.warn(
      `${exclusions.unmatchedStoreNames.length} excluded-store name(s) ` +
        `matched no WordPress store term (already gone or misspelled): ` +
        `${sample}${exclusions.unmatchedStoreNames.length > 10 ? "; ..." : ""}`,
    );
  }

  resetSlugTracker();
  let termsToProcess = terms;
  let resumeIndex = 0;
  if (resumeFlag.kind === "valid") {
    resumeIndex = terms.findIndex(
      (term) => term.term_id === resumeFlag.value,
    );
    if (resumeIndex === -1) {
      throw new Error(
        `--resume-from-term ${resumeFlag.value} does not match a WordPress category term`,
      );
    }
    termsToProcess = terms.slice(resumeIndex);
    logger.warn(
      `Taxonomy resume: skipping ${resumeIndex} earlier completed term(s); ` +
        `starting with term ${resumeFlag.value}`,
    );
  }

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

  if (resumeIndex > 0) {
    primeSlugTracker(
      terms
        .slice(0, resumeIndex)
        // Excluded terms were skipped, so they never claimed a slug.
        .filter((term) => !exclusions.termIds.has(term.term_id))
        .map((term) => ({
          slug: cleanSlug(term.slug) || term.slug,
          table: TYPE_TO_TABLE[term.choose_type || "Store"] || "stores",
        })),
    );
    logger.info(
      `Taxonomy resume: primed slug history from ${resumeIndex} skipped term(s)`,
    );
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
      logger.info(
        `  Hierarchy: ${term.name} (depth ${depth}) — imported FLAT as ` +
          `"${cleanSlug(term.slug) || term.slug}" (WP slugs are verbatim)`,
      );
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

  // Term SEO comes from Yoast's real storage (wpseo_taxonomy_meta overrides +
  // wpseo_titles templates), NOT wp_termmeta — `_yoast_wpseo_*` termmeta keys
  // do not exist for terms, which is why the old lookup returned nothing and
  // every entity fell back to its bare name. Warm the cached config here.
  const yoastSite = await loadYoastSiteConfig();
  const yoastOverrideCount = Object.values(yoastSite.overrides).reduce(
    (sum, terms) => sum + Object.keys(terms).length,
    0,
  );
  logger.info(
    `Yoast term SEO loaded: ${yoastOverrideCount} per-term override(s), ` +
      `separator "${yoastSite.separator}", site name "${yoastSite.siteName}"`,
  );

  // Real content dates for the entity rows.
  //
  // WordPress terms carry NO date columns at all (wp_terms / wp_term_taxonomy),
  // so there is nothing to import directly — which is why this phase used to
  // stamp created_at/updated_at/published_at with `new Date()`. That made every
  // store/brand/category/bank claim it had changed on the day of the import,
  // and since those rows own ~99% of the public URLs, the entire sitemap's
  // <lastmod> reset to "today" on every migrate:fresh. An inaccurate lastmod is
  // strictly worse than none: Google stops trusting the field site-wide.
  //
  // The term's own posts DO have honest dates, and they are the term page's
  // content, so their range is the truthful answer.
  const termDates = await wpQuery<{
    term_id: number;
    first_published: string | null;
    last_modified: string | null;
  }>(`
    SELECT tt.term_id,
           MIN(CASE WHEN CAST(p.post_date_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_date_gmt AS CHAR) END) AS first_published,
           MAX(CASE WHEN CAST(p.post_modified_gmt AS CHAR) = '0000-00-00 00:00:00' THEN NULL ELSE CAST(p.post_modified_gmt AS CHAR) END) AS last_modified
    FROM wp_term_relationships tr
    JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id = tr.term_taxonomy_id AND tt.taxonomy = 'category'
    JOIN wp_posts p ON p.ID = tr.object_id
    WHERE p.post_type = 'post'
      AND p.post_status = 'publish'
    GROUP BY tt.term_id
  `);

  const termDatesByTermId = new Map<number, TermDates>();
  for (const row of termDates) {
    termDatesByTermId.set(row.term_id, {
      firstPublished: normalizeWpDate(row.first_published),
      lastModified: normalizeWpDate(row.last_modified),
    });
  }
  logger.info(
    `Resolved WordPress content dates for ${termDatesByTermId.size}/${terms.length} terms`,
  );

  const counts: Record<string, number> = {
    Store: 0,
    Brand: 0,
    Category: 0,
    Bank: 0,
    Articles: 0,
    ExcludedStore: 0,
    Unknown: 0,
  };

  for (const [termIndex, term] of termsToProcess.entries()) {
    // Excluded terms (Articles category tree, retired stores) never import;
    // phases 07/08 also skip every post filed under them.
    if (exclusions.articleTermIds.has(term.term_id)) {
      counts.Articles++;
      logger.info(
        `Skipping article term ${term.term_id} (${term.name}) — not a catalog entity`,
      );
      continue;
    }
    if (exclusions.excludedStoreTermIds.has(term.term_id)) {
      counts.ExcludedStore++;
      logger.info(
        `Skipping excluded store ${term.term_id} (${term.name}) — listed in excluded-stores.csv`,
      );
      continue;
    }
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
        termDatesByTermId.get(term.term_id)
      );
      const completed = termIndex + 1;
      if (completed % 100 === 0 || completed === termsToProcess.length) {
        logger.info(
          `Taxonomy progress: ${completed}/${termsToProcess.length} resumed terms`,
        );
      }
      continue;
    }

    counts[chooseType]++;
    await insertTerm(
      term,
      table,
      strapiType,
      faqMetaByTerm,
      termDatesByTermId.get(term.term_id)
    );
    const completed = termIndex + 1;
    if (completed % 100 === 0 || completed === termsToProcess.length) {
      logger.info(
        `Taxonomy progress: ${completed}/${termsToProcess.length} resumed terms`,
      );
    }
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
  termDates?: TermDates
): Promise<void> {
  const documentId = generateDocumentId(`term:${table}:${term.term_id}`);
  // WP term slugs are flat and unique per taxonomy — import them VERBATIM
  // (myntra-coupons stays myntra-coupons). No parent-chain joining: the old
  // site's URLs never carried hierarchy, so a compound slug would change
  // every nested term's URL. cleanSlug only sanitizes characters.
  const slug = deduplicateSlug(cleanSlug(term.slug) || term.slug, table);
  const faqEnabled = term.faq_enabled === "1";
  const ratingAverage = parseDecimal(term.rating_avg);
  const ratingCount = parseInteger(term.rating_count) ?? 0;

  // Build column list based on table type
  const isCategory = table === "categories";

  // Upload + rewrite images embedded in the term description so none are
  // left pointing at the old WordPress uploads URL.
  const descriptionMedia = await rewriteContentMedia(cleanHtml(term.description));

  // Alt text is REQUIRED on every entity now (categories carry `icon_alt`, the
  // rest `logo_alt`), and WordPress only sometimes supplies `image_alt` — 205
  // of the previously-migrated rows had none. Falling back to the entity's own
  // name gives an accessible baseline that matches what the site already
  // renders when the field is blank (see getMediaAlt / the directory service),
  // instead of importing a row that fails validation on first edit.
  const altColumn = isCategory ? "icon_alt" : "logo_alt";

  // Schema-json defaults never reach the database (schema sync creates plain
  // nullable columns), so every defaulted boolean this INSERT omits would land
  // NULL. show_trending_deals defaults to true — a NULL renders as OFF in the
  // admin toggle, and an editor saving without touching it would persist false
  // and silently hide the section. is_cj_enabled exists on stores only.
  const columns = [
    "document_id",
    "name",
    "slug",
    "description",
    "short_description",
    altColumn,
    "rating_average",
    "rating_count",
    "is_verified",
    "faq_enabled",
    "show_trending_deals",
    ...(table === "stores" ? ["is_cj_enabled"] : []),
    "published_at",
    "created_at",
    "updated_at",
    "locale",
  ];

  const entityName = clean(term.name) || term.name;

  // Import wall-clock is the LAST resort, used only for a term with no
  // published posts at all. Anything else would republish the whole catalogue's
  // <lastmod> as "today" on every run — see the termDates query above.
  const importedAt = new Date().toISOString();
  const createdAt = termDates?.firstPublished ?? importedAt;
  const updatedAt = termDates?.lastModified ?? createdAt;

  const values = [
    documentId,
    entityName,
    slug,
    descriptionMedia.html,
    clean(term.short_desc),
    clean(term.image_alt) || entityName,
    ratingAverage,
    ratingCount,
    table === "stores",
    faqEnabled,
    true, // show_trending_deals (schema default)
    ...(table === "stores" ? [false] : []), // is_cj_enabled (schema default)
    createdAt, // published_at
    createdAt, // created_at
    updatedAt, // updated_at
    null,
  ];

  const placeholders = values.map((_, i) => `$${i + 1}`);

  try {
    const result = await pgQuery<{ id: number }>(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(", ")})
       VALUES (${placeholders.join(", ")})
       ON CONFLICT ("document_id") DO UPDATE SET
         "name" = EXCLUDED."name",
         "slug" = EXCLUDED."slug",
         "description" = EXCLUDED."description",
         "short_description" = EXCLUDED."short_description",
         "${altColumn}" = EXCLUDED."${altColumn}",
         "rating_average" = EXCLUDED."rating_average",
         "rating_count" = EXCLUDED."rating_count",
         "faq_enabled" = EXCLUDED."faq_enabled",
         "show_trending_deals" = COALESCE("${table}"."show_trending_deals", EXCLUDED."show_trending_deals")${
           table === "stores"
             ? `,
         "is_cj_enabled" = COALESCE("stores"."is_cj_enabled", EXCLUDED."is_cj_enabled")`
             : ""
         }
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
    const field = isCategory ? "icon" : "logo";
    await replaceMedia(fileId ?? null, entityId, strapiType, field);

    await replaceContentMedia(
      descriptionMedia.fileIds,
      entityId,
      strapiType,
      "description"
    );

    // Insert FAQ components
    const termFaqMeta = faqMetaByTerm.get(term.term_id);
    const faqItems =
      termFaqMeta && faqEnabled ? parseFaqRepeater(termFaqMeta) : [];
    await replaceComponents(
      "components_shared_faq_items",
      faqItems.map((item) => ({
        question: item.question,
        answer: item.answer,
      })),
      table,
      entityId,
      "faqs",
      "shared.faq-item"
    );
    if (faqItems.length > 0) {
      logger.debug(
        `  Reconciled ${faqItems.length} FAQ items for ${term.name}`
      );
    }

    // Reconcile the imported SEO component exactly, the way Yoast renders it:
    // per-term override → taxonomy template → import fallback, with
    // %%variables%% resolved against the real separator/site name, plus
    // canonical and index/noindex.
    const plainTermDescription = clean(
      term.description?.replace(/<[^>]*>/gu, " "),
    );
    const yoastSeo = resolveTermSeo(await loadYoastSiteConfig(), {
      termId: term.term_id,
      taxonomy: "category",
      termName: entityName,
      termDescription: plainTermDescription || undefined,
    });
    // Deliberately NOT falling back to the term's content description — a
    // page-body blurb is not a meta description. Yoast → short description →
    // generic line only.
    const descriptionFallback =
      clean(term.short_desc) || `${entityName} coupons, offers and deals.`;
    const metaTitle = (clean(yoastSeo.metaTitle) || entityName).slice(0, 70);
    const metaDescription = (
      clean(yoastSeo.metaDescription) || descriptionFallback
    ).slice(0, 170);
    const seoRows = [{
      meta_title: metaTitle,
      meta_description: metaDescription,
      canonical_url: yoastSeo.canonicalUrl,
      no_index: yoastSeo.noIndex,
      og_title: yoastSeo.ogTitle,
      og_description: yoastSeo.ogDescription,
    }];
    await replaceComponents(
      "components_shared_seos",
      seoRows,
      table,
      entityId,
      "seo",
      "shared.seo"
    );
    // Per-term OG image (Yoast media-library pick) → normal media pipeline
    // (manifest-reused), linked onto the SEO component.
    if (yoastSeo.ogImageAttachmentId) {
      try {
        const ogFileId = await uploadMediaOnDemand(
          yoastSeo.ogImageAttachmentId,
        );
        const [seoLink] = await pgQuery<{ cmp_id: number }>(
          `SELECT cmp_id FROM "${table}_cmps"
           WHERE entity_id = $1 AND field = 'seo' AND component_type = 'shared.seo'
           ORDER BY "order" LIMIT 1`,
          [entityId],
        );
        if (ogFileId && seoLink) {
          await replaceMedia(ogFileId, seoLink.cmp_id, "shared.seo", "ogImage");
        }
      } catch (err: any) {
        logger.warn(
          `  OG image for ${term.name} failed: ${err?.message ?? err}`,
        );
      }
    }
  } catch (err: any) {
    logger.error(
      `Failed to insert term ${term.term_id} (${term.name}) into ${table}: ${err.message}`
    );
    throw err;
  }
}
