/**
 * Reset the Homepage single type so phase 13 can reseed it from scratch
 * (seedHomepage skips when a `homepages` row exists).
 *
 * Deletes the single `homepages` row; `homepages_cmps` attachments cascade
 * via FK. Orphaned component rows are left behind — they are inert and the
 * reseed writes fresh ones. BACK UP the homepage tables first.
 *
 * Targets whatever PG_CONNECTION_STRING resolves to (migration/.env.migration
 * by default — i.e. the DEPLOYED database). It prints the target host and
 * refuses to run without an explicit confirmation flag matching that host:
 *
 *   tsx src/reset-homepage.ts --yes-i-mean-<host>
 *
 * e.g. local:  PG_CONNECTION_STRING=postgresql://... PG_CA_CERT_PATH= \
 *                tsx src/reset-homepage.ts --yes-i-mean-127.0.0.1
 */

import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { pgQuery, closePg } from "./db/pg-client.js";
import { logger } from "./utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Dump every homepage-related table to a JSON file before deleting. */
async function backupHomepageTables(host: string): Promise<string> {
  const tables = await pgQuery<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_name = 'homepages' OR table_name = 'homepages_cmps'
        OR table_name LIKE 'components_home\\_%'
        OR table_name LIKE 'components_homepage\\_%'
     ORDER BY 1`
  );
  const backup: Record<string, unknown[]> = {};
  for (const { table_name } of tables) {
    backup[table_name] = await pgQuery(`SELECT * FROM "${table_name}"`);
  }
  backup["files_related_mph__homepage"] = await pgQuery(
    `SELECT * FROM "files_related_mph"
     WHERE related_type LIKE 'home%' OR related_type LIKE 'homepage%'`
  );

  const dir = path.resolve(__dirname, "../backups");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `homepage-${host}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(backup, null, 1));
  const rows = Object.values(backup).reduce((n, r) => n + r.length, 0);
  logger.info(`backup: ${Object.keys(backup).length} tables, ${rows} rows -> ${file}`);
  return file;
}

async function main() {
  const host = new URL(config.pg.connectionString).hostname;
  const requiredFlag = `--yes-i-mean-${host}`;

  logger.info(`reset-homepage target host: ${host}`);
  if (!process.argv.includes(requiredFlag)) {
    logger.error(
      `Refusing to run: this deletes the homepage row on ${host}. ` +
        `Re-run with ${requiredFlag} to confirm.`
    );
    process.exitCode = 1;
    return;
  }

  const existing = await pgQuery<{ id: number; title: string | null }>(
    `SELECT id, title FROM "homepages"`
  );
  if (existing.length === 0) {
    logger.info("No homepage row — nothing to reset.");
    return;
  }

  await backupHomepageTables(host);
  for (const row of existing) {
    logger.info(`Deleting homepage id=${row.id} title=${JSON.stringify(row.title)}`);
  }

  const deleted = await pgQuery<{ id: number }>(`DELETE FROM "homepages" RETURNING id`);
  const cmps = await pgQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM "homepages_cmps"`);
  logger.info(
    `Deleted ${deleted.length} row(s); homepages_cmps remaining: ${cmps[0].n} (0 = cascade worked).`
  );
  logger.info(`Reseed with: tsx src/index.ts --phase "13-site-content"`);
}

main()
  .catch((err) => {
    logger.error(`reset-homepage failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  })
  .finally(() => closePg());
