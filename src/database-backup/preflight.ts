import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Core } from '@strapi/strapi';

import { databaseClient, isPostgresConnection } from '../utils/database-dialect';
import { databaseBackupProblems, type DatabaseBackupConfig } from './config';
import { toolVersion } from './pg-dump';

/**
 * Everything that must be true before the runner starts its loop. Problems
 * are sentences shown verbatim in the admin Storage tab, so a Super Admin can
 * see why no backups happen without reading container logs.
 */

export type PreflightResult = {
  ok: boolean;
  problems: string[];
  pgDumpVersion: string | null;
  pgRestoreVersion: string | null;
  serverVersion: string | null;
};

export async function readServerVersion(strapi: Core.Strapi): Promise<{ version: string; major: number } | null> {
  try {
    const result: any = await strapi.db.connection.raw(
      "SELECT current_setting('server_version') AS version, current_setting('server_version_num') AS num",
    );
    const row = result?.rows?.[0] ?? (Array.isArray(result) ? result[0] : null);
    if (!row) return null;
    const num = Number(row.num);
    return { version: String(row.version), major: Math.floor(num / 10_000) };
  } catch {
    return null;
  }
}

export async function runBackupPreflight(input: {
  strapi: Core.Strapi;
  config: DatabaseBackupConfig;
  childEnv: Record<string, string>;
  client: S3Client | null;
}): Promise<PreflightResult> {
  const { strapi, config } = input;
  const problems = databaseBackupProblems(config);

  if (!isPostgresConnection(strapi.db.connection)) {
    problems.push(
      `The database client is ${databaseClient(strapi.db.connection) ?? 'unknown'}; backups require PostgreSQL.`,
    );
  }

  const dump = await toolVersion(config.pgDumpPath, input.childEnv);
  if (!dump) problems.push(`pg_dump was not found at "${config.pgDumpPath}".`);
  const restore = await toolVersion(config.pgRestorePath, input.childEnv);
  if (!restore) problems.push(`pg_restore was not found at "${config.pgRestorePath}".`);

  const server = isPostgresConnection(strapi.db.connection) ? await readServerVersion(strapi) : null;
  if (dump && server && dump.major < server.major) {
    problems.push(
      `pg_dump ${dump.version} is older than the PostgreSQL ${server.version} server; install a client ≥ ${server.major}.`,
    );
  }

  if (input.client && config.s3.bucket && problems.length === 0) {
    try {
      await input.client.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    } catch (error: any) {
      problems.push(`The backup bucket is not reachable: ${String(error?.name ?? 'Error')}: ${String(error?.message ?? error)}`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    pgDumpVersion: dump?.version ?? null,
    pgRestoreVersion: restore?.version ?? null,
    serverVersion: server?.version ?? null,
  };
}
