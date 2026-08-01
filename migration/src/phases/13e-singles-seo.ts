import { syncSinglesSeo } from "../utils/singles-seo.js";
import { logger } from "../utils/logger.js";

/**
 * SEO for the single types (homepage, deal-of-the-day, about/career/contact/
 * faq pages) from the matching WordPress pages' Yoast data — meta title/
 * description, canonical, index/noindex, OG title/description/image.
 * Runs after 13d so every single row exists. Re-runnable: replaceComponents
 * updates in place.
 */
export async function runSinglesSeo(): Promise<void> {
  logger.info("=== Phase 13e: Singles SEO (Yoast pages + homepage) ===");
  const summary = await syncSinglesSeo(true);
  logger.info(
    `Singles SEO complete: ${summary.updated.length} single(s) updated, ` +
      `${summary.ogImagesLinked} OG image(s) linked` +
      (summary.skippedNoWpPage.length > 0
        ? `, no WP page for: ${summary.skippedNoWpPage.join(", ")}`
        : "") +
      (summary.skippedNoStrapiRow.length > 0
        ? `, no Strapi row for: ${summary.skippedNoStrapiRow.join(", ")}`
        : ""),
  );
}
