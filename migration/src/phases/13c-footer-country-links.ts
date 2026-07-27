import { pgQuery } from "../db/pg-client.js";
import { FOOTER_COUNTRY_ASSETS } from "../utils/footer-media-assets.js";
import { logger } from "../utils/logger.js";

/**
 * Phase 13c — Footer country links
 *
 * Compatibility backfill for environments that checkpointed Phase 13b before
 * footer.country gained its CMS URL. Existing nonblank editor values win.
 */
export async function runFooterCountryLinksBackfill(): Promise<void> {
  logger.info("=== Phase 13c: Footer country links ===");

  const schema = await pgQuery<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'components_footer_countries'
          AND column_name = 'url'
     ) AS "exists"`,
  );
  if (!schema[0]?.exists) {
    throw new Error(
      "components_footer_countries.url is missing. Start Strapi once with the latest schema before running this phase.",
    );
  }

  let updated = 0;
  for (const country of FOOTER_COUNTRY_ASSETS) {
    const rows = await pgQuery<{ id: number }>(
      `UPDATE "components_footer_countries"
          SET url = $2
        WHERE LOWER(code) = $1
          AND (url IS NULL OR BTRIM(url) = '')
      RETURNING id`,
      [country.code, country.url],
    );
    updated += rows.length;
  }

  logger.info(`Footer country link backfill complete: ${updated} URL(s) filled`);
}
