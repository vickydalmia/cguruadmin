import fs from "fs";
import { pgQuery, pgTransaction } from "../db/pg-client.js";
import { uploadFileFromDisk } from "./02-media-upload.js";
import {
  FOOTER_COUNTRY_ASSETS,
  GOOGLE_PREFERRED_DEFAULT,
} from "../utils/footer-media-assets.js";
import { logger } from "../utils/logger.js";

interface FooterRow {
  id: number;
}

interface ComponentRow {
  id: number;
}

async function tableExists(table: string): Promise<boolean> {
  const rows = await pgQuery<{ exists: boolean }>(
    `SELECT to_regclass(current_schema() || '.' || $1) IS NOT NULL AS "exists"`,
    [table],
  );
  return rows[0]?.exists === true;
}

async function requireTables(tables: string[]): Promise<void> {
  const missing: string[] = [];
  for (const table of tables) {
    if (!(await tableExists(table))) missing.push(table);
  }
  if (missing.length > 0) {
    throw new Error(
      `Footer media schema is not ready (${missing.join(", ")} missing). ` +
        "Start Strapi once with the latest schema before running this phase.",
    );
  }
}

async function uploadAsset(
  localPath: string,
  fileName: string,
  altText: string,
): Promise<number> {
  if (!fs.existsSync(localPath)) {
    throw new Error(`Packaged footer migration asset is missing: ${localPath}`);
  }
  const uploaded = await uploadFileFromDisk({
    localPath,
    fileName,
    mimeType: "image/png",
    altText,
    throwOnFailure: true,
  });
  if (!uploaded) {
    throw new Error(`Could not upload packaged footer asset: ${fileName}`);
  }
  return uploaded.id;
}

async function hasMedia(
  relatedId: number,
  relatedType: string,
  field: string,
): Promise<boolean> {
  const rows = await pgQuery<{ id: number }>(
    `SELECT id
       FROM "files_related_mph"
      WHERE related_id = $1 AND related_type = $2 AND field = $3
      LIMIT 1`,
    [relatedId, relatedType, field],
  );
  return rows.length > 0;
}

async function attachMediaIfMissing(
  fileId: number,
  relatedId: number,
  relatedType: string,
  field: string,
): Promise<boolean> {
  if (await hasMedia(relatedId, relatedType, field)) return false;
  await pgQuery(
    `INSERT INTO "files_related_mph"
       ("file_id", "related_id", "related_type", "field", "order")
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT DO NOTHING`,
    [fileId, relatedId, relatedType, field],
  );
  return true;
}

async function linkedComponent(
  footerId: number,
  componentType: string,
  field: string,
  code?: string,
): Promise<ComponentRow | undefined> {
  const params: unknown[] = [footerId, componentType, field];
  const countryFilter = code
    ? ` AND LOWER(c.code) = $4`
    : "";
  if (code) params.push(code);
  const table = code
    ? "components_footer_countries"
    : "components_footer_google_preferred_cards";
  const rows = await pgQuery<ComponentRow>(
    `SELECT c.id
       FROM "${table}" c
       JOIN "footers_cmps" fc
         ON fc.cmp_id = c.id
        AND fc.component_type = $2
        AND fc.field = $3
      WHERE fc.entity_id = $1${countryFilter}
      ORDER BY fc."order", c.id
      LIMIT 1`,
    params,
  );
  return rows[0];
}

async function nextComponentOrder(
  footerId: number,
  field: string,
): Promise<number> {
  const rows = await pgQuery<{ next_order: number }>(
    `SELECT COALESCE(MAX("order"), 0) + 1 AS next_order
       FROM "footers_cmps"
      WHERE entity_id = $1 AND field = $2`,
    [footerId, field],
  );
  return Number(rows[0]?.next_order ?? 1);
}

async function ensureCountryComponent(
  footerId: number,
  code: string,
  name: string,
  url: string,
): Promise<{ id: number; created: boolean }> {
  const existing = await linkedComponent(
    footerId,
    "footer.country",
    "countries",
    code,
  );
  if (existing) {
    await pgQuery(
      `UPDATE "components_footer_countries"
          SET url = COALESCE(NULLIF(BTRIM(url), ''), $2)
        WHERE id = $1`,
      [existing.id, url],
    );
    return { id: existing.id, created: false };
  }

  const rows = await pgQuery<ComponentRow>(
    `INSERT INTO "components_footer_countries" ("code", "name", "url")
     VALUES ($1, $2, $3)
     RETURNING id`,
    [code, name, url],
  );
  const order = await nextComponentOrder(footerId, "countries");
  await pgQuery(
    `INSERT INTO "footers_cmps"
       ("entity_id", "cmp_id", "component_type", "field", "order")
     VALUES ($1, $2, 'footer.country', 'countries', $3)`,
    [footerId, rows[0].id, order],
  );
  return { id: rows[0].id, created: true };
}

async function ensureGooglePreferredComponent(
  footerId: number,
): Promise<{ id: number; created: boolean }> {
  const existing = await linkedComponent(
    footerId,
    "footer.google-preferred-card",
    "googlePreferredCard",
  );
  if (existing) {
    await pgQuery(
      `UPDATE "components_footer_google_preferred_cards"
          SET label = COALESCE(NULLIF(BTRIM(label), ''), $2),
              url = COALESCE(NULLIF(BTRIM(url), ''), $3)
        WHERE id = $1`,
      [existing.id, GOOGLE_PREFERRED_DEFAULT.label, GOOGLE_PREFERRED_DEFAULT.url],
    );
    return { id: existing.id, created: false };
  }

  const rows = await pgQuery<ComponentRow>(
    `INSERT INTO "components_footer_google_preferred_cards" ("label", "url")
     VALUES ($1, $2)
     RETURNING id`,
    [GOOGLE_PREFERRED_DEFAULT.label, GOOGLE_PREFERRED_DEFAULT.url],
  );
  await pgQuery(
    `INSERT INTO "footers_cmps"
       ("entity_id", "cmp_id", "component_type", "field", "order")
     VALUES ($1, $2, 'footer.google-preferred-card', 'googlePreferredCard', 1)`,
    [footerId, rows[0].id],
  );
  return { id: rows[0].id, created: true };
}

/**
 * Phase 13b — Footer media
 *
 * Packaged PNG masters go through the normal migration uploader, so S3
 * environments receive optimized WebP masters plus the usual responsive
 * WebP/AVIF format ladder. The uploader's source hash makes reruns reuse the
 * same media rows. Existing CMS media relations always win; this is fill-only.
 */
export async function runFooterMediaBackfill(): Promise<void> {
  logger.info("=== Phase 13b: Footer media ===");

  await requireTables([
    "footers",
    "footers_cmps",
    "components_footer_countries",
    "components_footer_google_preferred_cards",
    "files",
    "files_related_mph",
  ]);

  const footers = await pgQuery<FooterRow>(`SELECT id FROM "footers" ORDER BY id`);
  if (footers.length === 0) {
    throw new Error(
      "No footer row exists. Run phase 13-site-content before phase 13b-footer-media.",
    );
  }

  const countryFileIds = new Map<string, number>();
  for (const asset of FOOTER_COUNTRY_ASSETS) {
    countryFileIds.set(
      asset.code,
      await uploadAsset(
        asset.assetPath,
        `couponzguru-${asset.code}-flag.png`,
        `${asset.name} flag`,
      ),
    );
  }
  const googleFileId = await uploadAsset(
    GOOGLE_PREFERRED_DEFAULT.assetPath,
    "couponzguru-google-preferred-source.png",
    GOOGLE_PREFERRED_DEFAULT.label,
  );

  let countriesCreated = 0;
  let flagsAttached = 0;
  let cardsCreated = 0;
  let iconsAttached = 0;

  await pgTransaction(async () => {
    for (const footer of footers) {
      for (const asset of FOOTER_COUNTRY_ASSETS) {
        const component = await ensureCountryComponent(
          footer.id,
          asset.code,
          asset.name,
          asset.url,
        );
        if (component.created) countriesCreated++;
        if (
          await attachMediaIfMissing(
            countryFileIds.get(asset.code)!,
            component.id,
            "footer.country",
            "flag",
          )
        ) {
          flagsAttached++;
        }
      }

      const card = await ensureGooglePreferredComponent(footer.id);
      if (card.created) cardsCreated++;
      if (
        await attachMediaIfMissing(
          googleFileId,
          card.id,
          "footer.google-preferred-card",
          "icon",
        )
      ) {
        iconsAttached++;
      }
    }
  });

  logger.info(
    `Footer media backfill complete: ${footers.length} footer row(s), ` +
      `${countriesCreated} countries created, ${flagsAttached} flags attached, ` +
      `${cardsCreated} Google Preferred cards created, ${iconsAttached} icons attached`,
  );
}
