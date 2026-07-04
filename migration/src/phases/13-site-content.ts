import { unserialize } from "php-serialize";
import { wpQuery } from "../db/wp-client.js";
import { pgQuery, pgTransaction } from "../db/pg-client.js";
import { ensureTermMapping } from "../utils/id-maps.js";
import { resolveMediaRef } from "../utils/media-resolver.js";
import {
  generateDocumentId,
  insertLink,
  linkMedia,
} from "../utils/strapi-insert.js";
import { clean } from "../utils/sanitize.js";
import { logger } from "../utils/logger.js";

/**
 * Phase 13 — Site Content
 *
 * Seeds the four Strapi single types the frontend needs:
 *   - global   (header/footer codes + Amazon banner from WP ACF options)
 *   - homepage (draft + published pair, curated sections from migrated data)
 *   - menu     (top stores, category sections, extra items)
 *   - footer   (frontend copy mirrored from cguru-ui footer-data.ts)
 *
 * All component/link table names are verified against information_schema
 * before writing; missing tables (Strapi schema not migrated yet) are
 * skipped gracefully with a clear log line. Each single type is seeded
 * inside one transaction and skipped entirely when its table already has
 * a row, so re-runs are safe and a crash never leaves a half-built tree.
 */

// ─────────────────────────────────────────────────────────────────────
// Frontend copy (mirrored from cguru-ui)
// ─────────────────────────────────────────────────────────────────────

// From cguru-ui/src/features/home/how-it-works/how-it-works-data.ts
const HOW_IT_WORKS_STEPS: ReadonlyArray<{
  kind: string;
  title: string;
  description: string;
}> = [
  {
    kind: "store",
    title: "Find a Store",
    description:
      "Browse through 1000+ stores and find the one you want to shop from",
  },
  {
    kind: "copy",
    title: "Click and Copy Code",
    description:
      "Select the best coupon or deal and copy the code with one click",
  },
  {
    kind: "payments",
    title: "Save Money at Merchant Site",
    description:
      "Apply the code at checkout and enjoy instant savings on your purchase",
  },
];

const WHY_FEATURES: ReadonlyArray<{ kind: string; label: string }> = [
  { kind: "verified", label: "Verified Coupons" },
  { kind: "update", label: "Updated Hourly" },
  { kind: "store", label: "1000+ Stores" },
  { kind: "block", label: "No Fake Coupons" },
];

// From cguru-ui/src/features/home/faq/faq-data.ts
// (answers there are string arrays — joined with "\n\n")
const FAQ_ITEMS: ReadonlyArray<{ question: string; answer: string }> = [
  {
    question: "Save More Every Time You Shop Only at CouponzGuru",
    answer:
      "Shopping online in India has never been more exciting but it gets even better when you save money on every purchase. CouponzGuru is India's one stop free shop for the latest, working and genuine coupon codes, promo deals and discount offers. Whether you are buying fashion, electronics, booking flights or ordering food CouponzGuru makes sure you never pay full price. Since 2011, CouponzGuru has been helping millions of online shoppers across India get the best deals at one place." +
      "\n\n" +
      "Our team of highly skilled coupons and deals hunters are on the job 24 x 7, hunting for the latest money saving coupons and deals from top online shopping sites in India. So now, no need to visit every website daily and hunt for discounts — just check out CouponzGuru and you will get the latest deals here.",
  },
  { question: "About CouponzGuru.com", answer: "" },
  { question: "What we do?", answer: "" },
  { question: "How we use coupon codes?", answer: "" },
  { question: "What kind of coupons are available?", answer: "" },
];

// From cguru-ui/src/components/footer/footer-data.ts
interface FooterLinkDef {
  label: string;
  href: string;
  bold?: boolean;
  /** Try to resolve this label to a real store (Popular Stores section). */
  store?: boolean;
}

const FOOTER_SECTIONS: ReadonlyArray<{
  title: string;
  links: FooterLinkDef[];
}> = [
  {
    title: "Company",
    links: [
      { label: "About Us", href: "#" },
      { label: "How CouponzGuru Works", href: "#" },
      { label: "Careers", href: "#" },
      { label: "Blog", href: "#" },
      { label: "FAQs", href: "#" },
      { label: "Life at CouponzGuru", href: "#" },
      { label: "Contact Us", href: "#", bold: true },
    ],
  },
  {
    title: "Popular Stores",
    links: [
      { label: "Amazon", href: "#", store: true },
      { label: "Lenovo", href: "#", store: true },
      { label: "Titan", href: "#", store: true },
      { label: "Flipkart", href: "#", store: true },
      { label: "Myntra", href: "#", store: true },
      { label: "Makemytrip", href: "#", store: true },
      { label: "View All Stores", href: "/stores/", bold: true },
    ],
  },
  {
    title: "Festival & Sale Events",
    links: [
      { label: "Republic Day Sale", href: "#" },
      { label: "Eid Sale", href: "#" },
      { label: "Independent Day Sale", href: "#" },
      { label: "Diwali Sale", href: "#" },
      { label: "Flipkart Day Sale", href: "#" },
      { label: "Amazon Great Indian Festival", href: "#" },
    ],
  },
  {
    title: "Legal & Utilities",
    links: [
      { label: "Privacy Policy", href: "#" },
      { label: "Terms of Use", href: "#" },
      { label: "Affiliate Disclosure", href: "#" },
      { label: "Sitemap", href: "/sitemap.xml" },
    ],
  },
];

const SOCIAL_PLATFORMS: ReadonlyArray<string> = [
  "facebook",
  "instagram",
  "pinterest",
  "linkedin",
  "telegram",
  "reddit",
  "twitter",
  "whatsapp",
  "youtube",
];

const FOOTER_COUNTRIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: "us", name: "USA" },
  { code: "sg", name: "Singapore" },
  { code: "ph", name: "Philippines" },
  { code: "ae", name: "UAE" },
  { code: "my", name: "Malaysia" },
];

const PARTNER_CARD = {
  title: "Partner With Us",
  description:
    "Join our merchant network to increase your brand reach, drive high-intent traffic, and boost your sales effortlessly.",
  ctaLabel: "Become a Partner",
  ctaUrl: "#",
};

const FOOTER_BADGE = "Verified Coupons, Updated Daily, Free to Use";
const FOOTER_COPYRIGHT =
  "© 2011-2026 Vihaan Web Solutions Pvt Ltd. All Rights Reserved.";

const EXPLORE_SLUG_PATTERNS = [
  "electronics",
  "fashion",
  "travel",
  "food",
  "laptop",
  "home",
];

const MENU_EXTRA_ITEMS: ReadonlyArray<{
  label: string;
  url: string;
  featured?: boolean;
}> = [
  { label: "CG Exclusive", url: "/cg-exclusive/" },
  { label: "Blog", url: "/blog/" },
  { label: "Today's Deals", url: "/todays-deals/" },
  { label: "End of the Months Sale", url: "/sale/end-of-month/", featured: true },
];

// ─────────────────────────────────────────────────────────────────────
// Schema detection helpers (information_schema)
// ─────────────────────────────────────────────────────────────────────

let existingTables: Set<string> = new Set();
const columnCache = new Map<string, string[]>();

async function loadExistingTables(): Promise<void> {
  const rows = await pgQuery<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`
  );
  existingTables = new Set(rows.map((r) => r.table_name));
}

function hasTable(name: string): boolean {
  return existingTables.has(name);
}

/** Returns names in `names` missing from the schema (empty array = all good). */
function missingTables(...names: string[]): string[] {
  return names.filter((n) => !hasTable(n));
}

async function getColumns(table: string): Promise<string[]> {
  const cached = columnCache.get(table);
  if (cached) return cached;
  const rows = await pgQuery<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  const cols = rows.map((r) => r.column_name);
  columnCache.set(table, cols);
  return cols;
}

async function hasColumn(table: string, column: string): Promise<boolean> {
  return (await getColumns(table)).includes(column);
}

interface Lnk {
  table: string;
  sourceCol: string;
  targetCol: string;
  ordCols: string[];
}

/**
 * Detects a Strapi v5 relation link table for `<baseTable>.<attr>` targeting
 * `<targetSingular>`. Tries the conventional `<baseTable>_<attr>_lnk` name
 * first, then falls back to a suffix scan (Strapi shortens very long names).
 * Column names are read from information_schema, never assumed.
 */
async function detectLnk(
  baseTable: string,
  attrSnake: string,
  targetSingular: string
): Promise<Lnk | null> {
  const conventional = `${baseTable}_${attrSnake}_lnk`;
  let table: string | undefined;

  if (hasTable(conventional)) {
    table = conventional;
  } else {
    // Fallback: any table ending with the attribute + _lnk that shares a
    // prefix with the base table (handles Strapi identifier shortening).
    const suffix = `_${attrSnake}_lnk`;
    const candidates = Array.from(existingTables).filter(
      (t) =>
        t.endsWith(suffix) &&
        t.startsWith(baseTable.slice(0, Math.min(baseTable.length, 20)))
    );
    table = candidates[0];
    if (candidates.length > 1) {
      logger.warn(
        `Link table for ${baseTable}.${attrSnake}: ${candidates.length} candidates match (${candidates.join(", ")}) — using ${table}; verify this is correct`
      );
    } else if (table) {
      logger.info(
        `Link table for ${baseTable}.${attrSnake}: detected ${table} (conventional name ${conventional} not found)`
      );
    }
  }

  if (!table) return null;

  const cols = await getColumns(table);
  const idCols = cols.filter((c) => c.endsWith("_id"));
  const targetCol =
    idCols.find((c) => c === `${targetSingular}_id`) ??
    idCols.find((c) => c.includes(targetSingular));
  const sourceCol = idCols.find((c) => c !== targetCol);
  const ordCols = cols.filter((c) => c.endsWith("_ord") || c === "order");

  if (!targetCol || !sourceCol) {
    logger.warn(
      `Link table ${table} exists but expected columns not found (have: ${cols.join(", ")})`
    );
    return null;
  }

  return { table, sourceCol, targetCol, ordCols };
}

async function linkRel(
  lnk: Lnk,
  sourceId: number,
  targetId: number,
  ord: number = 1
): Promise<void> {
  const row: Record<string, number> = {
    [lnk.sourceCol]: sourceId,
    [lnk.targetCol]: targetId,
  };
  for (const c of lnk.ordCols) row[c] = ord;
  await insertLink(lnk.table, row);
}

// ─────────────────────────────────────────────────────────────────────
// Insert helpers
// ─────────────────────────────────────────────────────────────────────

async function insertRow(
  table: string,
  data: Record<string, any>
): Promise<number> {
  const cols = Object.keys(data);
  if (cols.length === 0) {
    const rows = await pgQuery<{ id: number }>(
      `INSERT INTO "${table}" DEFAULT VALUES RETURNING id`
    );
    return rows[0].id;
  }
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const rows = await pgQuery<{ id: number }>(
    `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")})
     VALUES (${placeholders.join(", ")})
     RETURNING id`,
    cols.map((c) => data[c] ?? null)
  );
  return rows[0].id;
}

/** Attach a component row to a parent (entity or parent component) cmps table. */
async function addCmp(
  cmpsTable: string,
  entityId: number,
  cmpId: number,
  componentType: string,
  field: string,
  order: number
): Promise<void> {
  await pgQuery(
    `INSERT INTO "${cmpsTable}" ("entity_id", "cmp_id", "component_type", "field", "order")
     VALUES ($1, $2, $3, $4, $5)`,
    [entityId, cmpId, componentType, field, order]
  );
}

async function singleTypeHasRow(table: string): Promise<boolean> {
  const rows = await pgQuery<{ id: number }>(
    `SELECT id FROM "${table}" LIMIT 1`
  );
  return rows.length > 0;
}

// ─────────────────────────────────────────────────────────────────────
// WP options helpers
// ─────────────────────────────────────────────────────────────────────

async function fetchOptionsLike(
  pattern: string
): Promise<Map<string, string>> {
  const rows = await wpQuery<{ option_name: string; option_value: string }>(
    `SELECT option_name, option_value FROM wp_options WHERE option_name LIKE ?`,
    [pattern]
  );
  return new Map(rows.map((r) => [r.option_name, r.option_value]));
}

async function fetchOptionsIn(names: string[]): Promise<Map<string, string>> {
  const placeholders = names.map(() => "?").join(",");
  const rows = await wpQuery<{ option_name: string; option_value: string }>(
    `SELECT option_name, option_value FROM wp_options WHERE option_name IN (${placeholders})`,
    names
  );
  return new Map(rows.map((r) => [r.option_name, r.option_value]));
}

/** Parses a plain or PHP-serialized value into a list of numeric IDs. */
function parseIdList(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (/^\d+$/.test(trimmed)) return [parseInt(trimmed, 10)];
  if (/^[asiO]:/.test(trimmed)) {
    try {
      const parsed = unserialize(trimmed);
      const values = Array.isArray(parsed)
        ? parsed
        : parsed !== null && typeof parsed === "object"
          ? Object.values(parsed)
          : [parsed];
      return values
        .map((v: any) => parseInt(String(v), 10))
        .filter((n: number) => !isNaN(n) && n > 0);
    } catch {
      return [];
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────
// Phase entry point
// ─────────────────────────────────────────────────────────────────────

export async function runSiteContent(): Promise<void> {
  logger.info("=== Phase 13: Site Content (single types) ===");

  await loadExistingTables();

  const summary: string[] = [];

  // Curated store list shared by homepage.popularStores and menu.topStores
  const curatedStores = await getCuratedStores();

  // Explore categories shared by homepage.exploreDeals and menu.categorySections
  const exploreCategories = await getExploreCategories();

  // Each single type is atomic: a crash mid-tree rolls back the root row,
  // so the "already seeded" check never skips a half-built single type.
  await pgTransaction(() => seedGlobal(summary));
  await pgTransaction(() => seedHomepage(summary, curatedStores, exploreCategories));
  await pgTransaction(() => seedMenu(summary, curatedStores, exploreCategories));
  await pgTransaction(() => seedFooter(summary));

  logger.info("Site content summary:");
  for (const line of summary) logger.info(`  ${line}`);
}

// ─────────────────────────────────────────────────────────────────────
// global
// ─────────────────────────────────────────────────────────────────────

async function seedGlobal(summary: string[]): Promise<void> {
  if (!hasTable("globals")) {
    logger.warn(
      "globals table not found — run the Strapi schema migration first. Skipping global."
    );
    summary.push("global: skipped (table missing)");
    return;
  }
  if (await singleTypeHasRow("globals")) {
    logger.info("globals already seeded, skipping global");
    summary.push("global: skipped (already seeded)");
    return;
  }

  const opts = await fetchOptionsIn([
    "options_header_code",
    "options_footer_code",
    "options_enable_amazon_deal",
    "options_amazon_top_banner",
    "options_amazon_top_banner_link",
  ]);
  logger.info(
    `global: found ${opts.size}/5 WP option keys (${Array.from(opts.keys()).join(", ") || "none"})`
  );

  const now = new Date().toISOString();
  const documentId = generateDocumentId("global-singleton");

  const row: Record<string, any> = {
    document_id: documentId,
    header_code: clean(opts.get("options_header_code") ?? null),
    footer_code: clean(opts.get("options_footer_code") ?? null),
    enable_amazon_deal: opts.get("options_enable_amazon_deal") === "1",
    amazon_top_banner_link: clean(
      opts.get("options_amazon_top_banner_link") ?? null
    ),
    published_at: now,
    created_at: now,
    updated_at: now,
    locale: null,
  };

  // Only write columns that actually exist (schema drift safety)
  const actualCols = await getColumns("globals");
  for (const key of Object.keys(row)) {
    if (!actualCols.includes(key)) {
      logger.warn(`globals.${key} column not found — dropping from insert`);
      delete row[key];
    }
  }

  const globalId = await insertRow("globals", row);

  // amazonTopBanner media (attachment id → Strapi file id → morph link)
  let bannerLinked = false;
  const bannerRef = opts.get("options_amazon_top_banner");
  if (bannerRef) {
    const fileId = await resolveMediaRef(bannerRef);
    if (fileId) {
      await linkMedia(fileId, globalId, "api::global.global", "amazonTopBanner");
      bannerLinked = true;
    } else {
      logger.warn(
        `global: amazon_top_banner attachment ${bannerRef} could not be resolved — leaving null`
      );
    }
  }

  logger.info("global seeded");
  summary.push(
    `global: seeded (amazonTopBanner ${bannerLinked ? "linked" : "null"})`
  );
}

// ─────────────────────────────────────────────────────────────────────
// homepage (draft + published pair)
// ─────────────────────────────────────────────────────────────────────

interface Banner {
  desktopFileId: number;
  mobileFileId: number | null;
  link: string | null;
  alt: string | null;
}

interface StoreRow {
  id: number;
  name: string;
}

interface CategoryRow {
  id: number;
  name: string;
  slug: string;
}

interface HomepageData {
  banners: Banner[];
  heroDealIds: number[];
  heroDealLnk: Lnk | null;
  popularFeatured: StoreRow | null;
  popularStores: StoreRow[];
  popularFeaturedLnk: Lnk | null;
  popularStoresLnk: Lnk | null;
  topDealIds: number[];
  dealListDealsLnk: Lnk | null;
  exclusiveCouponIds: number[];
  exclusiveCouponLnk: Lnk | null;
  exploreTabs: Array<{ category: CategoryRow; dealIds: number[] }>;
  exploreTabCategoryLnk: Lnk | null;
  exploreTabDealsLnk: Lnk | null;
  newlyAddedCouponIds: number[];
  cardItemCouponLnk: Lnk | null;
  brandDealIds: number[];
  bankOffers: Array<{ bankId: number; subtitle: string | null }>;
  bankItemBankLnk: Lnk | null;
}

async function seedHomepage(
  summary: string[],
  curatedStores: StoreRow[],
  exploreCategories: CategoryRow[]
): Promise<void> {
  const missing = missingTables("homepages", "homepages_cmps");
  if (missing.length > 0) {
    logger.warn(
      `${missing.join(", ")} not found — run the Strapi schema migration first. Skipping homepage.`
    );
    summary.push("homepage: skipped (table missing)");
    return;
  }
  if (await singleTypeHasRow("homepages")) {
    logger.info("homepages already seeded, skipping homepage");
    summary.push("homepage: skipped (already seeded)");
    return;
  }

  const data = await gatherHomepageData(curatedStores, exploreCategories);

  const now = new Date().toISOString();
  const documentId = generateDocumentId("homepage-singleton");

  // draftAndPublish=true → two rows sharing document_id
  const draftId = await insertRow("homepages", {
    document_id: documentId,
    latest_insights_enabled: false,
    published_at: null,
    created_at: now,
    updated_at: now,
    locale: null,
  });
  const publishedId = await insertRow("homepages", {
    document_id: documentId,
    latest_insights_enabled: false,
    published_at: now,
    created_at: now,
    updated_at: now,
    locale: null,
  });

  // Component/link rows must exist for BOTH versions
  const sectionCounts = await buildHomepageTree(draftId, data, true);
  await buildHomepageTree(publishedId, data, false);

  logger.info("homepage seeded (draft + published)");
  summary.push(
    `homepage: seeded draft+published — ${sectionCounts.join(", ")}`
  );
}

async function gatherHomepageData(
  curatedStores: StoreRow[],
  exploreCategories: CategoryRow[]
): Promise<HomepageData> {
  // ── hero banners from WP ACF options repeater ──
  const banners = await parseSliderBanners();

  // ── hero products: top 4 published deals ──
  const heroDeals = await pgQuery<{ id: number }>(
    `SELECT id FROM "deals"
     WHERE published_at IS NOT NULL
     ORDER BY is_popular DESC, published_at DESC
     LIMIT 4`
  );

  // ── topDeals: 6 newest published popular deals ──
  const topDeals = await pgQuery<{ id: number }>(
    `SELECT id FROM "deals"
     WHERE published_at IS NOT NULL AND is_popular = true
     ORDER BY published_at DESC
     LIMIT 6`
  );

  // ── cgExclusive / newlyAdded: need coupons.offer_type ──
  let exclusiveCouponIds: number[] = [];
  let newlyAddedCouponIds: number[] = [];
  if (hasTable("coupons") && (await hasColumn("coupons", "offer_type"))) {
    const exclusive = await pgQuery<{ id: number }>(
      `SELECT id FROM "coupons"
       WHERE published_at IS NOT NULL AND offer_type = 'exclusive'
       ORDER BY published_at DESC
       LIMIT 4`
    );
    exclusiveCouponIds = exclusive.map((r) => r.id);
    const newlyAdded = await pgQuery<{ id: number }>(
      `SELECT id FROM "coupons"
       WHERE published_at IS NOT NULL AND offer_type = 'newly_added'
       ORDER BY published_at DESC
       LIMIT 4`
    );
    newlyAddedCouponIds = newlyAdded.map((r) => r.id);
  } else {
    logger.warn(
      "coupons.offer_type column not found — cgExclusive/newlyAdded sections will be skipped (run Phase 12 schema first)"
    );
  }

  // ── exploreDeals tabs: categories + their newest deals ──
  const exploreTabs: Array<{ category: CategoryRow; dealIds: number[] }> = [];
  const dealsCategoriesLnk = await detectLnk("deals", "categories", "category");
  if (!dealsCategoriesLnk) {
    logger.warn(
      "deals_categories_lnk not found — exploreDeals tabs will have no deals; section skipped"
    );
  } else {
    for (const category of exploreCategories) {
      const deals = await pgQuery<{ id: number }>(
        `SELECT d.id FROM "deals" d
         JOIN "${dealsCategoriesLnk.table}" l
           ON l."${dealsCategoriesLnk.sourceCol}" = d.id
          AND l."${dealsCategoriesLnk.targetCol}" = $1
         WHERE d.published_at IS NOT NULL
         ORDER BY d.published_at DESC
         LIMIT 8`,
        [category.id]
      );
      if (deals.length === 0) {
        logger.info(
          `exploreDeals: category '${category.slug}' has 0 published deals — tab skipped`
        );
        continue;
      }
      exploreTabs.push({ category, dealIds: deals.map((r) => r.id) });
    }
  }

  // ── dealsByBrand: 4 newest published deals with a brand relation ──
  let brandDealIds: number[] = [];
  const dealsBrandsLnk = await detectLnk("deals", "brands", "brand");
  if (dealsBrandsLnk) {
    const rows = await pgQuery<{ id: number }>(
      `SELECT d.id FROM "deals" d
       WHERE d.published_at IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM "${dealsBrandsLnk.table}" b
           WHERE b."${dealsBrandsLnk.sourceCol}" = d.id
         )
       ORDER BY d.published_at DESC
       LIMIT 4`
    );
    brandDealIds = rows.map((r) => r.id);
  } else {
    logger.warn("deals_brands_lnk not found — dealsByBrand section skipped");
  }

  // ── bankOffers: up to 6 banks by published-coupon count ──
  let bankOffers: Array<{ bankId: number; subtitle: string | null }> = [];
  const couponsBanksLnk = await detectLnk("coupons", "banks", "bank");
  if (couponsBanksLnk && hasTable("banks")) {
    const rows = await pgQuery<{ id: number; short_description: string | null }>(
      `SELECT b.id, b.short_description
       FROM "banks" b
       JOIN "${couponsBanksLnk.table}" l ON l."${couponsBanksLnk.targetCol}" = b.id
       JOIN "coupons" c ON c.id = l."${couponsBanksLnk.sourceCol}"
         AND c.published_at IS NOT NULL
       GROUP BY b.id, b.short_description
       ORDER BY COUNT(*) DESC
       LIMIT 6`
    );
    bankOffers = rows.map((r) => ({
      bankId: r.id,
      subtitle: truncate(clean(r.short_description), 80),
    }));
  } else {
    logger.warn("coupons_banks_lnk not found — bankOffers section skipped");
  }

  return {
    banners,
    heroDealIds: heroDeals.map((r) => r.id),
    heroDealLnk: await detectLnk("components_home_hero_products", "deal", "deal"),
    popularFeatured: curatedStores[0] ?? null,
    popularStores: curatedStores.slice(1, 13),
    popularFeaturedLnk: await detectLnk(
      "components_home_popular_stores",
      "featured_store",
      "store"
    ),
    popularStoresLnk: await detectLnk(
      "components_home_popular_stores",
      "stores",
      "store"
    ),
    topDealIds: topDeals.map((r) => r.id),
    dealListDealsLnk: await detectLnk("components_home_deal_lists", "deals", "deal"),
    exclusiveCouponIds,
    exclusiveCouponLnk: await detectLnk(
      "components_home_exclusive_items",
      "coupon",
      "coupon"
    ),
    exploreTabs,
    exploreTabCategoryLnk: await detectLnk(
      "components_home_explore_tabs",
      "category",
      "category"
    ),
    exploreTabDealsLnk: await detectLnk(
      "components_home_explore_tabs",
      "deals",
      "deal"
    ),
    newlyAddedCouponIds,
    cardItemCouponLnk: await detectLnk(
      "components_home_coupon_card_items",
      "coupon",
      "coupon"
    ),
    brandDealIds,
    bankOffers,
    bankItemBankLnk: await detectLnk(
      "components_home_bank_offer_items",
      "bank",
      "bank"
    ),
  };
}

/**
 * Builds the full component tree for one homepage row (draft or published).
 * Returns per-section summary strings (only meaningful on the first call;
 * `logSkips` avoids duplicate warnings on the second version).
 */
async function buildHomepageTree(
  homepageId: number,
  data: HomepageData,
  logSkips: boolean
): Promise<string[]> {
  const counts: string[] = [];
  const skip = (msg: string): void => {
    if (logSkips) logger.warn(msg);
  };

  // ── hero ──
  if (missingTables("components_home_hero_sections").length === 0) {
    const heroId = await insertRow("components_home_hero_sections", {
      enabled: true,
    });
    await addCmp("homepages_cmps", homepageId, heroId, "home.hero-section", "hero", 1);

    // banners (nested homepage.slider-slide via the PARENT component's cmps table)
    let bannerCount = 0;
    if (
      missingTables(
        "components_homepage_slider_slides",
        "components_home_hero_sections_cmps"
      ).length === 0
    ) {
      for (let i = 0; i < data.banners.length; i++) {
        const b = data.banners[i];
        const slideId = await insertRow("components_homepage_slider_slides", {
          link: b.link,
          alt_text: b.alt,
          order: i + 1,
        });
        await addCmp(
          "components_home_hero_sections_cmps",
          heroId,
          slideId,
          "homepage.slider-slide",
          "banners",
          i + 1
        );
        await linkMedia(b.desktopFileId, slideId, "homepage.slider-slide", "desktopImage");
        if (b.mobileFileId) {
          await linkMedia(b.mobileFileId, slideId, "homepage.slider-slide", "mobileImage");
        }
        bannerCount++;
      }
    } else {
      skip(
        "slider slide component tables missing — hero banners skipped"
      );
    }

    // products (nested home.hero-product + deal relation)
    let productCount = 0;
    if (
      missingTables(
        "components_home_hero_products",
        "components_home_hero_sections_cmps"
      ).length === 0 &&
      data.heroDealLnk
    ) {
      for (let i = 0; i < data.heroDealIds.length; i++) {
        const prodId = await insertRow("components_home_hero_products", {});
        await addCmp(
          "components_home_hero_sections_cmps",
          heroId,
          prodId,
          "home.hero-product",
          "products",
          i + 1
        );
        await linkRel(data.heroDealLnk, prodId, data.heroDealIds[i]);
        productCount++;
      }
    } else {
      skip("hero-product tables/link not found — hero products skipped");
    }

    counts.push(`hero(${bannerCount} banners, ${productCount} products)`);
  } else {
    skip("components_home_hero_sections missing — hero skipped");
    counts.push("hero(skipped)");
  }

  // ── topOffers: enabled=false, no items (no WP source for banner art) ──
  if (missingTables("components_home_top_offers").length === 0) {
    const id = await insertRow("components_home_top_offers", { enabled: false });
    await addCmp("homepages_cmps", homepageId, id, "home.top-offers", "topOffers", 1);
    counts.push("topOffers(disabled)");
  } else {
    skip("components_home_top_offers missing — topOffers skipped");
    counts.push("topOffers(skipped)");
  }

  // ── popularStores ──
  if (missingTables("components_home_popular_stores").length === 0) {
    const id = await insertRow("components_home_popular_stores", {
      enabled: true,
    });
    await addCmp(
      "homepages_cmps",
      homepageId,
      id,
      "home.popular-stores",
      "popularStores",
      1
    );
    if (data.popularFeatured && data.popularFeaturedLnk) {
      await linkRel(data.popularFeaturedLnk, id, data.popularFeatured.id);
    }
    if (data.popularStoresLnk) {
      for (let i = 0; i < data.popularStores.length; i++) {
        await linkRel(data.popularStoresLnk, id, data.popularStores[i].id, i + 1);
      }
    } else {
      skip("popular-stores stores link table not found — stores relation skipped");
    }
    counts.push(
      `popularStores(${data.popularFeatured ? 1 : 0} featured, ${data.popularStores.length} stores)`
    );
  } else {
    skip("components_home_popular_stores missing — popularStores skipped");
    counts.push("popularStores(skipped)");
  }

  // ── topDeals (home.deal-list) ──
  counts.push(
    await buildDealList(
      homepageId,
      "topDeals",
      "Top Deals",
      data.topDealIds,
      data.dealListDealsLnk,
      skip
    )
  );

  // ── cgExclusive ──
  if (data.exclusiveCouponIds.length === 0) {
    if (logSkips) logger.info("cgExclusive: 0 exclusive coupons — section skipped");
    counts.push("cgExclusive(skipped: 0 coupons)");
  } else if (
    missingTables(
      "components_home_cg_exclusives",
      "components_home_exclusive_items",
      "components_home_cg_exclusives_cmps"
    ).length === 0 &&
    data.exclusiveCouponLnk
  ) {
    const id = await insertRow("components_home_cg_exclusives", { enabled: true });
    await addCmp("homepages_cmps", homepageId, id, "home.cg-exclusive", "cgExclusive", 1);
    for (let i = 0; i < data.exclusiveCouponIds.length; i++) {
      const itemId = await insertRow("components_home_exclusive_items", {});
      await addCmp(
        "components_home_cg_exclusives_cmps",
        id,
        itemId,
        "home.exclusive-item",
        "items",
        i + 1
      );
      await linkRel(data.exclusiveCouponLnk, itemId, data.exclusiveCouponIds[i]);
    }
    counts.push(`cgExclusive(${data.exclusiveCouponIds.length} items)`);
  } else {
    skip("cg-exclusive component tables/link missing — cgExclusive skipped");
    counts.push("cgExclusive(skipped)");
  }

  // ── exploreDeals ──
  if (data.exploreTabs.length === 0) {
    if (logSkips) logger.info("exploreDeals: no tabs with deals — section skipped");
    counts.push("exploreDeals(skipped: 0 tabs)");
  } else if (
    missingTables(
      "components_home_explore_deals",
      "components_home_explore_tabs",
      "components_home_explore_deals_cmps"
    ).length === 0 &&
    data.exploreTabCategoryLnk &&
    data.exploreTabDealsLnk
  ) {
    const id = await insertRow("components_home_explore_deals", { enabled: true });
    await addCmp("homepages_cmps", homepageId, id, "home.explore-deals", "exploreDeals", 1);
    for (let i = 0; i < data.exploreTabs.length; i++) {
      const tab = data.exploreTabs[i];
      const tabId = await insertRow("components_home_explore_tabs", {});
      await addCmp(
        "components_home_explore_deals_cmps",
        id,
        tabId,
        "home.explore-tab",
        "tabs",
        i + 1
      );
      await linkRel(data.exploreTabCategoryLnk, tabId, tab.category.id);
      for (let j = 0; j < tab.dealIds.length; j++) {
        await linkRel(data.exploreTabDealsLnk, tabId, tab.dealIds[j], j + 1);
      }
    }
    counts.push(`exploreDeals(${data.exploreTabs.length} tabs)`);
  } else {
    skip("explore-deals component tables/links missing — exploreDeals skipped");
    counts.push("exploreDeals(skipped)");
  }

  // ── newlyAdded ──
  if (data.newlyAddedCouponIds.length === 0) {
    if (logSkips) logger.info("newlyAdded: 0 newly_added coupons — section skipped");
    counts.push("newlyAdded(skipped: 0 coupons)");
  } else if (
    missingTables(
      "components_home_newly_addeds",
      "components_home_coupon_card_items",
      "components_home_newly_addeds_cmps"
    ).length === 0 &&
    data.cardItemCouponLnk
  ) {
    const id = await insertRow("components_home_newly_addeds", { enabled: true });
    await addCmp("homepages_cmps", homepageId, id, "home.newly-added", "newlyAdded", 1);
    for (let i = 0; i < data.newlyAddedCouponIds.length; i++) {
      const itemId = await insertRow("components_home_coupon_card_items", {});
      await addCmp(
        "components_home_newly_addeds_cmps",
        id,
        itemId,
        "home.coupon-card-item",
        "items",
        i + 1
      );
      await linkRel(data.cardItemCouponLnk, itemId, data.newlyAddedCouponIds[i]);
    }
    counts.push(`newlyAdded(${data.newlyAddedCouponIds.length} items)`);
  } else {
    skip("newly-added component tables/link missing — newlyAdded skipped");
    counts.push("newlyAdded(skipped)");
  }

  // ── dealsByBrand (home.deal-list) ──
  counts.push(
    await buildDealList(
      homepageId,
      "dealsByBrand",
      null,
      data.brandDealIds,
      data.dealListDealsLnk,
      skip
    )
  );

  // ── bankOffers ──
  if (data.bankOffers.length === 0) {
    if (logSkips) logger.info("bankOffers: 0 banks with published coupons — section skipped");
    counts.push("bankOffers(skipped: 0 banks)");
  } else if (
    missingTables(
      "components_home_bank_offers",
      "components_home_bank_offer_items",
      "components_home_bank_offers_cmps"
    ).length === 0 &&
    data.bankItemBankLnk
  ) {
    const id = await insertRow("components_home_bank_offers", { enabled: true });
    await addCmp("homepages_cmps", homepageId, id, "home.bank-offers", "bankOffers", 1);
    for (let i = 0; i < data.bankOffers.length; i++) {
      const offer = data.bankOffers[i];
      const itemId = await insertRow("components_home_bank_offer_items", {
        icon_kind: "corporate",
        subtitle: offer.subtitle,
      });
      await addCmp(
        "components_home_bank_offers_cmps",
        id,
        itemId,
        "home.bank-offer-item",
        "items",
        i + 1
      );
      await linkRel(data.bankItemBankLnk, itemId, offer.bankId);
    }
    counts.push(`bankOffers(${data.bankOffers.length} items)`);
  } else {
    skip("bank-offers component tables/link missing — bankOffers skipped");
    counts.push("bankOffers(skipped)");
  }

  // ── howItWorks (exact frontend copy) ──
  if (
    missingTables(
      "components_home_how_it_works",
      "components_home_steps",
      "components_home_why_features",
      "components_home_how_it_works_cmps"
    ).length === 0
  ) {
    const id = await insertRow("components_home_how_it_works", { enabled: true });
    await addCmp("homepages_cmps", homepageId, id, "home.how-it-works", "howItWorks", 1);
    for (let i = 0; i < HOW_IT_WORKS_STEPS.length; i++) {
      const step = HOW_IT_WORKS_STEPS[i];
      const stepId = await insertRow("components_home_steps", {
        kind: step.kind,
        title: step.title,
        description: step.description,
      });
      await addCmp(
        "components_home_how_it_works_cmps",
        id,
        stepId,
        "home.step",
        "steps",
        i + 1
      );
    }
    for (let i = 0; i < WHY_FEATURES.length; i++) {
      const feature = WHY_FEATURES[i];
      const featureId = await insertRow("components_home_why_features", {
        kind: feature.kind,
        label: feature.label,
      });
      await addCmp(
        "components_home_how_it_works_cmps",
        id,
        featureId,
        "home.why-feature",
        "features",
        i + 1
      );
    }
    counts.push(
      `howItWorks(${HOW_IT_WORKS_STEPS.length} steps, ${WHY_FEATURES.length} features)`
    );
  } else {
    skip("how-it-works component tables missing — howItWorks skipped");
    counts.push("howItWorks(skipped)");
  }

  // ── faq (exact frontend copy) ──
  if (
    missingTables(
      "components_home_faq_blocks",
      "components_shared_faq_items",
      "components_home_faq_blocks_cmps"
    ).length === 0
  ) {
    const id = await insertRow("components_home_faq_blocks", { enabled: true });
    await addCmp("homepages_cmps", homepageId, id, "home.faq-block", "faq", 1);
    for (let i = 0; i < FAQ_ITEMS.length; i++) {
      const item = FAQ_ITEMS[i];
      const itemId = await insertRow("components_shared_faq_items", {
        question: item.question,
        answer: item.answer,
      });
      await addCmp(
        "components_home_faq_blocks_cmps",
        id,
        itemId,
        "shared.faq-item",
        "items",
        i + 1
      );
    }
    counts.push(`faq(${FAQ_ITEMS.length} items)`);
  } else {
    skip("faq component tables missing — faq skipped");
    counts.push("faq(skipped)");
  }

  return counts;
}

async function buildDealList(
  homepageId: number,
  field: string,
  heading: string | null,
  dealIds: number[],
  dealsLnk: Lnk | null,
  skip: (msg: string) => void
): Promise<string> {
  if (missingTables("components_home_deal_lists").length > 0) {
    skip(`components_home_deal_lists missing — ${field} skipped`);
    return `${field}(skipped)`;
  }
  const id = await insertRow("components_home_deal_lists", {
    enabled: true,
    heading,
  });
  await addCmp("homepages_cmps", homepageId, id, "home.deal-list", field, 1);
  if (dealsLnk) {
    for (let i = 0; i < dealIds.length; i++) {
      await linkRel(dealsLnk, id, dealIds[i], i + 1);
    }
  } else if (dealIds.length > 0) {
    skip(`deal-list deals link table not found — ${field} deals relation skipped`);
  }
  return `${field}(${dealIds.length} deals)`;
}

// ── hero banners from WP options_slider_features repeater ──

async function parseSliderBanners(): Promise<Banner[]> {
  const opts = await fetchOptionsLike("options_slider_features%");

  const bySlide = new Map<number, Map<string, string>>();
  const subNames = new Set<string>();
  for (const [name, value] of opts) {
    const m = name.match(/^options_slider_features_(\d+)_(.+)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const sub = m[2];
    subNames.add(sub);
    if (!bySlide.has(idx)) bySlide.set(idx, new Map());
    bySlide.get(idx)!.set(sub, value);
  }

  if (bySlide.size === 0) {
    logger.info("hero banners: no options_slider_features_* rows found in wp_options");
    return [];
  }
  logger.info(
    `hero banners: found ${bySlide.size} slider rows, subfields: ${Array.from(subNames).join(", ")}`
  );

  const pick = (
    subs: Map<string, string>,
    pred: (key: string) => boolean
  ): string | undefined => {
    for (const [key, value] of subs) {
      if (pred(key)) return value;
    }
    return undefined;
  };

  const banners: Banner[] = [];
  const indices = Array.from(bySlide.keys()).sort((a, b) => a - b);
  for (const idx of indices) {
    const subs = bySlide.get(idx)!;
    // Expected subfields: slider_image, slider_mobile_image, slider_link,
    // slider_alt — matched fuzzily so ACF field renames don't break us.
    const isImageKey = (k: string) =>
      (k.includes("image") || k.includes("img") || k.includes("banner")) &&
      !k.includes("alt") &&
      !k.includes("caption") &&
      !k.includes("title");
    const desktopRef = pick(subs, (k) => !k.includes("mobile") && isImageKey(k));
    const mobileRef = pick(subs, (k) => k.includes("mobile") && isImageKey(k));
    const link = pick(subs, (k) => k.includes("link") || k.includes("url"));
    const alt = pick(subs, (k) => k.includes("alt") || k.includes("caption"));

    const desktopFileId = await resolveMediaRef(desktopRef);
    if (!desktopFileId) {
      logger.warn(
        `hero banner ${idx}: desktop image '${desktopRef ?? "(missing)"}' did not migrate — row skipped`
      );
      continue;
    }
    const mobileFileId = mobileRef ? await resolveMediaRef(mobileRef) : undefined;

    banners.push({
      desktopFileId,
      mobileFileId: mobileFileId ?? null,
      link: clean(link ?? null),
      alt: clean(alt ?? null),
    });
  }
  return banners;
}

// ── curated store list (options_featured_stores → fallback by coupon count) ──

async function getCuratedStores(): Promise<StoreRow[]> {
  if (!hasTable("stores")) {
    logger.warn("stores table not found — curated store list empty");
    return [];
  }

  const opts = await fetchOptionsLike("options_featured_stores%");
  const termIds: number[] = [];

  const direct = opts.get("options_featured_stores");
  if (direct && !/^\d+$/.test(direct.trim())) {
    // ACF taxonomy field: PHP-serialized array of term ids
    termIds.push(...parseIdList(direct));
  } else {
    // ACF repeater: options_featured_stores_<i>[_<subfield>] rows
    const rowsByIdx = new Map<number, string[]>();
    for (const [name, value] of opts) {
      const m = name.match(/^options_featured_stores_(\d+)(?:_(.+))?$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      if (!rowsByIdx.has(idx)) rowsByIdx.set(idx, []);
      rowsByIdx.get(idx)!.push(value);
    }
    const indices = Array.from(rowsByIdx.keys()).sort((a, b) => a - b);
    for (const idx of indices) {
      for (const value of rowsByIdx.get(idx)!) {
        const ids = parseIdList(value);
        if (ids.length > 0) {
          termIds.push(ids[0]);
          break;
        }
      }
    }
  }

  const stores: StoreRow[] = [];
  const seen = new Set<number>();
  for (const termId of termIds) {
    const ref = await ensureTermMapping(termId);
    if (!ref || ref.table !== "stores") {
      logger.warn(`featured store term ${termId} did not map to a migrated store — skipped`);
      continue;
    }
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    const row = await pgQuery<{ id: number; name: string }>(
      `SELECT id, name FROM "stores" WHERE id = $1`,
      [ref.id]
    );
    if (row[0]) stores.push(row[0]);
  }

  if (stores.length > 0) {
    logger.info(`curated stores: ${stores.length} from options_featured_stores`);
    return stores;
  }

  // Fallback: top stores by published-coupon count
  const couponsStoresLnk = await detectLnk("coupons", "stores", "store");
  if (!couponsStoresLnk) {
    logger.warn("coupons_stores_lnk not found — curated store list empty");
    return [];
  }
  const fallback = await pgQuery<StoreRow>(
    `SELECT s.id, s.name
     FROM "stores" s
     JOIN "${couponsStoresLnk.table}" l ON l."${couponsStoresLnk.targetCol}" = s.id
     JOIN "coupons" c ON c.id = l."${couponsStoresLnk.sourceCol}"
       AND c.published_at IS NOT NULL
     GROUP BY s.id, s.name
     ORDER BY COUNT(*) DESC
     LIMIT 16`
  );
  logger.info(
    `curated stores: options_featured_stores empty/unmapped — fallback to top ${fallback.length} stores by coupon count`
  );
  return fallback;
}

// ── explore categories (fuzzy slug match) ──

async function getExploreCategories(): Promise<CategoryRow[]> {
  if (!hasTable("categories")) {
    logger.warn("categories table not found — explore categories empty");
    return [];
  }
  const patterns = EXPLORE_SLUG_PATTERNS.map((p) => `%${p}%`);
  const rows = await pgQuery<CategoryRow>(
    `SELECT id, name, slug FROM "categories"
     WHERE published_at IS NOT NULL AND slug ILIKE ANY($1::text[])`,
    [patterns]
  );
  // Keep the pattern priority order (electronics first, home last), max 8
  const rank = (slug: string): number => {
    const i = EXPLORE_SLUG_PATTERNS.findIndex((p) => slug.includes(p));
    return i === -1 ? EXPLORE_SLUG_PATTERNS.length : i;
  };
  rows.sort((a, b) => rank(a.slug) - rank(b.slug) || a.slug.localeCompare(b.slug));
  const picked = rows.slice(0, 8);
  logger.info(
    `explore categories: ${picked.map((c) => c.slug).join(", ") || "none matched"}`
  );
  return picked;
}

// ─────────────────────────────────────────────────────────────────────
// menu
// ─────────────────────────────────────────────────────────────────────

async function seedMenu(
  summary: string[],
  curatedStores: StoreRow[],
  exploreCategories: CategoryRow[]
): Promise<void> {
  const missing = missingTables("menus", "menus_cmps", "components_nav_links");
  if (missing.length > 0) {
    logger.warn(
      `${missing.join(", ")} not found — run the Strapi schema migration first. Skipping menu.`
    );
    summary.push("menu: skipped (table missing)");
    return;
  }
  if (await singleTypeHasRow("menus")) {
    logger.info("menus already seeded, skipping menu");
    summary.push("menu: skipped (already seeded)");
    return;
  }

  const now = new Date().toISOString();
  const menuId = await insertRow("menus", {
    document_id: generateDocumentId("menu-singleton"),
    top_stores_view_all_url: "/stores/",
    published_at: now,
    created_at: now,
    updated_at: now,
    locale: null,
  });

  // ── topStores relation (same list as popularStores, max 15) ──
  let topStoreCount = 0;
  const topStoresLnk = await detectLnk("menus", "top_stores", "store");
  if (topStoresLnk) {
    const topStores = curatedStores.slice(0, 15);
    for (let i = 0; i < topStores.length; i++) {
      await linkRel(topStoresLnk, menuId, topStores[i].id, i + 1);
      topStoreCount++;
    }
  } else {
    logger.warn("menus top_stores link table not found — topStores skipped");
  }

  // ── categorySections ──
  let sectionCount = 0;
  const sectionTablesMissing = missingTables(
    "components_nav_category_sections",
    "components_nav_category_sections_cmps"
  );
  const sectionCategoryLnk = await detectLnk(
    "components_nav_category_sections",
    "category",
    "category"
  );
  const navLinkStoreLnk = await detectLnk("components_nav_links", "store", "store");
  const couponsStoresLnk = await detectLnk("coupons", "stores", "store");
  const couponsCategoriesLnk = await detectLnk("coupons", "categories", "category");

  if (sectionTablesMissing.length > 0) {
    logger.warn(
      `${sectionTablesMissing.join(", ")} not found — menu categorySections skipped`
    );
  } else {
    for (let i = 0; i < exploreCategories.length; i++) {
      const category = exploreCategories[i];
      const sectionId = await insertRow("components_nav_category_sections", {
        title: category.name,
      });
      await addCmp(
        "menus_cmps",
        menuId,
        sectionId,
        "nav.category-section",
        "categorySections",
        i + 1
      );
      if (sectionCategoryLnk) {
        await linkRel(sectionCategoryLnk, sectionId, category.id);
      }

      // links: top stores in this category by published-coupon count
      if (couponsStoresLnk && couponsCategoriesLnk) {
        const stores = await pgQuery<StoreRow>(
          `SELECT s.id, s.name
           FROM "stores" s
           JOIN "${couponsStoresLnk.table}" cs
             ON cs."${couponsStoresLnk.targetCol}" = s.id
           JOIN "${couponsCategoriesLnk.table}" cc
             ON cc."${couponsCategoriesLnk.sourceCol}" = cs."${couponsStoresLnk.sourceCol}"
            AND cc."${couponsCategoriesLnk.targetCol}" = $1
           JOIN "coupons" c ON c.id = cs."${couponsStoresLnk.sourceCol}"
             AND c.published_at IS NOT NULL
           GROUP BY s.id, s.name
           ORDER BY COUNT(*) DESC
           LIMIT 6`,
          [category.id]
        );
        for (let j = 0; j < stores.length; j++) {
          const linkId = await insertRow("components_nav_links", {
            label: stores[j].name,
            url: null,
          });
          await addCmp(
            "components_nav_category_sections_cmps",
            sectionId,
            linkId,
            "nav.link",
            "links",
            j + 1
          );
          if (navLinkStoreLnk) {
            await linkRel(navLinkStoreLnk, linkId, stores[j].id);
          }
        }
      }
      sectionCount++;
    }
  }

  // ── extraItems ──
  let extraCount = 0;
  for (let i = 0; i < MENU_EXTRA_ITEMS.length; i++) {
    const item = MENU_EXTRA_ITEMS[i];
    const linkId = await insertRow("components_nav_links", {
      label: item.label,
      url: item.url,
      featured: item.featured ?? false,
    });
    await addCmp("menus_cmps", menuId, linkId, "nav.link", "extraItems", i + 1);
    extraCount++;
  }

  logger.info("menu seeded");
  summary.push(
    `menu: seeded (${topStoreCount} topStores, ${sectionCount} categorySections, ${extraCount} extraItems)`
  );
}

// ─────────────────────────────────────────────────────────────────────
// footer
// ─────────────────────────────────────────────────────────────────────

async function seedFooter(summary: string[]): Promise<void> {
  const missing = missingTables(
    "footers",
    "footers_cmps",
    "components_footer_link_sections",
    "components_nav_links"
  );
  if (missing.length > 0) {
    logger.warn(
      `${missing.join(", ")} not found — run the Strapi schema migration first. Skipping footer.`
    );
    summary.push("footer: skipped (table missing)");
    return;
  }
  if (await singleTypeHasRow("footers")) {
    logger.info("footers already seeded, skipping footer");
    summary.push("footer: skipped (already seeded)");
    return;
  }

  const now = new Date().toISOString();
  const footerId = await insertRow("footers", {
    document_id: generateDocumentId("footer-singleton"),
    badge_text: FOOTER_BADGE,
    copyright_text: FOOTER_COPYRIGHT,
    published_at: now,
    created_at: now,
    updated_at: now,
    locale: null,
  });

  const navLinkStoreLnk = await detectLnk("components_nav_links", "store", "store");
  const sectionsCmpsOk =
    missingTables("components_footer_link_sections_cmps").length === 0;

  // ── sections ──
  let sectionCount = 0;
  let storeLinksResolved = 0;
  for (let i = 0; i < FOOTER_SECTIONS.length; i++) {
    const section = FOOTER_SECTIONS[i];
    const sectionId = await insertRow("components_footer_link_sections", {
      title: section.title,
    });
    await addCmp(
      "footers_cmps",
      footerId,
      sectionId,
      "footer.link-section",
      "sections",
      i + 1
    );
    if (!sectionsCmpsOk) {
      if (i === 0) {
        logger.warn(
          "components_footer_link_sections_cmps not found — footer section links skipped"
        );
      }
      sectionCount++;
      continue;
    }
    for (let j = 0; j < section.links.length; j++) {
      const link = section.links[j];
      let storeId: number | null = null;
      if (link.store && hasTable("stores")) {
        const match = await pgQuery<{ id: number; slug: string }>(
          `SELECT id, slug FROM "stores" WHERE name ILIKE $1 LIMIT 1`,
          [link.label]
        );
        if (match[0]) storeId = match[0].id;
      }
      const linkId = await insertRow("components_nav_links", {
        label: link.label,
        url: storeId ? null : link.href,
        bold: link.bold ?? false,
      });
      await addCmp(
        "components_footer_link_sections_cmps",
        sectionId,
        linkId,
        "nav.link",
        "links",
        j + 1
      );
      if (storeId && navLinkStoreLnk) {
        await linkRel(navLinkStoreLnk, linkId, storeId);
        storeLinksResolved++;
      }
    }
    sectionCount++;
  }

  // ── socialLinks ──
  let socialCount = 0;
  if (missingTables("components_footer_social_links").length === 0) {
    for (let i = 0; i < SOCIAL_PLATFORMS.length; i++) {
      const id = await insertRow("components_footer_social_links", {
        platform: SOCIAL_PLATFORMS[i],
        url: "#",
      });
      await addCmp(
        "footers_cmps",
        footerId,
        id,
        "footer.social-link",
        "socialLinks",
        i + 1
      );
      socialCount++;
    }
  } else {
    logger.warn("components_footer_social_links missing — socialLinks skipped");
  }

  // ── countries (flag media left null) ──
  let countryCount = 0;
  if (missingTables("components_footer_countries").length === 0) {
    for (let i = 0; i < FOOTER_COUNTRIES.length; i++) {
      const country = FOOTER_COUNTRIES[i];
      const id = await insertRow("components_footer_countries", {
        code: country.code,
        name: country.name,
      });
      await addCmp(
        "footers_cmps",
        footerId,
        id,
        "footer.country",
        "countries",
        i + 1
      );
      countryCount++;
    }
  } else {
    logger.warn("components_footer_countries missing — countries skipped");
  }

  // ── partnerCard ──
  let partnerCard = false;
  if (missingTables("components_footer_partner_cards").length === 0) {
    const id = await insertRow("components_footer_partner_cards", {
      title: PARTNER_CARD.title,
      description: PARTNER_CARD.description,
      cta_label: PARTNER_CARD.ctaLabel,
      cta_url: PARTNER_CARD.ctaUrl,
    });
    await addCmp(
      "footers_cmps",
      footerId,
      id,
      "footer.partner-card",
      "partnerCard",
      1
    );
    partnerCard = true;
  } else {
    logger.warn("components_footer_partner_cards missing — partnerCard skipped");
  }

  logger.info("footer seeded");
  summary.push(
    `footer: seeded (${sectionCount} sections, ${storeLinksResolved} store links resolved, ` +
      `${socialCount} socials, ${countryCount} countries, partnerCard=${partnerCard})`
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function truncate(val: string | null, max: number): string | null {
  if (!val) return null;
  if (val.length <= max) return val;
  return `${val.slice(0, max - 3).trimEnd()}...`;
}
