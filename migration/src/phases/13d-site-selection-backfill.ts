import { pgQuery, pgTransaction } from "../db/pg-client.js";
import { insertLink } from "../utils/strapi-insert.js";
import { logger } from "../utils/logger.js";
import {
  HEADER_SEARCH_SUGGESTIONS,
  resolveLegacyPopularSearch,
  routeSlug,
  uniquePositiveIds,
  type PopularSearchCatalogs,
  type PopularSearchKind,
} from "../utils/site-selection-defaults.js";

type LinkTable = {
  table: string;
  sourceCol: string;
  targetCol: string;
  orderCols: string[];
};

let tables = new Set<string>();
const columns = new Map<string, string[]>();

async function loadSchema(): Promise<void> {
  const rows = await pgQuery<{ table_name: string }>(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = current_schema()`,
  );
  tables = new Set(rows.map((row) => row.table_name));
  columns.clear();
}

async function tableColumns(table: string): Promise<string[]> {
  const cached = columns.get(table);
  if (cached) return cached;
  const rows = await pgQuery<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1`,
    [table],
  );
  const result = rows.map((row) => row.column_name);
  columns.set(table, result);
  return result;
}

async function detectLink(
  baseTable: string,
  attribute: string,
  target: string,
): Promise<LinkTable | null> {
  const conventional = `${baseTable}_${attribute}_lnk`;
  const suffix = `_${attribute}_lnk`;
  const table = tables.has(conventional)
    ? conventional
    : [...tables].find(
        (candidate) =>
          candidate.endsWith(suffix) &&
          candidate.startsWith(
            baseTable.slice(0, Math.min(baseTable.length, 20)),
          ),
      );
  if (!table) return null;

  const allColumns = await tableColumns(table);
  const idColumns = allColumns.filter((column) => column.endsWith("_id"));
  const targetCol =
    idColumns.find((column) => column === `${target}_id`) ??
    idColumns.find((column) => column.includes(target));
  const sourceCol = idColumns.find((column) => column !== targetCol);
  if (!sourceCol || !targetCol) return null;
  return {
    table,
    sourceCol,
    targetCol,
    orderCols: allColumns.filter(
      (column) => column.endsWith("_ord") || column === "order",
    ),
  };
}

async function linkedIds(
  relation: LinkTable | null,
  sourceId: number,
): Promise<number[]> {
  if (!relation) return [];
  const order = relation.orderCols[0]
    ? `ORDER BY "${relation.orderCols[0]}", "${relation.targetCol}"`
    : `ORDER BY "${relation.targetCol}"`;
  const rows = await pgQuery<{ id: number }>(
    `SELECT "${relation.targetCol}" AS id
       FROM "${relation.table}"
      WHERE "${relation.sourceCol}" = $1
      ${order}`,
    [sourceId],
  );
  return uniquePositiveIds(rows.map((row) => row.id));
}

async function addRelation(
  relation: LinkTable,
  sourceId: number,
  targetId: number,
  order: number,
): Promise<void> {
  const values: Record<string, number> = {
    [relation.sourceCol]: sourceId,
    [relation.targetCol]: targetId,
  };
  for (const column of relation.orderCols) values[column] = order;
  await insertLink(relation.table, values);
}

async function componentIds(parentTable: string, parentId: number, field: string) {
  if (!tables.has(parentTable)) return [];
  return pgQuery<{ cmp_id: number }>(
    `SELECT cmp_id
       FROM "${parentTable}"
      WHERE entity_id = $1
        AND field = $2
      ORDER BY "order", cmp_id`,
    [parentId, field],
  );
}

async function insertComponent(
  parentTable: string,
  parentId: number,
  componentTable: string,
  componentType: string,
  field: string,
  order: number,
  values: Record<string, string | boolean> = {},
): Promise<number> {
  const fields = Object.keys(values);
  const row = fields.length
    ? await pgQuery<{ id: number }>(
        `INSERT INTO "${componentTable}"
          (${fields.map((field) => `"${field}"`).join(", ")})
         VALUES (${fields.map((_, index) => `$${index + 1}`).join(", ")})
         RETURNING id`,
        fields.map((field) => values[field]),
      )
    : await pgQuery<{ id: number }>(
        `INSERT INTO "${componentTable}" DEFAULT VALUES RETURNING id`,
      );
  const componentId = row[0].id;
  await pgQuery(
    `INSERT INTO "${parentTable}"
       (entity_id, cmp_id, component_type, field, "order")
     VALUES ($1, $2, $3, $4, $5)`,
    [parentId, componentId, componentType, field, order],
  );
  return componentId;
}

async function entityCatalogs(): Promise<PopularSearchCatalogs> {
  const result = {} as Record<PopularSearchKind, Map<string, number>>;
  for (const kind of ["store", "brand", "category", "bank"] as const) {
    const table = kind === "category" ? "categories" : `${kind}s`;
    const rows = tables.has(table)
      ? await pgQuery<{ id: number; slug: string }>(
          `SELECT id, slug FROM "${table}" WHERE slug IS NOT NULL`,
        )
      : [];
    const catalog = new Map<string, number>();
    for (const row of rows) {
      const slug = routeSlug(`/${row.slug}/`);
      if (slug && !catalog.has(slug)) catalog.set(slug, row.id);
    }
    result[kind] = catalog;
  }
  return result;
}

async function globalPopularStoreIds(): Promise<number[]> {
  const counts = new Map<number, number>();
  for (const offer of ["coupon", "deal"] as const) {
    const offerTable = `${offer}s`;
    const relation = await detectLink(offerTable, "stores", "store");
    if (!relation || !tables.has(offerTable)) continue;
    const rows = await pgQuery<{ id: number; total: string }>(
      `SELECT l."${relation.targetCol}" AS id,
              COUNT(DISTINCT l."${relation.sourceCol}")::text AS total
         FROM "${relation.table}" l
         JOIN "${offerTable}" o
           ON o.id = l."${relation.sourceCol}"
        WHERE o.published_at IS NOT NULL
          AND o.content_status = 'published'
          AND (o.scheduled_at IS NULL OR o.scheduled_at <= NOW())
          AND (o.expires_at IS NULL OR o.expires_at > NOW())
        GROUP BY l."${relation.targetCol}"`,
    );
    for (const row of rows) {
      counts.set(row.id, (counts.get(row.id) ?? 0) + Number(row.total));
    }
  }
  const names = tables.has("stores")
    ? await pgQuery<{ id: number; name: string }>(
        `SELECT id, name
           FROM "stores"
          WHERE published_at IS NOT NULL
          ORDER BY name, id`,
      )
    : [];
  const nameById = new Map(names.map((row) => [row.id, row.name]));
  const ranked = [...counts]
    .sort(
      ([leftId, left], [rightId, right]) =>
        right - left ||
        (nameById.get(leftId) ?? "").localeCompare(
          nameById.get(rightId) ?? "",
        ) ||
        leftId - rightId,
    )
    .map(([id]) => id)
    .slice(0, 10);
  return uniquePositiveIds(ranked, names.map((row) => row.id)).slice(0, 10);
}

async function menuDefaultStoreIds(menuId: number): Promise<number[]> {
  const topStores = await detectLink("menus", "top_stores", "store");
  return uniquePositiveIds(
    await linkedIds(topStores, menuId),
    await globalPopularStoreIds(),
  ).slice(0, 8);
}

async function backfillMenuSearch(): Promise<{
  stores: number;
  suggestions: number;
}> {
  const required = [
    "menus",
    "menus_cmps",
    "components_header_search_top_stores",
    "components_header_search_suggestions",
  ];
  const missing = required.filter((table) => !tables.has(table));
  if (missing.length) {
    throw new Error(
      `Phase 13d requires ${missing.join(", ")}. Start Strapi once with the latest schema before rerunning.`,
    );
  }
  const storeRelation = await detectLink(
    "components_header_search_top_stores",
    "store",
    "store",
  );
  if (!storeRelation) {
    throw new Error(
      "Phase 13d cannot find the search-top-store relation table. Start Strapi once with the latest schema before rerunning.",
    );
  }

  let stores = 0;
  let suggestions = 0;
  const menus = await pgQuery<{ id: number }>(`SELECT id FROM "menus"`);
  for (const menu of menus) {
    if (
      (await componentIds("menus_cmps", menu.id, "searchTopStores")).length ===
      0
    ) {
      const ids = await menuDefaultStoreIds(menu.id);
      for (let index = 0; index < ids.length; index++) {
        const componentId = await insertComponent(
          "menus_cmps",
          menu.id,
          "components_header_search_top_stores",
          "header.search-top-store",
          "searchTopStores",
          index + 1,
        );
        await addRelation(storeRelation, componentId, ids[index], 1);
        stores += 1;
      }
    }

    if (
      (await componentIds("menus_cmps", menu.id, "searchSuggestions")).length ===
      0
    ) {
      for (let index = 0; index < HEADER_SEARCH_SUGGESTIONS.length; index++) {
        await insertComponent(
          "menus_cmps",
          menu.id,
          "components_header_search_suggestions",
          "header.search-suggestion",
          "searchSuggestions",
          index + 1,
          HEADER_SEARCH_SUGGESTIONS[index],
        );
        suggestions += 1;
      }
    }
  }
  return { stores, suggestions };
}

async function backfillHomepagePopularSearches(
  fallbackStoreIds: readonly number[],
): Promise<number> {
  if (
    !tables.has("homepages_cmps") ||
    !tables.has("components_home_popular_searches")
  ) {
    throw new Error(
      "Phase 13d requires the Homepage Popular Searches component tables. Start Strapi once with the latest schema before rerunning.",
    );
  }
  const newRelations = {
    store: await detectLink(
      "components_home_popular_searches",
      "stores",
      "store",
    ),
    brand: await detectLink(
      "components_home_popular_searches",
      "brands",
      "brand",
    ),
    category: await detectLink(
      "components_home_popular_searches",
      "categories",
      "category",
    ),
    bank: await detectLink(
      "components_home_popular_searches",
      "banks",
      "bank",
    ),
  };
  const missingRelations = (Object.keys(newRelations) as PopularSearchKind[])
    .filter((kind) => !newRelations[kind]);
  if (missingRelations.length) {
    throw new Error(
      `Phase 13d cannot find Homepage Popular Searches relations for: ${missingRelations.join(", ")}.`,
    );
  }

  const legacyParent = "components_home_popular_searches_cmps";
  const legacyStore = await detectLink("components_nav_links", "store", "store");
  const legacyCategory = await detectLink(
    "components_nav_links",
    "category",
    "category",
  );
  const catalogs = await entityCatalogs();
  const homepages = tables.has("homepages")
    ? await pgQuery<{ id: number }>(`SELECT id FROM "homepages" ORDER BY id`)
    : [];
  for (const homepage of homepages) {
    if (
      (await componentIds("homepages_cmps", homepage.id, "popularSearches"))
        .length > 0
    ) {
      continue;
    }
    await insertComponent(
      "homepages_cmps",
      homepage.id,
      "components_home_popular_searches",
      "home.popular-searches",
      "popularSearches",
      1,
      {
        enabled: fallbackStoreIds.length > 0,
        heading: "Popular Searches",
      },
    );
  }
  const components = await pgQuery<{ cmp_id: number }>(
    `SELECT DISTINCT cmp_id
       FROM "homepages_cmps"
      WHERE field = 'popularSearches'
        AND component_type = 'home.popular-searches'`,
  );
  let linked = 0;

  for (const component of components) {
    const alreadyConfigured = await Promise.all(
      (Object.keys(newRelations) as PopularSearchKind[]).map((kind) =>
        linkedIds(newRelations[kind], component.cmp_id),
      ),
    );
    if (alreadyConfigured.some((ids) => ids.length > 0)) continue;

    const targets: Record<PopularSearchKind, number[]> = {
      store: [],
      brand: [],
      category: [],
      bank: [],
    };
    const legacyLinks = tables.has(legacyParent)
      ? await componentIds(legacyParent, component.cmp_id, "links")
      : [];
    for (const legacy of legacyLinks) {
      const rows = await pgQuery<{ url: string | null }>(
        `SELECT url FROM "components_nav_links" WHERE id = $1`,
        [legacy.cmp_id],
      );
      const target = resolveLegacyPopularSearch(
        {
          url: rows[0]?.url,
          storeIds: await linkedIds(legacyStore, legacy.cmp_id),
          categoryIds: await linkedIds(legacyCategory, legacy.cmp_id),
        },
        catalogs,
      );
      if (target && !targets[target.kind].includes(target.id)) {
        targets[target.kind].push(target.id);
      }
    }

    if ((Object.values(targets) as number[][]).every((ids) => ids.length === 0)) {
      targets.store.push(...fallbackStoreIds.slice(0, 10));
    }
    for (const kind of Object.keys(targets) as PopularSearchKind[]) {
      const relation = newRelations[kind]!;
      for (let index = 0; index < targets[kind].length; index++) {
        await addRelation(
          relation,
          component.cmp_id,
          targets[kind][index],
          index + 1,
        );
        linked += 1;
      }
    }
  }
  return linked;
}

/**
 * Compatibility phase for installations that checkpointed Phase 13 before
 * Homepage Popular Searches and the search overlay gained their current CMS
 * relations. Existing editor selections always win; only empty fields fill.
 */
export async function runSiteSelectionBackfill(): Promise<void> {
  logger.info("=== Phase 13d: Homepage and search selections ===");
  await loadSchema();
  await pgTransaction(async () => {
    const menus = tables.has("menus")
      ? await pgQuery<{ id: number }>(`SELECT id FROM "menus" ORDER BY id LIMIT 1`)
      : [];
    const fallbackStoreIds = menus[0]
      ? await menuDefaultStoreIds(menus[0].id)
      : (await globalPopularStoreIds()).slice(0, 8);
    const menu = await backfillMenuSearch();
    const popularSearchLinks =
      await backfillHomepagePopularSearches(fallbackStoreIds);
    logger.info(
      `Site selection backfill complete: ${popularSearchLinks} homepage relation(s), ` +
        `${menu.stores} search store(s), ${menu.suggestions} suggestion(s) added`,
    );
  });
}
