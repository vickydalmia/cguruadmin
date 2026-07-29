import { unserialize } from "php-serialize";
import { wpQuery } from "../db/wp-client.js";
import { pgQuery, pgTransaction } from "../db/pg-client.js";
import {
  limitHomepageBankOffers,
  MAX_HOMEPAGE_BANK_OFFERS,
} from "../utils/homepage-bank-offers.js";
import { HOMEPAGE_SEED_LIMITS } from "../utils/homepage-limits.js";
import { ensureTermMapping } from "../utils/id-maps.js";
import { resolveMediaRef } from "../utils/media-resolver.js";
import {
  generateDocumentId,
  insertLink,
  linkMedia,
} from "../utils/strapi-insert.js";
import { clean } from "../utils/sanitize.js";
import { logger } from "../utils/logger.js";
import { HEADER_SEARCH_SUGGESTIONS } from "../utils/site-selection-defaults.js";

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

const FOOTER_COUNTRIES: ReadonlyArray<{ code: string; name: string; url: string }> = [
  { code: "us", name: "USA", url: "https://www.couponzguruusa.com/" },
  { code: "sg", name: "Singapore", url: "https://www.couponzguru.sg/" },
  { code: "ph", name: "Philippines", url: "https://www.couponzguru.ph/" },
  { code: "ae", name: "UAE", url: "https://www.couponzguru.ae/" },
  { code: "my", name: "Malaysia", url: "https://www.couponzguru.my/" },
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

  // Seed source for independently editable homepage, navigation, and search
  // store selections.
  const curatedStores = await getCuratedStores();

  // Explore categories shared by homepage.exploreOffers and menu.categorySections
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

type ComponentLink = {
  cmp_id: number;
  order: number;
};

type LegacySectionRow = {
  enabled: boolean | null;
  heading: string | null;
};

type LegacyExploreTabRow = {
  id: number;
  label_override: string | null;
  order: number;
};

function phase13aInfrastructureError(context: string, missing: string[]): Error {
  return new Error(
    `Phase 13a cannot safely backfill ${context}: missing required infrastructure ` +
      `(${missing.join(", ")}). Apply the Strapi schemas before rerunning this phase.`
  );
}

function requirePhase13aTables(context: string, ...tables: string[]): void {
  const missing = missingTables(...tables);
  if (missing.length > 0) throw phase13aInfrastructureError(context, missing);
}

async function componentLink(
  table: string,
  entityId: number,
  field: string
): Promise<ComponentLink | null> {
  if (!hasTable(table)) return null;
  const rows = await pgQuery<ComponentLink>(
    `SELECT cmp_id, "order" FROM "${table}"
     WHERE entity_id = $1 AND field = $2
     ORDER BY "order" ASC LIMIT 1`,
    [entityId, field]
  );
  return rows[0] ?? null;
}

function migratedOfferHeading(
  heading: string | null,
  fallback: string
): string {
  const value = clean(heading);
  if (!value) return fallback;
  return value.replace(/\bDeals\b/gi, "Offers").replace(/\bDeal\b/gi, "Offer");
}

async function cloneViewAllCta(
  sourceCmpsTable: string,
  sourceEntityId: number,
  targetCmpsTable: string,
  targetEntityId: number
): Promise<void> {
  requirePhase13aTables(
    "View All CTA components",
    sourceCmpsTable,
    targetCmpsTable,
    "components_shared_ctas"
  );
  const source = await componentLink(sourceCmpsTable, sourceEntityId, "viewAllCta");
  if (!source) return;
  const rows = await pgQuery<{ label: string | null; url: string | null }>(
    `SELECT label, url FROM "components_shared_ctas" WHERE id = $1 LIMIT 1`,
    [source.cmp_id]
  );
  const cta = rows[0];
  if (!cta) return;
  const label = migratedOfferHeading(cta.label, "View All Offers");
  const url = cta.url === "/deals/" ? "/offers/" : cta.url;
  const ctaId = await insertRow("components_shared_ctas", { label, url });
  await addCmp(
    targetCmpsTable,
    targetEntityId,
    ctaId,
    "shared.cta",
    "viewAllCta",
    1
  );
}

async function relationTargetId(
  relation: Lnk,
  sourceId: number
): Promise<number | null> {
  return (await relatedIds(relation, sourceId))[0] ?? null;
}

async function relatedIds(relation: Lnk, sourceId: number): Promise<number[]> {
  const orderSql = relation.ordCols[0] ? `"${relation.ordCols[0]}" ASC, ` : "";
  const rows = await pgQuery<{ target_id: number }>(
    `SELECT "${relation.targetCol}" AS target_id
     FROM "${relation.table}"
     WHERE "${relation.sourceCol}" = $1
     ORDER BY ${orderSql}"${relation.targetCol}" ASC`,
    [sourceId]
  );
  return rows.map((row) => row.target_id);
}

async function publishedCouponsForCategory(
  categoryId: number,
  couponsCategoriesLnk: Lnk
): Promise<number[]> {
  const rows = await pgQuery<{ id: number }>(
    `SELECT DISTINCT c.id FROM "coupons" c
     JOIN "${couponsCategoriesLnk.table}" l
       ON l."${couponsCategoriesLnk.sourceCol}" = c.id
      AND l."${couponsCategoriesLnk.targetCol}" = $1
     WHERE c.published_at IS NOT NULL
       AND c.content_status = 'published'
     ORDER BY c.id DESC
     LIMIT ${HOMEPAGE_SEED_LIMITS.exploreOffersPerTab}`,
    [categoryId]
  );
  return rows.map((row) => row.id);
}

async function backfillExploreOffers(homepageId: number): Promise<string> {
  if (await componentLink("homepages_cmps", homepageId, "exploreOffers")) {
    return "exploreOffers(skipped: already populated)";
  }

  const legacy = await componentLink("homepages_cmps", homepageId, "exploreDeals");
  if (!legacy) return "exploreOffers(skipped: no legacy section)";

  requirePhase13aTables(
    "Explore Offers",
    "components_home_explore_deals",
    "components_home_explore_tabs",
    "components_home_explore_deals_cmps",
    "components_home_explore_tabs_cmps",
    "components_home_explore_offers",
    "components_home_explore_offer_tabs",
    "components_home_explore_offers_cmps",
    "components_home_explore_offer_tabs_cmps",
    "components_shared_ctas",
    "coupons"
  );

  const legacySection = (
    await pgQuery<LegacySectionRow>(
      `SELECT enabled, heading FROM "components_home_explore_deals" WHERE id = $1 LIMIT 1`,
      [legacy.cmp_id]
    )
  )[0];
  if (!legacySection) {
    throw new Error(
      `Phase 13a found a dangling Explore Deals component link for homepage ${homepageId}`
    );
  }

  const legacyTabs = await pgQuery<LegacyExploreTabRow>(
    `SELECT t.id, t.label_override, c."order"
     FROM "components_home_explore_deals_cmps" c
     JOIN "components_home_explore_tabs" t ON t.id = c.cmp_id
     WHERE c.entity_id = $1 AND c.field = 'tabs'
     ORDER BY c."order" ASC`,
    [legacy.cmp_id]
  );
  const legacyCategoryLnk = await detectLnk(
    "components_home_explore_tabs",
    "category",
    "category"
  );
  const newCategoryLnk = await detectLnk(
    "components_home_explore_offer_tabs",
    "category",
    "category"
  );
  const newOffersLnk = await detectLnk(
    "components_home_explore_offer_tabs",
    "offers",
    "coupon"
  );
  const couponsCategoriesLnk = await detectLnk("coupons", "categories", "category");
  if (!legacyCategoryLnk || !newCategoryLnk || !newOffersLnk || !couponsCategoriesLnk) {
    const missingRelations = [
      !legacyCategoryLnk && "legacy Explore Deals category relation",
      !newCategoryLnk && "Explore Offers category relation",
      !newOffersLnk && "Explore Offers Coupon relation",
      !couponsCategoriesLnk && "Coupon categories relation",
    ].filter((value): value is string => Boolean(value));
    throw phase13aInfrastructureError("Explore Offers relations", missingRelations);
  }

  const tabs: Array<{
    source: LegacyExploreTabRow;
    categoryId: number;
    couponIds: number[];
  }> = [];
  for (const source of legacyTabs) {
    const categoryId = await relationTargetId(legacyCategoryLnk, source.id);
    if (!categoryId) continue;
    const couponIds = await publishedCouponsForCategory(categoryId, couponsCategoriesLnk);
    if (couponIds.length > 0) tabs.push({ source, categoryId, couponIds });
  }
  if (tabs.length === 0) return "exploreOffers(skipped: no matching coupons)";

  const sectionId = await insertRow("components_home_explore_offers", {
    enabled: legacySection.enabled ?? true,
    heading: migratedOfferHeading(legacySection.heading, "Explore Offers"),
  });
  await addCmp(
    "homepages_cmps",
    homepageId,
    sectionId,
    "home.explore-offers",
    "exploreOffers",
    legacy.order
  );
  await cloneViewAllCta(
    "components_home_explore_deals_cmps",
    legacy.cmp_id,
    "components_home_explore_offers_cmps",
    sectionId
  );

  for (let index = 0; index < tabs.length; index++) {
    const tab = tabs[index];
    const tabId = await insertRow("components_home_explore_offer_tabs", {
      label_override: tab.source.label_override,
    });
    await addCmp(
      "components_home_explore_offers_cmps",
      sectionId,
      tabId,
      "home.explore-offer-tab",
      "tabs",
      index + 1
    );
    await linkRel(newCategoryLnk, tabId, tab.categoryId);
    for (let offerIndex = 0; offerIndex < tab.couponIds.length; offerIndex++) {
      await linkRel(newOffersLnk, tabId, tab.couponIds[offerIndex], offerIndex + 1);
    }
    await cloneViewAllCta(
      "components_home_explore_tabs_cmps",
      tab.source.id,
      "components_home_explore_offer_tabs_cmps",
      tabId
    );
  }
  return `exploreOffers(${tabs.length} tabs)`;
}

async function backfillOffersByBrand(homepageId: number): Promise<string> {
  if (await componentLink("homepages_cmps", homepageId, "offersByBrand")) {
    return "offersByBrand(skipped: already populated)";
  }
  const legacy = await componentLink("homepages_cmps", homepageId, "dealsByBrand");
  if (!legacy) return "offersByBrand(skipped: no legacy section)";

  requirePhase13aTables(
    "Offers By Brand",
    "components_home_deal_lists",
    "components_home_deal_lists_cmps",
    "components_home_offer_lists",
    "components_home_offer_lists_cmps",
    "components_shared_ctas",
    "coupons",
    "deals"
  );

  const legacySection = (
    await pgQuery<LegacySectionRow>(
      `SELECT enabled, heading FROM "components_home_deal_lists" WHERE id = $1 LIMIT 1`,
      [legacy.cmp_id]
    )
  )[0];
  const legacyDealsLnk = await detectLnk("components_home_deal_lists", "deals", "deal");
  const dealsBrandsLnk = await detectLnk("deals", "brands", "brand");
  const couponsBrandsLnk = await detectLnk("coupons", "brands", "brand");
  const newOffersLnk = await detectLnk("components_home_offer_lists", "offers", "coupon");
  if (!legacySection) {
    throw new Error(
      `Phase 13a found a dangling Deals By Brand component link for homepage ${homepageId}`
    );
  }
  if (!legacyDealsLnk || !dealsBrandsLnk || !couponsBrandsLnk || !newOffersLnk) {
    const missingRelations = [
      !legacyDealsLnk && "legacy Deals By Brand Deal relation",
      !dealsBrandsLnk && "Deal brands relation",
      !couponsBrandsLnk && "Coupon brands relation",
      !newOffersLnk && "Offers By Brand Coupon relation",
    ].filter((value): value is string => Boolean(value));
    throw phase13aInfrastructureError("Offers By Brand relations", missingRelations);
  }

  const dealIds = await relatedIds(legacyDealsLnk, legacy.cmp_id);
  const brandRows = dealIds.length
    ? await pgQuery<{ target_id: number }>(
        `SELECT DISTINCT "${dealsBrandsLnk.targetCol}" AS target_id
         FROM "${dealsBrandsLnk.table}"
         WHERE "${dealsBrandsLnk.sourceCol}" = ANY($1::int[])`,
        [dealIds]
      )
    : [];
  const brandIds = new Set<number>(brandRows.map((row) => row.target_id));
  if (brandIds.size === 0) return "offersByBrand(skipped: no legacy brands)";

  const couponRows = await pgQuery<{ id: number }>(
    `SELECT DISTINCT c.id FROM "coupons" c
     JOIN "${couponsBrandsLnk.table}" l
       ON l."${couponsBrandsLnk.sourceCol}" = c.id
     WHERE c.published_at IS NOT NULL
       AND c.content_status = 'published'
       AND l."${couponsBrandsLnk.targetCol}" = ANY($1::int[])
     ORDER BY c.id DESC
     LIMIT ${HOMEPAGE_SEED_LIMITS.offersByBrand}`,
    [[...brandIds]]
  );
  if (couponRows.length === 0) return "offersByBrand(skipped: no matching coupons)";

  const sectionId = await insertRow("components_home_offer_lists", {
    enabled: legacySection.enabled ?? true,
    heading: migratedOfferHeading(legacySection.heading, "Offers By Brand"),
  });
  await addCmp(
    "homepages_cmps",
    homepageId,
    sectionId,
    "home.offer-list",
    "offersByBrand",
    legacy.order
  );
  for (let index = 0; index < couponRows.length; index++) {
    await linkRel(newOffersLnk, sectionId, couponRows[index].id, index + 1);
  }
  await cloneViewAllCta(
    "components_home_deal_lists_cmps",
    legacy.cmp_id,
    "components_home_offer_lists_cmps",
    sectionId
  );
  return `offersByBrand(${couponRows.length} coupons)`;
}

async function assertPhase13aSchema(): Promise<void> {
  requirePhase13aTables(
    "homepage Coupon offer sections",
    "homepages",
    "homepages_cmps",
    "components_home_explore_offers",
    "components_home_explore_offer_tabs",
    "components_home_explore_offers_cmps",
    "components_home_explore_offer_tabs_cmps",
    "components_home_offer_lists",
    "components_home_offer_lists_cmps",
    "components_shared_ctas",
    "coupons"
  );

  const exploreCategoryLnk = await detectLnk(
    "components_home_explore_offer_tabs",
    "category",
    "category"
  );
  const exploreOffersLnk = await detectLnk(
    "components_home_explore_offer_tabs",
    "offers",
    "coupon"
  );
  const offersByBrandLnk = await detectLnk(
    "components_home_offer_lists",
    "offers",
    "coupon"
  );
  const missingRelations = [
    !exploreCategoryLnk && "Explore Offers category relation",
    !exploreOffersLnk && "Explore Offers Coupon relation",
    !offersByBrandLnk && "Offers By Brand Coupon relation",
  ].filter((value): value is string => Boolean(value));
  if (missingRelations.length > 0) {
    throw phase13aInfrastructureError("homepage Coupon offer relations", missingRelations);
  }
}

async function lockHomepageForOfferBackfill(homepageId: number): Promise<void> {
  const rows = await pgQuery<{ id: number }>(
    `SELECT id FROM "homepages" WHERE id = $1 FOR UPDATE`,
    [homepageId]
  );
  if (rows.length === 0) {
    throw new Error(`Homepage ${homepageId} disappeared before Phase 13a could lock it`);
  }
}

// Compatibility backfill for databases whose homepage already contains the
// legacy Deal-backed sections. It has its own checkpoint so existing installs
// run it even if Phase 13 completed before these component schemas existed.
export async function runHomepageOfferBackfill(): Promise<void> {
  logger.info("=== Phase 13a: Homepage Coupon Offer Sections ===");
  await loadExistingTables();
  await assertPhase13aSchema();

  const homepages = await pgQuery<{ id: number }>(
    `SELECT id FROM "homepages" ORDER BY id ASC`
  );
  for (const homepage of homepages) {
    const results = await pgTransaction(async () => {
      // Serialize check-then-insert across concurrent deploy jobs. Without the
      // row lock, two Phase 13a processes can both observe an absent component
      // and attach duplicate sections before either transaction commits.
      await lockHomepageForOfferBackfill(homepage.id);
      return [
        await backfillExploreOffers(homepage.id),
        await backfillOffersByBrand(homepage.id),
      ];
    });
    logger.info(`homepage ${homepage.id}: ${results.join(", ")}`);
  }
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
  ]);
  logger.info(
    `global: found ${opts.size}/2 WP option keys (${Array.from(opts.keys()).join(", ") || "none"})`
  );

  const now = new Date().toISOString();
  const documentId = generateDocumentId("global-singleton");

  const row: Record<string, any> = {
    document_id: documentId,
    title: "Global Settings",
    header_code: clean(opts.get("options_header_code") ?? null),
    footer_code: clean(opts.get("options_footer_code") ?? null),
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

  await insertRow("globals", row);

  logger.info("global seeded");
  summary.push("global: seeded");
}

// ─────────────────────────────────────────────────────────────────────
// homepage (draft + published pair)
// ─────────────────────────────────────────────────────────────────────

interface Banner {
  desktopFileId: number;
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

/** Coupon plus its image file — required-image item slots reuse the coupon's
 *  own art so sections render and homepage saves are never blocked; editors
 *  can replace with Figma-sized art later (existing files are grandfathered
 *  by the size validator). */
type CouponWithImage = { couponId: number; imageFileId: number };

interface HomepageData {
  banners: Banner[];
  heroDealIds: number[];
  heroDealLnk: Lnk | null;
  popularFeatured: StoreRow | null;
  popularStores: StoreRow[];
  popularFeaturedLnk: Lnk | null;
  popularStoresLnk: Lnk | null;
  topOfferCoupons: CouponWithImage[];
  topOfferCouponLnk: Lnk | null;
  topDealIds: number[];
  dealListDealsLnk: Lnk | null;
  exclusiveCoupons: CouponWithImage[];
  exclusiveCouponLnk: Lnk | null;
  exploreOfferTabs: Array<{ category: CategoryRow; couponIds: number[] }>;
  exploreOfferTabCategoryLnk: Lnk | null;
  exploreOfferTabOffersLnk: Lnk | null;
  newlyAddedCoupons: CouponWithImage[];
  cardItemCouponLnk: Lnk | null;
  brandOfferIds: number[];
  offerListOffersLnk: Lnk | null;
  bankOffers: Array<{ bankId: number; subtitle: string | null }>;
  bankItemBankLnk: Lnk | null;
}

/** Newest published coupons that HAVE an image, with the image's file id.
 *  extraJoin/extraWhere refine the pool (category membership, brand link). */
async function newestCouponsWithImage(
  limit: number,
  extraJoin = "",
  extraWhere = "",
  params: unknown[] = []
): Promise<CouponWithImage[]> {
  const rows = await pgQuery<{ id: number; file_id: number }>(
    `SELECT c.id, MIN(m.file_id) AS file_id
     FROM "coupons" c
     JOIN "files_related_mph" m
       ON m.related_id = c.id
      AND m.related_type = 'api::coupon.coupon'
      AND m.field = 'image'
     ${extraJoin}
     WHERE c.published_at IS NOT NULL
       AND c.content_status = 'published'
       ${extraWhere}
     GROUP BY c.id, c.published_at
     ORDER BY c.published_at DESC
     LIMIT ${Number(limit)}`,
    params
  );
  return rows.map((r) => ({ couponId: r.id, imageFileId: r.file_id }));
}

async function categoryIdBySlug(slug: string): Promise<number | null> {
  const rows = await pgQuery<{ id: number }>(
    `SELECT id FROM "categories" WHERE slug = $1 AND published_at IS NOT NULL LIMIT 1`,
    [slug]
  );
  return rows[0]?.id ?? null;
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

  // draftAndPublish=false → single published row
  const homepageId = await insertRow("homepages", {
    document_id: documentId,
    title: "Homepage",
    latest_insights_enabled: false,
    published_at: now,
    created_at: now,
    updated_at: now,
    locale: null,
  });

  const sectionCounts = await buildHomepageTree(homepageId, data, true);

  logger.info("homepage seeded");
  summary.push(`homepage: seeded — ${sectionCounts.join(", ")}`);
}

async function gatherHomepageData(
  curatedStores: StoreRow[],
  exploreCategories: CategoryRow[]
): Promise<HomepageData> {
  // ── hero banners from WP ACF options repeater ──
  const banners = await parseSliderBanners();

  // ── hero products: newest published deals ──
  const heroDeals = await pgQuery<{ id: number }>(
    `SELECT id FROM "deals"
     WHERE published_at IS NOT NULL
       AND content_status = 'published'
     ORDER BY published_at DESC
     LIMIT ${HOMEPAGE_SEED_LIMITS.heroProducts}`
  );

  // ── topOffers: newest published coupons (image required by the schema,
  //    so only coupons with art qualify — 97% of the catalog) ──
  let topOfferCoupons: CouponWithImage[] = [];
  if (hasTable("coupons") && hasTable("files_related_mph")) {
    topOfferCoupons = await newestCouponsWithImage(HOMEPAGE_SEED_LIMITS.topOffers);
  } else {
    logger.warn("coupons/files tables not found — topOffers section will be empty");
  }

  // ── topDeals: newest published deals from the Deals Of The Day
  //    category; falls back to newest deals when the category or its link
  //    table is unavailable ──
  const dealsCategoriesLnk = await detectLnk("deals", "categories", "category");
  const dealOfTheDayId = await categoryIdBySlug("deal-of-the-day");
  let topDeals: Array<{ id: number }> = [];
  if (dealsCategoriesLnk && dealOfTheDayId != null) {
    topDeals = await pgQuery<{ id: number }>(
      `SELECT d.id FROM "deals" d
       JOIN "${dealsCategoriesLnk.table}" l
         ON l."${dealsCategoriesLnk.sourceCol}" = d.id
        AND l."${dealsCategoriesLnk.targetCol}" = $1
       WHERE d.published_at IS NOT NULL
         AND d.content_status = 'published'
       ORDER BY d.published_at DESC
       LIMIT ${HOMEPAGE_SEED_LIMITS.topDeals}`,
      [dealOfTheDayId]
    );
  }
  if (topDeals.length === 0) {
    logger.warn(
      "topDeals: 'deal-of-the-day' category empty or missing — falling back to newest deals"
    );
    topDeals = await pgQuery<{ id: number }>(
      `SELECT id FROM "deals"
       WHERE published_at IS NOT NULL
         AND content_status = 'published'
       ORDER BY published_at DESC
       LIMIT ${HOMEPAGE_SEED_LIMITS.topDeals}`
    );
  }

  // ── cgExclusive: newest coupons from the Exclusive Coupons category;
  //    newlyAdded: newest coupons of any kind. Counts come from
  //    HOMEPAGE_SEED_LIMITS. Both slots require an image, reused from the
  //    coupon. ──
  let exclusiveCoupons: CouponWithImage[] = [];
  let newlyAddedCoupons: CouponWithImage[] = [];
  if (hasTable("coupons") && hasTable("files_related_mph")) {
    const couponsCategoriesLnkForExclusive = await detectLnk(
      "coupons",
      "categories",
      "category"
    );
    const exclusiveCategoryId = await categoryIdBySlug("exclusive-coupons");
    if (couponsCategoriesLnkForExclusive && exclusiveCategoryId != null) {
      exclusiveCoupons = await newestCouponsWithImage(
        HOMEPAGE_SEED_LIMITS.cgExclusive,
        `JOIN "${couponsCategoriesLnkForExclusive.table}" cat
           ON cat."${couponsCategoriesLnkForExclusive.sourceCol}" = c.id
          AND cat."${couponsCategoriesLnkForExclusive.targetCol}" = $1`,
        "",
        [exclusiveCategoryId]
      );
    }
    if (exclusiveCoupons.length === 0) {
      logger.warn(
        "cgExclusive: 'exclusive-coupons' category empty or missing — section may be sparse"
      );
    }

    newlyAddedCoupons = await newestCouponsWithImage(HOMEPAGE_SEED_LIMITS.newlyAdded);
  } else {
    logger.warn(
      "coupons/files tables not found — cgExclusive/newlyAdded sections will be skipped"
    );
  }

  // ── exploreOffers tabs: categories + their newest Coupon entities ──
  const exploreOfferTabs: Array<{ category: CategoryRow; couponIds: number[] }> = [];
  const couponsCategoriesLnk = await detectLnk("coupons", "categories", "category");
  if (!couponsCategoriesLnk) {
    logger.warn(
      "coupons_categories_lnk not found — exploreOffers tabs will have no offers; section skipped"
    );
  } else {
    for (const category of exploreCategories) {
      const coupons = await pgQuery<{ id: number }>(
        `SELECT c.id FROM "coupons" c
         JOIN "${couponsCategoriesLnk.table}" l
           ON l."${couponsCategoriesLnk.sourceCol}" = c.id
          AND l."${couponsCategoriesLnk.targetCol}" = $1
         WHERE c.published_at IS NOT NULL
           AND c.content_status = 'published'
         ORDER BY c.published_at DESC
         LIMIT ${HOMEPAGE_SEED_LIMITS.exploreOffersPerTab}`,
        [category.id]
      );
      if (coupons.length === 0) {
        logger.info(
          `exploreOffers: category '${category.slug}' has 0 published coupons — tab skipped`
        );
        continue;
      }
      exploreOfferTabs.push({ category, couponIds: coupons.map((r) => r.id) });
    }
  }

  // ── offersByBrand: newest published Coupon entities with a brand relation ──
  let brandOfferIds: number[] = [];
  const couponsBrandsLnk = await detectLnk("coupons", "brands", "brand");
  if (couponsBrandsLnk) {
    const rows = await pgQuery<{ id: number }>(
      `SELECT c.id FROM "coupons" c
       WHERE c.published_at IS NOT NULL
         AND c.content_status = 'published'
         AND EXISTS (
           SELECT 1 FROM "${couponsBrandsLnk.table}" b
           WHERE b."${couponsBrandsLnk.sourceCol}" = c.id
         )
       ORDER BY c.published_at DESC
       LIMIT ${HOMEPAGE_SEED_LIMITS.offersByBrand}`
    );
    brandOfferIds = rows.map((r) => r.id);
  } else {
    logger.warn("coupons_brands_lnk not found — offersByBrand section skipped");
  }

  // ── bankOffers: up to the component-schema maximum of 32 published
  //    banks. Banks with the most published coupons come first; zero-coupon
  //    banks trail alphabetically. ──
  let bankOffers: Array<{ bankId: number; subtitle: string | null }> = [];
  if (hasTable("banks")) {
    const couponsBanksLnk = await detectLnk("coupons", "banks", "bank");
    const countJoin = couponsBanksLnk
      ? `LEFT JOIN "${couponsBanksLnk.table}" l ON l."${couponsBanksLnk.targetCol}" = b.id
         LEFT JOIN "coupons" c ON c.id = l."${couponsBanksLnk.sourceCol}"
           AND c.published_at IS NOT NULL
           AND c.content_status = 'published'`
      : "";
    const countExpr = couponsBanksLnk ? "COUNT(c.id)" : "0";
    const rows = await pgQuery<{ id: number; short_description: string | null }>(
      `SELECT b.id, b.short_description
       FROM "banks" b
       ${countJoin}
       WHERE b.published_at IS NOT NULL
       GROUP BY b.id, b.short_description, b.name
       ORDER BY ${countExpr} DESC, b.name ASC
       LIMIT $1`,
      [MAX_HOMEPAGE_BANK_OFFERS]
    );
    bankOffers = limitHomepageBankOffers(rows).map((r) => ({
      bankId: r.id,
      subtitle: truncate(clean(r.short_description), 80),
    }));
  } else {
    logger.warn("banks table not found — bankOffers section skipped");
  }

  return {
    banners,
    heroDealIds: heroDeals.map((r) => r.id),
    heroDealLnk: await detectLnk("components_home_hero_products", "deal", "deal"),
    popularFeatured: curatedStores[0] ?? null,
    popularStores: curatedStores.slice(1, 1 + HOMEPAGE_SEED_LIMITS.popularStores),
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
    topOfferCoupons,
    topOfferCouponLnk: await detectLnk(
      "components_home_top_offer_items",
      "coupon",
      "coupon"
    ),
    topDealIds: topDeals.map((r) => r.id),
    dealListDealsLnk: await detectLnk("components_home_deal_lists", "deals", "deal"),
    exclusiveCoupons,
    exclusiveCouponLnk: await detectLnk(
      "components_home_exclusive_items",
      "coupon",
      "coupon"
    ),
    exploreOfferTabs,
    exploreOfferTabCategoryLnk: await detectLnk(
      "components_home_explore_offer_tabs",
      "category",
      "category"
    ),
    exploreOfferTabOffersLnk: await detectLnk(
      "components_home_explore_offer_tabs",
      "offers",
      "coupon"
    ),
    newlyAddedCoupons,
    cardItemCouponLnk: await detectLnk(
      "components_home_coupon_card_items",
      "coupon",
      "coupon"
    ),
    brandOfferIds,
    offerListOffersLnk: await detectLnk(
      "components_home_offer_lists",
      "offers",
      "coupon"
    ),
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
        // mobileImage was removed from homepage.slider-slide — responsive
        // sizing now comes from the upload-time variants of desktopImage.
        await linkMedia(b.desktopFileId, slideId, "homepage.slider-slide", "desktopImage");
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

  // ── topOffers: newest coupons, each item reusing the coupon's image as the
  //    banner (schema requires one; editors can swap in 584×354 art later) ──
  if (
    missingTables(
      "components_home_top_offers",
      "components_home_top_offer_items",
      "components_home_top_offers_cmps"
    ).length === 0 &&
    data.topOfferCouponLnk &&
    data.topOfferCoupons.length > 0
  ) {
    const id = await insertRow("components_home_top_offers", {
      enabled: true,
      heading: "Top Offers",
    });
    await addCmp("homepages_cmps", homepageId, id, "home.top-offers", "topOffers", 1);
    for (let i = 0; i < data.topOfferCoupons.length; i++) {
      const offer = data.topOfferCoupons[i];
      const itemId = await insertRow("components_home_top_offer_items", {});
      await addCmp(
        "components_home_top_offers_cmps",
        id,
        itemId,
        "home.top-offer-item",
        "items",
        i + 1
      );
      await linkRel(data.topOfferCouponLnk, itemId, offer.couponId);
      await linkMedia(offer.imageFileId, itemId, "home.top-offer-item", "banner");
    }
    counts.push(`topOffers(${data.topOfferCoupons.length} items)`);
  } else if (missingTables("components_home_top_offers").length === 0) {
    const id = await insertRow("components_home_top_offers", { enabled: false });
    await addCmp("homepages_cmps", homepageId, id, "home.top-offers", "topOffers", 1);
    skip("topOffers: no coupons with images or item tables missing — section disabled");
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
  if (data.exclusiveCoupons.length === 0) {
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
    for (let i = 0; i < data.exclusiveCoupons.length; i++) {
      const offer = data.exclusiveCoupons[i];
      const itemId = await insertRow("components_home_exclusive_items", {});
      await addCmp(
        "components_home_cg_exclusives_cmps",
        id,
        itemId,
        "home.exclusive-item",
        "items",
        i + 1
      );
      await linkRel(data.exclusiveCouponLnk, itemId, offer.couponId);
      // bannerOverride is validator-required (768×370) — reuse the coupon art.
      await linkMedia(offer.imageFileId, itemId, "home.exclusive-item", "bannerOverride");
    }
    counts.push(`cgExclusive(${data.exclusiveCoupons.length} items)`);
  } else {
    skip("cg-exclusive component tables/link missing — cgExclusive skipped");
    counts.push("cgExclusive(skipped)");
  }

  // ── exploreOffers (Coupon schema only) ──
  if (data.exploreOfferTabs.length === 0) {
    if (logSkips) logger.info("exploreOffers: no tabs with coupons — section skipped");
    counts.push("exploreOffers(skipped: 0 tabs)");
  } else if (
    missingTables(
      "components_home_explore_offers",
      "components_home_explore_offer_tabs",
      "components_home_explore_offers_cmps"
    ).length === 0 &&
    data.exploreOfferTabCategoryLnk &&
    data.exploreOfferTabOffersLnk
  ) {
    const id = await insertRow("components_home_explore_offers", {
      enabled: true,
      heading: "Explore Offers",
    });
    await addCmp("homepages_cmps", homepageId, id, "home.explore-offers", "exploreOffers", 1);
    for (let i = 0; i < data.exploreOfferTabs.length; i++) {
      const tab = data.exploreOfferTabs[i];
      const tabId = await insertRow("components_home_explore_offer_tabs", {});
      await addCmp(
        "components_home_explore_offers_cmps",
        id,
        tabId,
        "home.explore-offer-tab",
        "tabs",
        i + 1
      );
      await linkRel(data.exploreOfferTabCategoryLnk, tabId, tab.category.id);
      for (let j = 0; j < tab.couponIds.length; j++) {
        await linkRel(data.exploreOfferTabOffersLnk, tabId, tab.couponIds[j], j + 1);
      }
    }
    counts.push(`exploreOffers(${data.exploreOfferTabs.length} tabs)`);
  } else {
    skip("explore-offers component tables/links missing — exploreOffers skipped");
    counts.push("exploreOffers(skipped)");
  }

  // ── newlyAdded (Fresh Drops) ──
  if (data.newlyAddedCoupons.length === 0) {
    if (logSkips) logger.info("newlyAdded: 0 coupons with images — section skipped");
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
    for (let i = 0; i < data.newlyAddedCoupons.length; i++) {
      const offer = data.newlyAddedCoupons[i];
      const itemId = await insertRow("components_home_coupon_card_items", {});
      await addCmp(
        "components_home_newly_addeds_cmps",
        id,
        itemId,
        "home.coupon-card-item",
        "items",
        i + 1
      );
      await linkRel(data.cardItemCouponLnk, itemId, offer.couponId);
      // cardImage is schema-required (354×646) — reuse the coupon art.
      await linkMedia(offer.imageFileId, itemId, "home.coupon-card-item", "cardImage");
    }
    counts.push(`newlyAdded(${data.newlyAddedCoupons.length} items)`);
  } else {
    skip("newly-added component tables/link missing — newlyAdded skipped");
    counts.push("newlyAdded(skipped)");
  }

  // ── offersByBrand (Coupon schema only) ──
  counts.push(
    await buildOfferList(
      homepageId,
      "offersByBrand",
      "Offers By Brand",
      data.brandOfferIds,
      data.offerListOffersLnk,
      skip
    )
  );

  // ── bankOffers ──
  if (data.bankOffers.length === 0) {
    if (logSkips) logger.info("bankOffers: 0 published banks — section skipped");
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

// Deal-list and offer-list sections share one structure; only the component
// tables/uid and the item noun differ.
const LIST_KINDS = {
  deal: { table: "components_home_deal_lists", uid: "home.deal-list", noun: "deals" },
  offer: { table: "components_home_offer_lists", uid: "home.offer-list", noun: "coupons" },
} as const;

async function buildList(
  kind: keyof typeof LIST_KINDS,
  homepageId: number,
  field: string,
  heading: string | null,
  itemIds: number[],
  itemsLnk: Lnk | null,
  skip: (msg: string) => void
): Promise<string> {
  const { table, uid, noun } = LIST_KINDS[kind];
  if (missingTables(table).length > 0) {
    skip(`${table} missing — ${field} skipped`);
    return `${field}(skipped)`;
  }
  const id = await insertRow(table, { enabled: true, heading });
  await addCmp("homepages_cmps", homepageId, id, uid, field, 1);
  if (itemsLnk) {
    for (let i = 0; i < itemIds.length; i++) {
      await linkRel(itemsLnk, id, itemIds[i], i + 1);
    }
  } else if (itemIds.length > 0) {
    skip(`${uid} ${noun} link table not found — ${field} relation skipped`);
  }
  return `${field}(${itemIds.length} ${noun})`;
}

async function buildDealList(
  homepageId: number,
  field: string,
  heading: string | null,
  dealIds: number[],
  dealsLnk: Lnk | null,
  skip: (msg: string) => void
): Promise<string> {
  return buildList("deal", homepageId, field, heading, dealIds, dealsLnk, skip);
}

async function buildOfferList(
  homepageId: number,
  field: string,
  heading: string | null,
  couponIds: number[],
  offersLnk: Lnk | null,
  skip: (msg: string) => void
): Promise<string> {
  return buildList("offer", homepageId, field, heading, couponIds, offersLnk, skip);
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
    // mobileImage was removed from homepage.slider-slide (responsive sizing
    // comes from upload-time variants) — WP mobile-slide subfields are ignored.
    const desktopRef = pick(subs, (k) => !k.includes("mobile") && isImageKey(k));
    const link = pick(subs, (k) => k.includes("link") || k.includes("url"));
    const alt = pick(subs, (k) => k.includes("alt") || k.includes("caption"));

    const desktopFileId = await resolveMediaRef(desktopRef);
    if (!desktopFileId) {
      logger.warn(
        `hero banner ${idx}: desktop image '${desktopRef ?? "(missing)"}' did not migrate — row skipped`
      );
      continue;
    }

    banners.push({
      desktopFileId,
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
       AND c.content_status = 'published'
     GROUP BY s.id, s.name
     ORDER BY COUNT(*) DESC
     LIMIT ${1 + HOMEPAGE_SEED_LIMITS.popularStores}`
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

interface MenuChildCategory {
  id: number;
  name: string;
}

async function getMenuChildCategoriesByParent(): Promise<
  Map<number, MenuChildCategory[]>
> {
  const terms = await wpQuery<{
    term_id: number;
    name: string;
    parent: number;
    choose_type: string | null;
  }>(`
    SELECT
      t.term_id,
      t.name,
      tt.parent,
      MAX(CASE WHEN tm.meta_key = 'choose_type' THEN tm.meta_value END) AS choose_type
    FROM wp_terms t
    JOIN wp_term_taxonomy tt
      ON tt.term_id = t.term_id
     AND tt.taxonomy = 'category'
    LEFT JOIN wp_termmeta tm
      ON tm.term_id = t.term_id
     AND tm.meta_key = 'choose_type'
    GROUP BY t.term_id, t.name, tt.parent
    ORDER BY t.term_id
  `);

  const byParent = new Map<number, MenuChildCategory[]>();
  for (const term of terms) {
    if (term.choose_type !== "Category" || !term.parent) continue;
    const [parent, child] = await Promise.all([
      ensureTermMapping(term.parent),
      ensureTermMapping(term.term_id),
    ]);
    if (parent?.table !== "categories" || child?.table !== "categories") {
      continue;
    }

    const siblings = byParent.get(parent.id) ?? [];
    if (!siblings.some((candidate) => candidate.id === child.id)) {
      siblings.push({ id: child.id, name: clean(term.name) || term.name });
      byParent.set(parent.id, siblings);
    }
  }
  return byParent;
}

// ─────────────────────────────────────────────────────────────────────
// menu
// ─────────────────────────────────────────────────────────────────────

async function seedMenu(
  summary: string[],
  curatedStores: StoreRow[],
  exploreCategories: CategoryRow[]
): Promise<void> {
  const missing = missingTables(
    "menus",
    "menus_cmps",
    "components_nav_links",
    "components_header_search_top_stores",
    "components_header_search_suggestions"
  );
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
    title: "Menu",
    top_stores_label: "Top Stores",
    top_stores_title: "All Stores",
    top_stores_view_all_url: "/stores/",
    categories_label: "Categories",
    categories_title: "All Categories",
    categories_popular_stores_title: "Popular Stores",
    categories_view_all_url: "/categories/",
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

  // ── searchTopStores (independent header selection, max 8) ──
  let searchTopStoreCount = 0;
  const searchTopStoreLnk = await detectLnk(
    "components_header_search_top_stores",
    "store",
    "store"
  );
  if (searchTopStoreLnk) {
    const searchTopStores = curatedStores.slice(0, 8);
    for (let i = 0; i < searchTopStores.length; i++) {
      const componentId = await insertRow(
        "components_header_search_top_stores",
        {}
      );
      await linkRel(searchTopStoreLnk, componentId, searchTopStores[i].id);
      await addCmp(
        "menus_cmps",
        menuId,
        componentId,
        "header.search-top-store",
        "searchTopStores",
        i + 1
      );
      searchTopStoreCount++;
    }
  } else {
    logger.warn(
      "header search top-store relation table not found — searchTopStores skipped"
    );
  }

  // ── searchSuggestions (editor-managed text + validated URL) ──
  let searchSuggestionCount = 0;
  for (let i = 0; i < HEADER_SEARCH_SUGGESTIONS.length; i++) {
    const suggestion = HEADER_SEARCH_SUGGESTIONS[i];
    const componentId = await insertRow(
      "components_header_search_suggestions",
      suggestion
    );
    await addCmp(
      "menus_cmps",
      menuId,
      componentId,
      "header.search-suggestion",
      "searchSuggestions",
      i + 1
    );
    searchSuggestionCount++;
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
  const navLinkCategoryLnk = await detectLnk(
    "components_nav_links",
    "category",
    "category"
  );
  const childCategoriesByParent = await getMenuChildCategoriesByParent();

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

      // Mobile drill-down rows are immediate child Categories, matching the
      // shared desktop hierarchy. Their Category icons become the default;
      // editors can upload per-link overrides from the Menu panel.
      if (navLinkCategoryLnk) {
        const children = (childCategoriesByParent.get(category.id) ?? []).slice(
          0,
          9
        );
        for (let j = 0; j < children.length; j++) {
          const linkId = await insertRow("components_nav_links", {
            label: children[j].name,
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
          await linkRel(navLinkCategoryLnk, linkId, children[j].id);
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
    `menu: seeded (${topStoreCount} topStores, ${searchTopStoreCount} searchTopStores, ${searchSuggestionCount} searchSuggestions, ${sectionCount} categorySections, ${extraCount} extraItems)`
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
    title: "Footer",
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

  // ── countries (Phase 13b uploads and attaches the packaged flag media) ──
  let countryCount = 0;
  if (missingTables("components_footer_countries").length === 0) {
    for (let i = 0; i < FOOTER_COUNTRIES.length; i++) {
      const country = FOOTER_COUNTRIES[i];
      const id = await insertRow("components_footer_countries", {
        code: country.code,
        name: country.name,
        url: country.url,
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
