"use strict";

const HEADER_SEARCH_SUGGESTIONS = [
  { text: "Amazon Coupons", url: "/search/?q=Amazon" },
  { text: "Flipkart Offers", url: "/search/?q=Flipkart" },
  { text: "Myntra Coupons", url: "/search/?q=Myntra" },
  { text: "Today’s Deals", url: "/deal-of-the-day/" },
];
const KINDS = ["store", "brand", "category", "bank"];
const LEGACY_SNAPSHOT_TABLE = "site_selection_legacy_popular_searches";

function uniqueIds(...groups) {
  const seen = new Set();
  const result = [];
  for (const group of groups) {
    for (const raw of group) {
      const id = Number(raw);
      if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

function routeSlug(value) {
  if (!value) return null;
  let pathname;
  try {
    pathname = new URL(value, "https://www.couponzguru.com").pathname;
  } catch {
    return null;
  }
  const parts = pathname
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (
    parts.length > 1 &&
    ["store", "stores", "brand", "brands", "category", "categories", "bank", "banks"]
      .includes(parts[0])
  ) {
    parts.shift();
  }
  return parts.length === 1 ? parts[0] : null;
}

function resolveLegacyPopularSearch(link, catalogs) {
  const storeId = uniqueIds(link.storeIds || [])[0];
  if (storeId) return { kind: "store", id: storeId };
  const categoryId = uniqueIds(link.categoryIds || [])[0];
  if (categoryId) return { kind: "category", id: categoryId };
  const slug = routeSlug(link.url);
  if (!slug || slug === "deal-of-the-day") return null;
  const matches = KINDS.flatMap((kind) => {
    const id = catalogs[kind].get(slug);
    return id ? [{ kind, id }] : [];
  });
  return matches.length === 1 ? matches[0] : null;
}

async function relation(knex, table, target) {
  if (!(await knex.schema.hasTable(table))) return null;
  const info = await knex(table).columnInfo();
  const columns = Object.keys(info);
  const ids = columns.filter((column) => column.endsWith("_id"));
  const targetCol =
    ids.find((column) => column === `${target}_id`) ||
    ids.find((column) => column.includes(target));
  const sourceCol = ids.find((column) => column !== targetCol);
  if (!sourceCol || !targetCol) return null;
  return {
    table,
    sourceCol,
    targetCol,
    orderCols: columns.filter(
      (column) => column.endsWith("_ord") || column === "order",
    ),
  };
}

async function linkedIds(knex, link, sourceId) {
  if (!link) return [];
  let query = knex(link.table)
    .where(link.sourceCol, sourceId)
    .select({ id: link.targetCol });
  for (const column of link.orderCols) query = query.orderBy(column);
  query = query.orderBy(link.targetCol);
  return uniqueIds((await query).map((row) => row.id));
}

async function addRelation(knex, link, sourceId, targetId, order) {
  const row = {
    [link.sourceCol]: sourceId,
    [link.targetCol]: targetId,
  };
  for (const column of link.orderCols) row[column] = order;
  await knex(link.table).insert(row).onConflict().ignore();
}

async function componentIds(knex, table, entityId, field) {
  if (!(await knex.schema.hasTable(table))) return [];
  return knex(table)
    .where({ entity_id: entityId, field })
    .orderBy("order")
    .orderBy("cmp_id")
    .select("cmp_id");
}

async function insertComponent(
  knex,
  parentTable,
  parentId,
  componentTable,
  componentType,
  field,
  order,
  values = {},
) {
  const inserted = await knex(componentTable).insert(values).returning("id");
  const componentId = Number(inserted[0]?.id ?? inserted[0]);
  await knex(parentTable).insert({
    entity_id: parentId,
    cmp_id: componentId,
    component_type: componentType,
    field,
    order,
  });
  return componentId;
}

/**
 * User migrations run before schema sync. Capture the removed nested
 * nav.link rows while their tables still exist, then consume this snapshot
 * from the post-schema bootstrap reconciliation.
 */
async function snapshotLegacyPopularSearchesBeforeSchemaSync(knex) {
  const hasLegacy =
    (await knex.schema.hasTable("components_home_popular_searches_cmps")) &&
    (await knex.schema.hasTable("components_nav_links"));
  if (!hasLegacy) return 0;
  if (!(await knex.schema.hasTable(LEGACY_SNAPSHOT_TABLE))) {
    await knex.schema.createTable(LEGACY_SNAPSHOT_TABLE, (table) => {
      table.increments("id").primary();
      table.integer("popular_component_id").notNullable();
      table.integer("sort_order").notNullable();
      table.string("url");
      table.integer("store_id");
      table.integer("category_id");
      table.unique(["popular_component_id", "sort_order"]);
    });
  }
  const storeLink = await relation(
    knex,
    "components_nav_links_store_lnk",
    "store",
  );
  const categoryLink = await relation(
    knex,
    "components_nav_links_category_lnk",
    "category",
  );
  const rows = await knex("components_home_popular_searches_cmps as link")
    .join("components_nav_links as nav", "nav.id", "link.cmp_id")
    .where("link.field", "links")
    .orderBy("link.entity_id")
    .orderBy("link.order")
    .select({
      popular_component_id: "link.entity_id",
      legacy_link_id: "link.cmp_id",
      sort_order: "link.order",
      url: "nav.url",
    });
  for (const row of rows) {
    const storeIds = await linkedIds(knex, storeLink, row.legacy_link_id);
    const categoryIds = await linkedIds(
      knex,
      categoryLink,
      row.legacy_link_id,
    );
    await knex(LEGACY_SNAPSHOT_TABLE)
      .insert({
        popular_component_id: row.popular_component_id,
        sort_order: row.sort_order,
        url: row.url,
        store_id: storeIds[0] || null,
        category_id: categoryIds[0] || null,
      })
      .onConflict(["popular_component_id", "sort_order"])
      .ignore();
  }
  return rows.length;
}

async function entityCatalogs(knex) {
  const catalogs = {};
  for (const kind of KINDS) {
    const table = kind === "category" ? "categories" : `${kind}s`;
    const catalog = new Map();
    if (await knex.schema.hasTable(table)) {
      for (const row of await knex(table).whereNotNull("slug").select("id", "slug")) {
        const slug = routeSlug(`/${row.slug}/`);
        if (slug && !catalog.has(slug)) catalog.set(slug, Number(row.id));
      }
    }
    catalogs[kind] = catalog;
  }
  return catalogs;
}

async function globalPopularStoreIds(knex) {
  const counts = new Map();
  for (const offer of ["coupon", "deal"]) {
    const offerTable = `${offer}s`;
    const link = await relation(knex, `${offerTable}_stores_lnk`, "store");
    if (!link || !(await knex.schema.hasTable(offerTable))) continue;
    const rows = await knex(`${link.table} as link`)
      .join(`${offerTable} as offer`, "offer.id", `link.${link.sourceCol}`)
      .whereNotNull("offer.published_at")
      .where("offer.content_status", "published")
      .where((query) =>
        query
          .whereNull("offer.scheduled_at")
          .orWhere("offer.scheduled_at", "<=", knex.fn.now()),
      )
      .where((query) =>
        query
          .whereNull("offer.expires_at")
          .orWhere("offer.expires_at", ">", knex.fn.now()),
      )
      .select({ id: `link.${link.targetCol}` })
      .countDistinct({ total: `link.${link.sourceCol}` })
      .groupBy(`link.${link.targetCol}`);
    for (const row of rows) {
      const id = Number(row.id);
      counts.set(id, (counts.get(id) || 0) + Number(row.total));
    }
  }
  const stores = (await knex.schema.hasTable("stores"))
    ? await knex("stores")
        .whereNotNull("published_at")
        .orderBy("name")
        .orderBy("id")
        .select("id", "name")
    : [];
  const names = new Map(stores.map((store) => [Number(store.id), store.name]));
  const ranked = [...counts]
    .sort(
      ([leftId, left], [rightId, right]) =>
        right - left ||
        String(names.get(leftId) || "").localeCompare(
          String(names.get(rightId) || ""),
        ) ||
        leftId - rightId,
    )
    .map(([id]) => id);
  return uniqueIds(ranked, stores.map((store) => store.id)).slice(0, 10);
}

async function menuDefaultStoreIds(knex, menuId, globalStores) {
  const topStores = await relation(knex, "menus_top_stores_lnk", "store");
  return uniqueIds(
    await linkedIds(knex, topStores, menuId),
    globalStores,
  ).slice(0, 8);
}

async function backfillMenuSearch(knex, globalStores) {
  const required = [
    "menus",
    "menus_cmps",
    "components_header_search_top_stores",
    "components_header_search_suggestions",
    "components_header_search_top_stores_store_lnk",
  ];
  for (const table of required) {
    if (!(await knex.schema.hasTable(table))) {
      return { ready: false, stores: 0, suggestions: 0 };
    }
  }
  const storeLink = await relation(
    knex,
    "components_header_search_top_stores_store_lnk",
    "store",
  );
  if (!storeLink) return { ready: false, stores: 0, suggestions: 0 };

  let stores = 0;
  let suggestions = 0;
  for (const menu of await knex("menus").select("id")) {
    const selectedStores = await componentIds(
      knex,
      "menus_cmps",
      menu.id,
      "searchTopStores",
    );
    if (selectedStores.length === 0) {
      const defaults = await menuDefaultStoreIds(knex, menu.id, globalStores);
      for (let index = 0; index < defaults.length; index++) {
        const componentId = await insertComponent(
          knex,
          "menus_cmps",
          menu.id,
          "components_header_search_top_stores",
          "header.search-top-store",
          "searchTopStores",
          index + 1,
        );
        await addRelation(knex, storeLink, componentId, defaults[index], 1);
        stores += 1;
      }
    }

    const selectedSuggestions = await componentIds(
      knex,
      "menus_cmps",
      menu.id,
      "searchSuggestions",
    );
    if (selectedSuggestions.length === 0) {
      for (let index = 0; index < HEADER_SEARCH_SUGGESTIONS.length; index++) {
        await insertComponent(
          knex,
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
  return { ready: true, stores, suggestions };
}

async function backfillHomepagePopularSearches(knex, fallbackStores) {
  const required = [
    "homepages",
    "homepages_cmps",
    "components_home_popular_searches",
    ...KINDS.map(
      (kind) =>
        `components_home_popular_searches_${
          kind === "category" ? "categories" : `${kind}s`
        }_lnk`,
    ),
  ];
  for (const table of required) {
    if (!(await knex.schema.hasTable(table))) {
      return { ready: false, links: 0 };
    }
  }
  const newLinks = {};
  for (const kind of KINDS) {
    const attribute = kind === "category" ? "categories" : `${kind}s`;
    newLinks[kind] = await relation(
      knex,
      `components_home_popular_searches_${attribute}_lnk`,
      kind,
    );
    if (!newLinks[kind]) return { ready: false, links: 0 };
  }

  for (const homepage of await knex("homepages").select("id")) {
    const components = await componentIds(
      knex,
      "homepages_cmps",
      homepage.id,
      "popularSearches",
    );
    if (components.length === 0) {
      await insertComponent(
        knex,
        "homepages_cmps",
        homepage.id,
        "components_home_popular_searches",
        "home.popular-searches",
        "popularSearches",
        1,
        {
          enabled: fallbackStores.length > 0,
          heading: "Popular Searches",
        },
      );
    }
  }

  const catalogs = await entityCatalogs(knex);
  const legacyParentExists = await knex.schema.hasTable(
    "components_home_popular_searches_cmps",
  );
  const legacyLinkTableExists = await knex.schema.hasTable(
    "components_nav_links",
  );
  const legacyStore = await relation(
    knex,
    "components_nav_links_store_lnk",
    "store",
  );
  const legacyCategory = await relation(
    knex,
    "components_nav_links_category_lnk",
    "category",
  );
  const components = await knex("homepages_cmps")
    .where({
      field: "popularSearches",
      component_type: "home.popular-searches",
    })
    .distinct("cmp_id");
  let links = 0;

  for (const component of components) {
    const current = await Promise.all(
      KINDS.map((kind) =>
        linkedIds(knex, newLinks[kind], component.cmp_id),
      ),
    );
    if (current.some((ids) => ids.length > 0)) continue;
    const targets = { store: [], brand: [], category: [], bank: [] };
    const snapshots = (await knex.schema.hasTable(LEGACY_SNAPSHOT_TABLE))
      ? await knex(LEGACY_SNAPSHOT_TABLE)
          .where("popular_component_id", component.cmp_id)
          .orderBy("sort_order")
          .select("url", "store_id", "category_id")
      : [];
    for (const snapshot of snapshots) {
      const target = resolveLegacyPopularSearch(
        {
          url: snapshot.url,
          storeIds: snapshot.store_id ? [snapshot.store_id] : [],
          categoryIds: snapshot.category_id ? [snapshot.category_id] : [],
        },
        catalogs,
      );
      if (target && !targets[target.kind].includes(target.id)) {
        targets[target.kind].push(target.id);
      }
    }
    const legacy = legacyParentExists
      ? await componentIds(
          knex,
          "components_home_popular_searches_cmps",
          component.cmp_id,
          "links",
        )
      : [];
    for (const row of legacy) {
      const oldLink = legacyLinkTableExists
        ? await knex("components_nav_links")
            .where("id", row.cmp_id)
            .first("url")
        : null;
      const target = resolveLegacyPopularSearch(
        {
          url: oldLink?.url,
          storeIds: await linkedIds(knex, legacyStore, row.cmp_id),
          categoryIds: await linkedIds(knex, legacyCategory, row.cmp_id),
        },
        catalogs,
      );
      if (target && !targets[target.kind].includes(target.id)) {
        targets[target.kind].push(target.id);
      }
    }
    if (KINDS.every((kind) => targets[kind].length === 0)) {
      targets.store.push(...fallbackStores.slice(0, 10));
    }
    for (const kind of KINDS) {
      for (let index = 0; index < targets[kind].length; index++) {
        await addRelation(
          knex,
          newLinks[kind],
          component.cmp_id,
          targets[kind][index],
          index + 1,
        );
        links += 1;
      }
    }
  }
  return { ready: true, links };
}

async function reconcileSiteSelectionsAfterSchemaSync(knex, logger = console) {
  const run = async (db) => {
    const globalStores = await globalPopularStoreIds(db);
    const menus = (await db.schema.hasTable("menus"))
      ? await db("menus").orderBy("id").limit(1).select("id")
      : [];
    const fallbackStores = menus[0]
      ? await menuDefaultStoreIds(db, menus[0].id, globalStores)
      : globalStores.slice(0, 8);
    const menu = await backfillMenuSearch(db, globalStores);
    const homepage = await backfillHomepagePopularSearches(
      db,
      fallbackStores,
    );
    if (
      homepage.ready &&
      (await db.schema.hasTable(LEGACY_SNAPSHOT_TABLE))
    ) {
      await db.schema.dropTable(LEGACY_SNAPSHOT_TABLE);
    }
    if (!menu.ready || !homepage.ready) {
      logger.warn(
        "[site-selections] latest component tables are not available yet; retrying after the next schema sync",
      );
    }
    if (menu.stores || menu.suggestions || homepage.links) {
      logger.info(
        `[site-selections] added ${homepage.links} homepage relation(s), ` +
          `${menu.stores} search store(s), and ${menu.suggestions} suggestion(s)`,
      );
    }
    return {
      homepageLinks: homepage.links,
      searchStores: menu.stores,
      searchSuggestions: menu.suggestions,
      ready: menu.ready && homepage.ready,
    };
  };
  return knex.isTransaction ? run(knex) : knex.transaction(run);
}

module.exports = {
  HEADER_SEARCH_SUGGESTIONS,
  reconcileSiteSelectionsAfterSchemaSync,
  resolveLegacyPopularSearch,
  routeSlug,
  snapshotLegacyPopularSearchesBeforeSchemaSync,
  uniqueIds,
};
