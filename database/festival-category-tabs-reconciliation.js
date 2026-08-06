"use strict";

const PAGE_COMPONENTS = "independence_day_sale_pages_cmps";
const LEGACY_SECTION = "components_home_explore_offers";
const LEGACY_SECTION_COMPONENTS = "components_home_explore_offers_cmps";
const LEGACY_TAB = "components_home_explore_offer_tabs";
const LEGACY_TAB_CATEGORY = "components_home_explore_offer_tabs_category_lnk";
const LEGACY_TAB_OFFERS = "components_home_explore_offer_tabs_offers_lnk";
const LEGACY_TAB_COMPONENTS = "components_home_explore_offer_tabs_cmps";
const FESTIVAL_SECTION = "components_festival_coupons_by_categories";
const FESTIVAL_SECTION_COMPONENTS = "components_festival_coupons_by_categories_cmps";
const FESTIVAL_TAB = "components_festival_coupon_category_tabs";
const FESTIVAL_TAB_CATEGORY = "components_festival_coupon_category_tabs_category_lnk";
const FESTIVAL_TAB_OFFERS = "components_festival_coupon_category_tabs_offers_lnk";
const FESTIVAL_TAB_COMPONENTS = "components_festival_coupon_category_tabs_cmps";
const SHARED_CTA = "components_shared_ctas";

const LEGACY_SECTION_UID = "home.explore-offers";
const FESTIVAL_SECTION_UID = "festival.coupons-by-category";
const LEGACY_TAB_UID = "home.explore-offer-tab";
const FESTIVAL_TAB_UID = "festival.coupon-category-tab";
const SHARED_CTA_UID = "shared.cta";
const CATEGORY_FIELD = "couponsByCategory";
const TAB_LIMIT = 4;

const REQUIRED_TABLES = [
  PAGE_COMPONENTS,
  LEGACY_SECTION,
  LEGACY_SECTION_COMPONENTS,
  LEGACY_TAB,
  LEGACY_TAB_CATEGORY,
  LEGACY_TAB_OFFERS,
  LEGACY_TAB_COMPONENTS,
  FESTIVAL_SECTION,
  FESTIVAL_SECTION_COMPONENTS,
  FESTIVAL_TAB,
  FESTIVAL_TAB_CATEGORY,
  FESTIVAL_TAB_OFFERS,
  FESTIVAL_TAB_COMPONENTS,
  SHARED_CTA,
];

function insertedId(result) {
  const first = Array.isArray(result) ? result[0] : result;
  return Number(typeof first === "object" && first !== null ? first.id : first);
}

async function insertAndReturnId(trx, table, data) {
  return insertedId(await trx(table).insert(data).returning("id"));
}

async function copyCtaLinks(
  trx,
  sourceTable,
  sourceEntityId,
  targetTable,
  targetEntityId,
) {
  const links = await trx(sourceTable)
    .where({
      entity_id: sourceEntityId,
      component_type: SHARED_CTA_UID,
      field: "viewAllCta",
    })
    .orderBy("id", "asc");

  for (const link of links) {
    const cta = await trx(SHARED_CTA).where({ id: link.cmp_id }).first();
    if (!cta) continue;
    const ctaId = await insertAndReturnId(trx, SHARED_CTA, {
      label: cta.label,
      url: cta.url,
    });
    await trx(targetTable).insert({
      entity_id: targetEntityId,
      cmp_id: ctaId,
      component_type: SHARED_CTA_UID,
      field: "viewAllCta",
      order: link.order,
    });
  }
}

async function reconcileFestivalCategoryTabs(knex, logger = console) {
  for (const table of REQUIRED_TABLES) {
    if (!(await knex.schema.hasTable(table))) {
      logger.info?.(
        `[festival-category-tabs] ${table} is not available yet; bootstrap will retry after schema sync`,
      );
      return { migrated: false, reason: "tables-missing" };
    }
  }

  return knex.transaction(async (trx) => {
    let pageLinkQuery = trx(PAGE_COMPONENTS)
      .where({ field: CATEGORY_FIELD })
      .orderBy("id", "asc")
      .first();
    const dialect = trx.client.config.client;
    if (dialect === "pg" || dialect === "postgresql") {
      pageLinkQuery = pageLinkQuery.forUpdate();
    }
    const pageLink = await pageLinkQuery;
    if (!pageLink) return { migrated: false, reason: "section-empty" };
    if (pageLink.component_type === FESTIVAL_SECTION_UID) {
      return { migrated: false, reason: "already-migrated" };
    }
    if (pageLink.component_type !== LEGACY_SECTION_UID) {
      return { migrated: false, reason: "unexpected-component" };
    }

    const oldSection = await trx(LEGACY_SECTION)
      .where({ id: pageLink.cmp_id })
      .first();
    if (!oldSection) return { migrated: false, reason: "legacy-section-missing" };

    const newSectionId = await insertAndReturnId(trx, FESTIVAL_SECTION, {
      enabled: oldSection.enabled,
      heading: oldSection.heading,
    });
    await copyCtaLinks(
      trx,
      LEGACY_SECTION_COMPONENTS,
      oldSection.id,
      FESTIVAL_SECTION_COMPONENTS,
      newSectionId,
    );

    const tabLinks = await trx(LEGACY_SECTION_COMPONENTS)
      .where({
        entity_id: oldSection.id,
        component_type: LEGACY_TAB_UID,
        field: "tabs",
      })
      .orderBy("order", "asc")
      .limit(TAB_LIMIT);

    for (const tabLink of tabLinks) {
      const oldTab = await trx(LEGACY_TAB).where({ id: tabLink.cmp_id }).first();
      if (!oldTab) continue;
      const newTabId = await insertAndReturnId(trx, FESTIVAL_TAB, {
        label_override: oldTab.label_override,
      });

      const categoryLinks = await trx(LEGACY_TAB_CATEGORY).where({
        explore_offer_tab_id: oldTab.id,
      });
      for (const categoryLink of categoryLinks) {
        await trx(FESTIVAL_TAB_CATEGORY).insert({
          coupon_category_tab_id: newTabId,
          category_id: categoryLink.category_id,
        });
      }

      const offerLinks = await trx(LEGACY_TAB_OFFERS)
        .where({ explore_offer_tab_id: oldTab.id })
        .orderBy("coupon_ord", "asc");
      for (const offerLink of offerLinks) {
        await trx(FESTIVAL_TAB_OFFERS).insert({
          coupon_category_tab_id: newTabId,
          coupon_id: offerLink.coupon_id,
          coupon_ord: offerLink.coupon_ord,
        });
      }

      await copyCtaLinks(
        trx,
        LEGACY_TAB_COMPONENTS,
        oldTab.id,
        FESTIVAL_TAB_COMPONENTS,
        newTabId,
      );
      await trx(FESTIVAL_SECTION_COMPONENTS).insert({
        entity_id: newSectionId,
        cmp_id: newTabId,
        component_type: FESTIVAL_TAB_UID,
        field: "tabs",
        order: tabLink.order,
      });
    }

    await trx(PAGE_COMPONENTS).where({ id: pageLink.id }).update({
      cmp_id: newSectionId,
      component_type: FESTIVAL_SECTION_UID,
    });

    logger.info?.(
      `[festival-category-tabs] preserved ${tabLinks.length} authored tab(s) while applying the four-tab festival schema`,
    );
    return { migrated: true, tabs: tabLinks.length };
  });
}

async function reconcileFestivalCategoryTabsAfterSchemaSync(
  knex,
  logger = console,
) {
  return reconcileFestivalCategoryTabs(knex, logger);
}

module.exports = {
  reconcileFestivalCategoryTabs,
  reconcileFestivalCategoryTabsAfterSchemaSync,
};
