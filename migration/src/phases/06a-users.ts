import pLimit from "p-limit";
import { wpQuery } from "../db/wp-client.js";
import { pgQuery } from "../db/pg-client.js";
import { getPgPool } from "../db/pg-client.js";
import {
  ensureTermMapping,
  getUserMapping,
  setUserMapping,
} from "../utils/id-maps.js";
import { generateDocumentId } from "../utils/strapi-insert.js";
import {
  generateResetToken,
  hashRandomPassword,
  splitDisplayName,
} from "../utils/admin-auth.js";
import { clean } from "../utils/sanitize.js";
import { normalizeWpLocalDate } from "../utils/wp-dates.js";
import { logger } from "../utils/logger.js";

export async function runUsers(): Promise<void> {
  logger.info("=== Phase 6a: Users Migration ===");

  const roleRows = await pgQuery<{ id: number }>(
    `SELECT id FROM "admin_roles" WHERE code = $1 LIMIT 1`,
    ["strapi-editor"]
  );
  const editorRoleId = roleRows[0]?.id;
  if (!editorRoleId) {
    throw new Error(
      "admin_roles 'strapi-editor' not found — start Strapi at least once so default roles are created, then rerun this phase"
    );
  }

  const users = await wpQuery<{
    ID: number;
    user_login: string;
    user_email: string;
    user_registered: string | null;
    display_name: string | null;
    user_nicename: string | null;
    first_name: string | null;
    last_name: string | null;
  }>(`
    SELECT u.ID, u.user_login, u.user_email,
           CASE WHEN CAST(u.user_registered AS CHAR) = '0000-00-00 00:00:00'
                THEN NULL ELSE CAST(u.user_registered AS CHAR) END AS user_registered,
           u.display_name, u.user_nicename,
           (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = 'first_name' LIMIT 1) AS first_name,
           (SELECT meta_value FROM wp_usermeta WHERE user_id = u.ID AND meta_key = 'last_name' LIMIT 1) AS last_name
    FROM wp_users u
    ORDER BY u.ID
  `);

  logger.info(`Found ${users.length} WP users`);
  if (users.length === 0) return;

  let inserted = 0;
  let skippedNoEmail = 0;
  let failed = 0;
  const limit = pLimit(10);

  const tasks = users.map((user) =>
    limit(async () => {
      const email = clean(user.user_email);
      if (!email) {
        skippedNoEmail++;
        logger.warn(
          `Skipping user ${user.ID} (${user.user_login}) — missing email`
        );
        return;
      }

      try {
        const documentId = generateDocumentId(`user:${user.ID}`);
        const { firstname, lastname } = resolveUserName(
          user,
          email
        );
        const createdAt =
          normalizeWpLocalDate(user.user_registered) ||
          new Date().toISOString();

        const existing = await pgQuery<{ id: number; document_id: string | null }>(
          `SELECT id, document_id FROM "admin_users" WHERE email = $1 LIMIT 1`,
          [email]
        );

        const existingUser = existing[0];
        let adminUserId: number | undefined = existingUser?.id;

        if (!adminUserId) {
          const result = await pgQuery<{ id: number }>(
            `INSERT INTO "admin_users" (
              "document_id", "firstname", "lastname", "username", "email",
              "password", "reset_password_token", "registration_token",
              "is_active", "blocked", "prefered_language",
              "published_at", "created_at", "updated_at", "locale"
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
            )
            RETURNING id`,
            [
              documentId,
              firstname,
              lastname,
              clean(user.user_login) || email,
              email,
              hashRandomPassword(),
              generateResetToken(),
              null,
              true,
              false,
              null,
              new Date().toISOString(),
              createdAt,
              createdAt,
              null,
            ]
          );
          adminUserId = result[0]?.id;
        } else if (
          existingUser.document_id === documentId ||
          existingUser.document_id?.startsWith("wp_")
        ) {
          await pgQuery(
            `UPDATE "admin_users"
             SET "firstname" = $1,
                 "lastname" = $2,
                 "username" = COALESCE(NULLIF("username", ''), $3),
                 "updated_at" = NOW()
             WHERE "id" = $4`,
            [firstname, lastname, clean(user.user_login) || email, adminUserId]
          );
        }
        if (!adminUserId) {
          logger.warn(
            `Could not resolve admin_user id for WP user ${user.ID} (${email})`
          );
          failed++;
          return;
        }

        setUserMapping(user.ID, adminUserId);

        const existingLink = await pgQuery<{ id: number }>(
          `SELECT id FROM "admin_users_roles_lnk" WHERE user_id = $1 AND role_id = $2 LIMIT 1`,
          [adminUserId, editorRoleId]
        );
        if (existingLink.length === 0) {
          await pgQuery(
            `INSERT INTO "admin_users_roles_lnk" ("user_id", "role_id") VALUES ($1, $2)`,
            [adminUserId, editorRoleId]
          );
        }

        inserted++;
      } catch (err: any) {
        failed++;
        logger.error(
          `Failed to insert user ${user.ID} (${user.user_email}): ${err.message}`
        );
      }
    })
  );

  await Promise.all(tasks);
  logger.info(
    `Users migration complete: ${inserted} inserted, ${skippedNoEmail} skipped (no email), ${failed} failed`
  );

  if (inserted === 0 && failed > 0) {
    throw new Error(
      `Users phase failed: ${failed}/${users.length} inserts errored, 0 succeeded`
    );
  }

  await backfillCreators();
}

async function backfillCreators(): Promise<void> {
  logger.info("Back-patching created_by/updated_by on migrated content...");

  const rows = await wpQuery<{
    ID: number;
    post_author: number;
    is_deal: string | null;
    edit_last: string | null;
  }>(`
    SELECT p.ID, p.post_author,
           (SELECT meta_value FROM wp_postmeta
              WHERE post_id = p.ID AND meta_key = 'is_deal' LIMIT 1) AS is_deal,
           (SELECT meta_value FROM wp_postmeta
              WHERE post_id = p.ID AND meta_key = '_edit_last' LIMIT 1) AS edit_last
    FROM wp_posts p
    WHERE p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
  `);

  const dealPairs: Array<CreatorTriple> = [];
  const couponPairs: Array<CreatorTriple> = [];

  for (const row of rows) {
    const createdById = getUserMapping(row.post_author);
    if (!createdById) continue;
    // WP tracks the last editor separately from the author; fall back to the
    // author when the editor was deleted from wp_users or never mapped.
    const editorWpId = row.edit_last ? parseInt(row.edit_last, 10) : NaN;
    const updatedById =
      (Number.isNaN(editorWpId) ? undefined : getUserMapping(editorWpId)) ??
      createdById;
    const isDeal = row.is_deal === "yes";
    const docId = generateDocumentId(
      isDeal ? `deal:${row.ID}` : `coupon:${row.ID}`
    );
    (isDeal ? dealPairs : couponPairs).push([docId, createdById, updatedById]);
  }

  const dealsUpdated = await applyCreatorUpdates("deals", dealPairs);
  const couponsUpdated = await applyCreatorUpdates("coupons", couponPairs);
  const taxonomyUpdated = await backfillTaxonomyCreators();

  logger.info(
    `Creator backfill: ${dealsUpdated} deals, ${couponsUpdated} coupons, ${taxonomyUpdated} taxonomies updated`
  );
}

function resolveUserName(
  user: {
    ID: number;
    user_login: string;
    display_name: string | null;
    user_nicename: string | null;
    first_name: string | null;
    last_name: string | null;
  },
  email: string
): { firstname: string; lastname: string | null } {
  const wpFirstName = clean(user.first_name);
  const wpLastName = clean(user.last_name);
  const fallbackName =
    clean(user.user_nicename) || clean(user.user_login) || `User${user.ID}`;

  if (wpFirstName) {
    return {
      firstname: wpFirstName,
      lastname: wpLastName,
    };
  }

  const displayName = clean(user.display_name);
  const usableDisplayName =
    displayName && displayName.toLowerCase() !== email.toLowerCase() && !displayName.includes("@")
      ? displayName
      : null;

  return splitDisplayName(usableDisplayName, fallbackName);
}

async function backfillTaxonomyCreators(): Promise<number> {
  const rows = await wpQuery<{
    term_id: number;
    post_author: number;
    post_id: number;
  }>(`
    SELECT tt.term_id, p.post_author, p.ID AS post_id
    FROM wp_term_taxonomy tt
    JOIN wp_term_relationships tr ON tr.term_taxonomy_id = tt.term_taxonomy_id
    JOIN wp_posts p ON p.ID = tr.object_id
    WHERE tt.taxonomy = 'category'
      AND p.post_type = 'post'
      AND p.post_status IN ('publish', 'future')
    ORDER BY tt.term_id,
             COALESCE(p.post_modified_gmt, p.post_date_gmt, p.post_modified, p.post_date) DESC,
             p.ID DESC
  `);

  const pairsByTable = new Map<"stores" | "brands" | "categories" | "banks", Array<CreatorTriple>>();
  const latestByTerm = new Map<number, { post_author: number; post_id: number }>();

  for (const row of rows) {
    if (!latestByTerm.has(row.term_id)) {
      latestByTerm.set(row.term_id, {
        post_author: row.post_author,
        post_id: row.post_id,
      });
    }
  }

  for (const [termId, row] of latestByTerm) {
    const adminId = getUserMapping(row.post_author);
    if (!adminId) continue;

    const ref = await ensureTermMapping(termId);
    if (!ref || !isTaxonomyTable(ref.table)) continue;

    const pairs = pairsByTable.get(ref.table) ?? [];
    // WP has no term-editor tracking, so author fills both columns.
    pairs.push([ref.documentId, adminId, adminId]);
    pairsByTable.set(ref.table, pairs);
  }

  let total = 0;
  for (const [table, pairs] of pairsByTable) {
    total += await applyCreatorUpdates(table, pairs);
  }

  return total;
}

function isTaxonomyTable(
  table: string
): table is "stores" | "brands" | "categories" | "banks" {
  return ["stores", "brands", "categories", "banks"].includes(table);
}

/** [documentId, createdById, updatedById] */
type CreatorTriple = [string, number, number];

async function applyCreatorUpdates(
  table: "deals" | "coupons" | "stores" | "brands" | "categories" | "banks",
  pairs: Array<CreatorTriple>
): Promise<number> {
  if (pairs.length === 0) return 0;

  const pool = getPgPool();
  const CHUNK = 500;
  let total = 0;

  for (let i = 0; i < pairs.length; i += CHUNK) {
    const chunk = pairs.slice(i, i + CHUNK);
    const values: any[] = [];
    const placeholders = chunk
      .map((pair, idx) => {
        const p1 = idx * 3 + 1;
        const p2 = idx * 3 + 2;
        const p3 = idx * 3 + 3;
        values.push(pair[0], pair[1], pair[2]);
        return `($${p1}::text, $${p2}::integer, $${p3}::integer)`;
      })
      .join(", ");

    const sql = `
      UPDATE "${table}" AS t
      SET created_by_id = v.created_id,
          updated_by_id = v.updated_id
      FROM (VALUES ${placeholders}) AS v(document_id, created_id, updated_id)
      WHERE t.document_id = v.document_id
    `;
    const result = await pool.query(sql, values);
    total += result.rowCount ?? 0;
  }

  return total;
}
