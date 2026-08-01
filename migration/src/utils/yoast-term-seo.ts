import { unserialize } from "php-serialize";

// Yoast term SEO, resolved the way Yoast itself renders it.
//
// WordPress term SEO does NOT live in wp_termmeta (`_yoast_wpseo_*` keys are
// for POSTS). Yoast stores:
//   1. Per-term overrides — wp_options `wpseo_taxonomy_meta`, a PHP-serialized
//      array: { [taxonomy]: { [term_id]: { wpseo_title, wpseo_desc,
//      wpseo_canonical, wpseo_noindex, ... } } }
//   2. Taxonomy templates + site settings — wp_options `wpseo_titles`:
//      `title-tax-<taxonomy>`, `metadesc-tax-<taxonomy>`,
//      `noindex-tax-<taxonomy>`, and the title `separator` code.
//   3. Site name — wp_options `blogname` (for %%sitename%%).
//
// Effective value = per-term override, else the taxonomy template, with
// %%variables%% resolved. The pure resolver below is config-free for tests;
// loadYoastTermSeoResolver() does the WP IO.

/** Yoast separator codes → rendered characters (wpseo_titles.separator). */
const SEPARATOR_BY_CODE: Record<string, string> = {
  "sc-dash": "-",
  "sc-ndash": "–",
  "sc-mdash": "—",
  "sc-middot": "·",
  "sc-bull": "•",
  "sc-star": "*",
  "sc-smstar": "⋆",
  "sc-pipe": "|",
  "sc-tilde": "~",
  "sc-laquo": "«",
  "sc-raquo": "»",
};

export interface YoastTermOverride {
  wpseo_title?: string;
  wpseo_desc?: string;
  wpseo_canonical?: string;
  /** Yoast stores "default" | "index" | "noindex". */
  wpseo_noindex?: string;
  wpseo_opengraph_title?: string;
  wpseo_opengraph_description?: string;
  wpseo_opengraph_image?: string;
  /** WP attachment id of the OG image, when picked from the media library. */
  wpseo_opengraph_image_id?: number;
}

export interface YoastSiteConfig {
  separator: string;
  siteName: string;
  /** Templates per taxonomy: title / metadesc / noindex default. */
  templates: Record<
    string,
    { title?: string; metadesc?: string; noindex?: boolean }
  >;
  /** Templates per post kind ("page", "post", "home-wpseo", ...). */
  postTemplates: Record<
    string,
    { title?: string; metadesc?: string; noindex?: boolean }
  >;
  /** Per-term overrides per taxonomy. */
  overrides: Record<string, Record<number, YoastTermOverride>>;
}

export interface ResolvedTermSeo {
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  noIndex: boolean;
  ogTitle: string | null;
  ogDescription: string | null;
  /** WP attachment id for the OG image (preferred — importable as media). */
  ogImageAttachmentId: number | null;
  /** Raw OG image URL when no attachment id exists. */
  ogImageUrl: string | null;
}

export interface TermSeoInput {
  termId: number;
  taxonomy: string;
  /** The entity name (%%term_title%% / %%title%%). */
  termName: string;
  /** Plain-text term description (%%term_description%% / %%excerpt%%). */
  termDescription?: string;
}

/** Resolve Yoast %%variables%% against a term, with the REAL separator. */
export function resolveYoastTemplate(
  template: string | null | undefined,
  input: { termName: string; termDescription?: string },
  site: { separator: string; siteName: string },
): string {
  if (!template) return "";
  const description = (input.termDescription ?? "").trim();
  return template
    .replace(/%%term_title%%/gi, input.termName)
    .replace(/%%title%%/gi, input.termName)
    .replace(/%%term_description%%/gi, description)
    .replace(/%%category_description%%/gi, description)
    .replace(/%%excerpt%%/gi, description)
    .replace(/%%sep%%/gi, site.separator)
    .replace(/%%sitename%%/gi, site.siteName)
    .replace(/%%sitedesc%%/gi, "")
    .replace(/%%currentyear%%/gi, String(new Date().getFullYear()))
    .replace(/%%currentmonth%%/gi, "")
    .replace(/%%currentdate%%/gi, "")
    .replace(/%%year%%/gi, String(new Date().getFullYear()))
    .replace(/%%page%%/gi, "")
    .replace(/%%pagenumber%%/gi, "")
    .replace(/%%pagetotal%%/gi, "")
    .replace(/%%primary_category%%/gi, "")
    .replace(/%%category%%/gi, "")
    .replace(/%%tag%%/gi, "")
    .replace(/%%date%%/gi, "")
    .replace(/%%cf_\w+%%/gi, "")
    .replace(/%%\w+%%/g, "") // any remaining variable
    .replace(/\s{2,}/g, " ")
    // A dangling separator survives when a trailing variable resolved empty.
    .replace(/[\s]*[-–—·•*⋆|~«»][\s]*$/u, "")
    .trim();
}

/** Effective SEO for one term: override wins, template fills, vars resolved. */
export function resolveTermSeo(
  site: YoastSiteConfig,
  input: TermSeoInput,
): ResolvedTermSeo {
  const override = site.overrides[input.taxonomy]?.[input.termId];
  const template = site.templates[input.taxonomy] ?? {};

  const titleSource = override?.wpseo_title?.trim() || template.title || null;
  const descSource = override?.wpseo_desc?.trim() || template.metadesc || null;

  const metaTitle = resolveYoastTemplate(titleSource, input, site) || null;
  const metaDescription = resolveYoastTemplate(descSource, input, site) || null;

  const canonicalUrl = override?.wpseo_canonical?.trim() || null;

  // Per-term: "noindex" forces on, "index" forces off, "default"/absent
  // falls to the taxonomy-wide setting.
  const perTerm = (override?.wpseo_noindex ?? "default").trim().toLowerCase();
  const noIndex =
    perTerm === "noindex"
      ? true
      : perTerm === "index"
        ? false
        : Boolean(template.noindex);

  // OG has no taxonomy templates in Yoast — per-term values only.
  const ogTitle =
    resolveYoastTemplate(override?.wpseo_opengraph_title, input, site) || null;
  const ogDescription =
    resolveYoastTemplate(override?.wpseo_opengraph_description, input, site) ||
    null;

  return {
    metaTitle,
    metaDescription,
    canonicalUrl,
    noIndex,
    ogTitle,
    ogDescription,
    ogImageAttachmentId: override?.wpseo_opengraph_image_id ?? null,
    ogImageUrl: override?.wpseo_opengraph_image?.trim() || null,
  };
}

function safeUnserialize(raw: string | undefined | null): any {
  if (!raw) return null;
  try {
    return unserialize(raw);
  } catch {
    return null;
  }
}

/** Parse the two Yoast options + blogname into a YoastSiteConfig. */
export function parseYoastSiteConfig(options: {
  wpseoTitles: string | null;
  wpseoTaxonomyMeta: string | null;
  blogname: string | null;
}): YoastSiteConfig {
  const titles = safeUnserialize(options.wpseoTitles) ?? {};
  const taxonomyMeta = safeUnserialize(options.wpseoTaxonomyMeta) ?? {};

  const separator =
    SEPARATOR_BY_CODE[String(titles.separator ?? "")] ?? "-";
  const siteName = options.blogname?.trim() || "CouponzGuru";

  const templates: YoastSiteConfig["templates"] = {};
  const postTemplates: YoastSiteConfig["postTemplates"] = {};
  for (const [key, value] of Object.entries(titles)) {
    const titleMatch = /^title-tax-(.+)$/.exec(key);
    if (titleMatch && typeof value === "string") {
      (templates[titleMatch[1]] ??= {}).title = value;
      continue;
    }
    const descMatch = /^metadesc-tax-(.+)$/.exec(key);
    if (descMatch && typeof value === "string") {
      (templates[descMatch[1]] ??= {}).metadesc = value;
      continue;
    }
    const noindexMatch = /^noindex-tax-(.+)$/.exec(key);
    if (noindexMatch) {
      (templates[noindexMatch[1]] ??= {}).noindex =
        value === true || value === "1" || value === 1;
      continue;
    }
    // Post-kind templates: title-page, metadesc-page, title-home-wpseo, ...
    const postTitle = /^title-(.+)$/.exec(key);
    if (postTitle && typeof value === "string") {
      (postTemplates[postTitle[1]] ??= {}).title = value;
      continue;
    }
    const postDesc = /^metadesc-(.+)$/.exec(key);
    if (postDesc && typeof value === "string") {
      (postTemplates[postDesc[1]] ??= {}).metadesc = value;
      continue;
    }
    const postNoindex = /^noindex-(.+)$/.exec(key);
    if (postNoindex) {
      (postTemplates[postNoindex[1]] ??= {}).noindex =
        value === true || value === "1" || value === 1;
    }
  }

  const overrides: YoastSiteConfig["overrides"] = {};
  if (taxonomyMeta && typeof taxonomyMeta === "object") {
    for (const [taxonomy, terms] of Object.entries(taxonomyMeta)) {
      if (!terms || typeof terms !== "object") continue;
      const byTerm: Record<number, YoastTermOverride> = {};
      for (const [termId, fields] of Object.entries(
        terms as Record<string, any>,
      )) {
        const id = parseInt(termId, 10);
        if (!Number.isFinite(id) || !fields || typeof fields !== "object") {
          continue;
        }
        const str = (v: unknown): string | undefined =>
          typeof v === "string" && v.trim() !== "" ? v : undefined;
        const imageId = parseInt(
          String(fields["wpseo_opengraph-image-id"] ?? ""),
          10,
        );
        byTerm[id] = {
          wpseo_title: str(fields.wpseo_title),
          wpseo_desc: str(fields.wpseo_desc),
          wpseo_canonical: str(fields.wpseo_canonical),
          wpseo_noindex: str(fields.wpseo_noindex),
          wpseo_opengraph_title: str(fields["wpseo_opengraph-title"]),
          wpseo_opengraph_description: str(
            fields["wpseo_opengraph-description"],
          ),
          wpseo_opengraph_image: str(fields["wpseo_opengraph-image"]),
          wpseo_opengraph_image_id: Number.isFinite(imageId)
            ? imageId
            : undefined,
        };
      }
      overrides[taxonomy] = byTerm;
    }
  }

  return { separator, siteName, templates, postTemplates, overrides };
}

// ── Posts & pages (static pages, homepage, deal-of-the-day) ────────────────
// Unlike terms, PAGE/POST SEO does live in wp_postmeta (`_yoast_wpseo_*`).

export interface YoastPostOverride {
  title?: string;
  metadesc?: string;
  canonical?: string;
  /** "_yoast_wpseo_meta-robots-noindex" — "1" means noindex. */
  noindex?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogImageId?: number;
}

const POST_META_KEYS: Record<string, keyof YoastPostOverride> = {
  "_yoast_wpseo_title": "title",
  "_yoast_wpseo_metadesc": "metadesc",
  "_yoast_wpseo_canonical": "canonical",
  "_yoast_wpseo_meta-robots-noindex": "noindex",
  "_yoast_wpseo_opengraph-title": "ogTitle",
  "_yoast_wpseo_opengraph-description": "ogDescription",
  "_yoast_wpseo_opengraph-image": "ogImage",
  "_yoast_wpseo_opengraph-image-id": "ogImageId",
};

export function parsePostOverrideRows(
  rows: Array<{ post_id: number; meta_key: string; meta_value: string }>,
): Map<number, YoastPostOverride> {
  const byPost = new Map<number, YoastPostOverride>();
  for (const row of rows) {
    const field = POST_META_KEYS[row.meta_key];
    if (!field || !row.meta_value?.trim()) continue;
    const entry = byPost.get(row.post_id) ?? {};
    if (field === "ogImageId") {
      const id = parseInt(row.meta_value, 10);
      if (Number.isFinite(id)) entry.ogImageId = id;
    } else {
      entry[field] = row.meta_value;
    }
    byPost.set(row.post_id, entry);
  }
  return byPost;
}

/**
 * Effective SEO for a page/post (or the blog homepage): per-post override →
 * post-kind template ("page", or "home-wpseo" for the homepage), resolved.
 */
export function resolvePageSeo(
  site: YoastSiteConfig,
  input: {
    /** "page" for static pages; "home-wpseo" for the blog-homepage settings. */
    kind: string;
    pageName: string;
    override?: YoastPostOverride;
  },
): ResolvedTermSeo {
  const template = site.postTemplates[input.kind] ?? {};
  const vars = { termName: input.pageName };

  const titleSource = input.override?.title?.trim() || template.title || null;
  const descSource =
    input.override?.metadesc?.trim() || template.metadesc || null;

  return {
    metaTitle: resolveYoastTemplate(titleSource, vars, site) || null,
    metaDescription: resolveYoastTemplate(descSource, vars, site) || null,
    canonicalUrl: input.override?.canonical?.trim() || null,
    noIndex:
      input.override?.noindex === "1" ? true : Boolean(template.noindex),
    ogTitle:
      resolveYoastTemplate(input.override?.ogTitle, vars, site) || null,
    ogDescription:
      resolveYoastTemplate(input.override?.ogDescription, vars, site) || null,
    ogImageAttachmentId: input.override?.ogImageId ?? null,
    ogImageUrl: input.override?.ogImage?.trim() || null,
  };
}

/** Load per-post Yoast overrides for a set of WP post ids. */
export async function loadYoastPostOverrides(
  postIds: readonly number[],
): Promise<Map<number, YoastPostOverride>> {
  if (postIds.length === 0) return new Map();
  const { wpQuery } = await import("../db/wp-client.js");
  const placeholders = postIds.map(() => "?").join(",");
  const rows = await wpQuery<{
    post_id: number;
    meta_key: string;
    meta_value: string;
  }>(
    `SELECT post_id, meta_key, meta_value
     FROM wp_postmeta
     WHERE post_id IN (${placeholders})
       AND meta_key IN (${Object.keys(POST_META_KEYS)
         .map(() => "?")
         .join(",")})`,
    [...postIds, ...Object.keys(POST_META_KEYS)],
  );
  return parsePostOverrideRows(rows);
}

let siteConfigPromise: Promise<YoastSiteConfig> | null = null;

/** Load + cache the Yoast site config from WordPress (lazy wp-client import). */
export function loadYoastSiteConfig(): Promise<YoastSiteConfig> {
  if (siteConfigPromise) return siteConfigPromise;
  siteConfigPromise = (async () => {
    const { wpQuery } = await import("../db/wp-client.js");
    const rows = await wpQuery<{ option_name: string; option_value: string }>(`
      SELECT option_name, option_value
      FROM wp_options
      WHERE option_name IN ('wpseo_titles', 'wpseo_taxonomy_meta', 'blogname')
    `);
    const byName = new Map(rows.map((row) => [row.option_name, row.option_value]));
    return parseYoastSiteConfig({
      wpseoTitles: byName.get("wpseo_titles") ?? null,
      wpseoTaxonomyMeta: byName.get("wpseo_taxonomy_meta") ?? null,
      blogname: byName.get("blogname") ?? null,
    });
  })();
  return siteConfigPromise;
}
