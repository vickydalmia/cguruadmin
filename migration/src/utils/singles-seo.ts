import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { replaceComponents, replaceMedia } from "./strapi-insert.js";
import { uploadMediaOnDemand } from "../phases/02-media-upload.js";
import {
  loadYoastSiteConfig,
  loadYoastPostOverrides,
  resolvePageSeo,
  type ResolvedTermSeo,
} from "./yoast-term-seo.js";
import { clean } from "./sanitize.js";
import { logger } from "./logger.js";

// SEO for the Strapi SINGLE types, sourced from the matching WordPress pages
// (per-page Yoast postmeta → "page" templates) and, for the homepage, the
// front-page settings. Used by phase 13e on imports and by fix:seo-meta to
// repair an already-imported database.

interface SingleTarget {
  table: string;
  strapiUid: string;
  /** WP page slugs to try, in order. */
  slugCandidates: string[];
  /** Display name used for %%title%% when the WP page is missing. */
  fallbackName: string;
  featureColumn: string;
}

const SINGLE_TARGETS: SingleTarget[] = [
  {
    table: "deal_of_the_day_pages",
    strapiUid: "api::deal-of-the-day-page.deal-of-the-day-page",
    slugCandidates: ["deal-of-the-day", "deals-of-the-day", "dotd"],
    fallbackName: "Deal of the Day",
    featureColumn: "deal_of_the_day_enabled",
  },
  {
    table: "about_pages",
    strapiUid: "api::about-page.about-page",
    slugCandidates: ["about", "about-us"],
    fallbackName: "About Us",
    featureColumn: "about_enabled",
  },
  {
    table: "career_pages",
    strapiUid: "api::career-page.career-page",
    slugCandidates: ["careers", "career", "jobs"],
    fallbackName: "Careers",
    featureColumn: "careers_enabled",
  },
  {
    table: "contact_pages",
    strapiUid: "api::contact-page.contact-page",
    slugCandidates: ["contact", "contact-us"],
    fallbackName: "Contact Us",
    featureColumn: "contact_enabled",
  },
  {
    table: "faq_pages",
    strapiUid: "api::faq-page.faq-page",
    slugCandidates: ["faq", "faqs"],
    fallbackName: "FAQ",
    featureColumn: "faqs_enabled",
  },
  { table: "testimonials_pages", strapiUid: "api::testimonials-page.testimonials-page", slugCandidates: ["testimonials"], fallbackName: "Testimonials", featureColumn: "testimonials_enabled" },
  { table: "partner_with_us_pages", strapiUid: "api::partner-with-us-page.partner-with-us-page", slugCandidates: ["partner-with-us"], fallbackName: "Partner With Us", featureColumn: "partner_with_us_enabled" },
  { table: "culture_pages", strapiUid: "api::culture-page.culture-page", slugCandidates: ["culture", "life-at-couponzguru"], fallbackName: "Culture", featureColumn: "culture_enabled" },
  { table: "privacy_policy_pages", strapiUid: "api::privacy-policy-page.privacy-policy-page", slugCandidates: ["privacy-policy"], fallbackName: "Privacy Policy", featureColumn: "privacy_policy_enabled" },
  { table: "terms_and_conditions_pages", strapiUid: "api::terms-and-conditions-page.terms-and-conditions-page", slugCandidates: ["terms-and-conditions", "terms-of-use"], fallbackName: "Terms and Conditions", featureColumn: "terms_and_conditions_enabled" },
  { table: "affiliate_disclosure_pages", strapiUid: "api::affiliate-disclosure-page.affiliate-disclosure-page", slugCandidates: ["affiliate-disclosure"], fallbackName: "Affiliate Disclosure", featureColumn: "affiliate_disclosure_enabled" },
  { table: "independence_day_sale_pages", strapiUid: "api::independence-day-sale-page.independence-day-sale-page", slugCandidates: ["independence-day-sale", "independence-day-sale-coupons"], fallbackName: "Independence Day Sale", featureColumn: "independence_day_sale_enabled" },
];

export interface SinglesSeoSummary {
  updated: string[];
  skippedNoWpPage: string[];
  skippedNoStrapiRow: string[];
  ogImagesLinked: number;
}

async function upsertSingleSeo(
  table: string,
  entityId: number,
  seo: ResolvedTermSeo,
  pageName: string,
  apply: boolean,
): Promise<number | null> {
  const metaTitle = (clean(seo.metaTitle) || pageName).slice(0, 70);
  const metaDescription = (
    clean(seo.metaDescription) || `${pageName} - CouponzGuru.`
  ).slice(0, 170);
  if (!apply) return null;

  await replaceComponents(
    "components_shared_seos",
    [
      {
        meta_title: metaTitle,
        meta_description: metaDescription,
        canonical_url: seo.canonicalUrl,
        no_index: seo.noIndex,
        og_title: seo.ogTitle,
        og_description: seo.ogDescription,
      },
    ],
    table,
    entityId,
    "seo",
    "shared.seo",
  );
  const [link] = await pgQuery<{ cmp_id: number }>(
    `SELECT cmp_id FROM "${table}_cmps"
     WHERE entity_id = $1 AND field = 'seo' AND component_type = 'shared.seo'
     ORDER BY "order" LIMIT 1`,
    [entityId],
  );
  return link?.cmp_id ?? null;
}

/**
 * Resolve + write SEO (incl. OG image media) for every single type. With
 * apply=false, only reports what would change.
 */
export async function syncSinglesSeo(apply: boolean): Promise<SinglesSeoSummary> {
  const site = await loadYoastSiteConfig();
  const summary: SinglesSeoSummary = {
    updated: [],
    skippedNoWpPage: [],
    skippedNoStrapiRow: [],
    ogImagesLinked: 0,
  };

  // All published WP pages, matched by slug.
  const pages = await wpQuery<{ ID: number; post_title: string; post_name: string }>(`
    SELECT ID, post_title, post_name
    FROM wp_posts
    WHERE post_type = 'page' AND post_status = 'publish'
  `);
  const pageBySlug = new Map(pages.map((p) => [p.post_name.toLowerCase(), p]));

  // Homepage: a static front page's own Yoast meta wins; otherwise the
  // "home-wpseo" template settings apply.
  const options = await wpQuery<{ option_name: string; option_value: string }>(`
    SELECT option_name, option_value FROM wp_options
    WHERE option_name IN ('show_on_front', 'page_on_front')
  `);
  const optByName = new Map(options.map((o) => [o.option_name, o.option_value]));
  const frontPageId =
    optByName.get("show_on_front") === "page"
      ? parseInt(optByName.get("page_on_front") ?? "", 10)
      : NaN;
  // page_on_front="0" means no static front page is configured (WP renders the
  // posts index), so it must fall through to the home-wpseo template, and the
  // front page must actually exist as a published page for its Yoast/template
  // meta to apply — Yoast resolves %%title%% to the page's own post_title.
  const frontPage =
    Number.isFinite(frontPageId) && frontPageId > 0
      ? (pages.find((page) => page.ID === frontPageId) ?? null)
      : null;

  const [siteConfiguration] = await pgQuery<Record<string, unknown>>(
    `SELECT * FROM "site_configurations" ORDER BY id LIMIT 1`,
  ).catch(() => []);
  const enabledTargets = SINGLE_TARGETS.filter(
    (target) => !siteConfiguration || siteConfiguration[target.featureColumn] === true,
  );
  const matched = enabledTargets.map((target) => ({
    target,
    page:
      target.slugCandidates
        .map((slug) => pageBySlug.get(slug))
        .find((page) => page !== undefined) ?? null,
  }));

  const overrideIds = [
    ...matched.flatMap(({ page }) => (page ? [page.ID] : [])),
    ...(frontPage ? [frontPage.ID] : []),
  ];
  const overrides = await loadYoastPostOverrides(overrideIds);

  // Homepage single.
  const homepageSeo = frontPage
    ? resolvePageSeo(site, {
        kind: "page",
        pageName: frontPage.post_title || site.siteName,
        override: overrides.get(frontPage.ID),
      })
    : resolvePageSeo(site, { kind: "home-wpseo", pageName: site.siteName });
  const allTargets: Array<{
    table: string;
    strapiUid: string;
    pageName: string;
    seo: ResolvedTermSeo;
    matchedWp: boolean;
  }> = [
    {
      table: "homepages",
      strapiUid: "api::homepage.homepage",
      pageName: site.siteName,
      seo: homepageSeo,
      matchedWp: true, // home settings always exist in some form
    },
    ...matched.map(({ target, page }) => ({
      table: target.table,
      strapiUid: target.strapiUid,
      pageName: page?.post_title || target.fallbackName,
      seo: page
        ? resolvePageSeo(site, {
            kind: "page",
            pageName: page.post_title,
            override: overrides.get(page.ID),
          })
        : resolvePageSeo(site, { kind: "page", pageName: target.fallbackName }),
      matchedWp: page !== null,
    })),
  ];

  for (const item of allTargets) {
    if (!item.matchedWp) {
      summary.skippedNoWpPage.push(item.table);
      logger.warn(
        `[singles-seo] no WP page matched for ${item.table} — template-only SEO applied`,
      );
    }
    const [row] = await pgQuery<{ id: number }>(
      `SELECT id FROM "${item.table}" ORDER BY id LIMIT 1`,
    );
    if (!row) {
      summary.skippedNoStrapiRow.push(item.table);
      continue;
    }

    const cmpId = await upsertSingleSeo(
      item.table,
      row.id,
      item.seo,
      item.pageName,
      apply,
    );
    summary.updated.push(item.table);
    logger.info(
      `[singles-seo] ${apply ? "updated" : "would update"} ${item.table}: ` +
        `"${(clean(item.seo.metaTitle) || item.pageName).slice(0, 60)}"` +
        (item.seo.noIndex ? " [noindex]" : "") +
        (item.seo.ogImageAttachmentId ? " [og image]" : ""),
    );

    // OG image: import the WP attachment through the normal media pipeline
    // (manifest-reused when possible) and link it to the SEO component.
    if (apply && cmpId && item.seo.ogImageAttachmentId) {
      try {
        const fileId = await uploadMediaOnDemand(item.seo.ogImageAttachmentId);
        if (fileId) {
          await replaceMedia(fileId, cmpId, "shared.seo", "ogImage");
          summary.ogImagesLinked++;
        }
      } catch (err: any) {
        logger.warn(
          `[singles-seo] OG image for ${item.table} failed: ${err.message}`,
        );
      }
    }
  }

  return summary;
}
