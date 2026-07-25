import { pgQuery } from "../db/pg-client.js";

export type MigrationRegistryRow = {
  document_id: string;
  source_key: string;
  target_table: string;
};

let registryReady: Promise<void> | null = null;

export function ensureMigrationRegistry(): Promise<void> {
  if (!registryReady) {
    registryReady = (async () => {
      await pgQuery(`
        CREATE TABLE IF NOT EXISTS "migration_source_entities" (
          "document_id" VARCHAR(255) PRIMARY KEY,
          "source_key" VARCHAR(255) NOT NULL,
          "target_table" VARCHAR(100) NOT NULL,
          "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pgQuery(`
        CREATE UNIQUE INDEX IF NOT EXISTS
          "migration_source_entities_target_source_uq"
        ON "migration_source_entities" ("target_table", "source_key")
      `);
    })();
  }
  return registryReady;
}

export async function registerMigratedEntity(input: {
  documentId: string;
  sourceKey: string;
  targetTable: string;
}): Promise<void> {
  await ensureMigrationRegistry();
  await pgQuery(
    `INSERT INTO "migration_source_entities" (
       "document_id", "source_key", "target_table"
     ) VALUES ($1, $2, $3)
     ON CONFLICT ("target_table", "source_key") DO UPDATE SET
       "document_id" = EXCLUDED."document_id",
       "updated_at" = NOW()`,
    [input.documentId, input.sourceKey, input.targetTable],
  );
}

export async function migrationRegistryRows(
  targetTable: string,
): Promise<MigrationRegistryRow[]> {
  await ensureMigrationRegistry();
  return pgQuery<MigrationRegistryRow>(
    `SELECT "document_id", "source_key", "target_table"
     FROM "migration_source_entities"
     WHERE "target_table" = $1`,
    [targetTable],
  );
}
