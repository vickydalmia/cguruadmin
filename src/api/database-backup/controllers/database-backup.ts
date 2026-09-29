import type { Core } from '@strapi/strapi';

import {
  BACKUP_NOTE_MAX_LENGTH,
  BACKUP_RUNS_PAGE_SIZE_DEFAULT,
  BACKUP_RUNS_PAGE_SIZE_MAX,
} from '../../../constants/database-backup';
import { databaseBackupConfigured, readDatabaseBackupConfig } from '../../../database-backup/config';
import { logDatabaseBackup } from '../../../database-backup/log';
import { createBackupS3Client } from '../../../database-backup/s3-client';
import { deleteBackupObject, presignDownload, testBackupConnection } from '../../../database-backup/s3-objects';
import { parseBackupSettings, writeBackupSettings } from '../../../database-backup/settings';
import { getDatabaseBackupOverview } from '../../../database-backup/status';
import { enqueueRun, markDeleted, requestCancel, requestVerify } from '../../../database-backup/store';
import { getRunRow, listRuns, viewFromRow } from '../../../database-backup/store-rows';
import { wakeDatabaseBackupRunner } from '../../../database-backup/runner';

/**
 * Super-Admin endpoints behind the Database Backups settings page. Mounted on
 * the ADMIN router (src/register/admin-routes.ts) behind
 * `admin::isAuthenticatedAdmin` + `global::super-admin-only`; the page hides
 * itself for other roles, the policy is what enforces it.
 *
 * This controller runs in the admin container. It only writes rows and reads
 * status; the actual `pg_dump` happens in whichever container has
 * `BACKUP_RUNNER_ENABLED=true`, which picks the row up within one tick.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParsedRunsQuery =
  | { ok: true; page: number; pageSize: number }
  | { ok: false; message: string };

export function parseRunsQuery(query: Record<string, unknown> | undefined): ParsedRunsQuery {
  const read = (value: unknown, fallback: number): number => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
  };
  const page = read(query?.page, 1);
  if (Number.isNaN(page)) return { ok: false, message: 'page must be a positive integer' };
  const pageSize = read(query?.pageSize, BACKUP_RUNS_PAGE_SIZE_DEFAULT);
  if (Number.isNaN(pageSize) || pageSize > BACKUP_RUNS_PAGE_SIZE_MAX) {
    return { ok: false, message: `pageSize must be an integer between 1 and ${BACKUP_RUNS_PAGE_SIZE_MAX}` };
  }
  return { ok: true, page, pageSize };
}

export function parseNote(value: unknown): { ok: true; note: string | null } | { ok: false; message: string } {
  if (value === undefined || value === null) return { ok: true, note: null };
  if (typeof value !== 'string') return { ok: false, message: 'note must be a string' };
  const note = value.trim();
  if (note.length === 0) return { ok: true, note: null };
  if (note.length > BACKUP_NOTE_MAX_LENGTH) {
    return { ok: false, message: `note must be at most ${BACKUP_NOTE_MAX_LENGTH} characters` };
  }
  return { ok: true, note };
}

/** "Jane Doe <jane@example.com>" — what the history table shows for on-demand runs. */
export function requesterLabel(user: any): string | null {
  if (!user) return null;
  const name = [user.firstname, user.lastname].filter(Boolean).join(' ').trim();
  const email = typeof user.email === 'string' ? user.email : '';
  if (name && email) return `${name} <${email}>`;
  return name || email || (user.id ? `admin #${user.id}` : null);
}

function noStore(ctx: any): void {
  ctx.set('Cache-Control', 'private, no-store');
}

function storageClient() {
  const config = readDatabaseBackupConfig();
  if (!databaseBackupConfigured(config)) return null;
  return { config, client: createBackupS3Client(config) };
}

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async overview(ctx: any) {
    noStore(ctx);
    ctx.body = await getDatabaseBackupOverview(strapi);
  },

  async updateSettings(ctx: any) {
    noStore(ctx);
    const body = ctx.request.body?.data ?? ctx.request.body;
    const parsed = parseBackupSettings(body);
    if (parsed.ok === false) {
      ctx.status = 400;
      ctx.body = { error: { message: 'Invalid backup settings', details: { problems: parsed.problems } } };
      return;
    }
    const saved = await writeBackupSettings(strapi, parsed.value);
    logDatabaseBackup(strapi, 'info', 'backup.settings_updated', { by: ctx.state.user?.id, settings: saved });
    wakeDatabaseBackupRunner();
    ctx.body = saved;
  },

  async createRun(ctx: any) {
    noStore(ctx);
    const note = parseNote(ctx.request.body?.note);
    if (note.ok === false) return ctx.badRequest(note.message);
    const result = await enqueueRun(strapi, {
      trigger: 'manual',
      requestedById: Number(ctx.state.user?.id) || null,
      requestedByLabel: requesterLabel(ctx.state.user),
      note: note.note,
    });
    if (!result.created) {
      ctx.status = 409;
      ctx.body = { error: { message: 'A backup is already in progress.' }, run: viewFromRow(result.row) };
      return;
    }
    logDatabaseBackup(strapi, 'info', 'backup.requested', { runId: result.row.id, by: ctx.state.user?.id });
    wakeDatabaseBackupRunner();
    ctx.status = 202;
    ctx.body = { run: viewFromRow(result.row) };
  },

  async listRuns(ctx: any) {
    noStore(ctx);
    const parsed = parseRunsQuery(ctx.query);
    if (parsed.ok === false) return ctx.badRequest(parsed.message);
    ctx.body = await listRuns(strapi, { page: parsed.page, pageSize: parsed.pageSize });
  },

  async getRun(ctx: any) {
    noStore(ctx);
    const id = String(ctx.params?.id ?? '');
    if (!UUID.test(id)) return ctx.badRequest('invalid run id');
    const row = await getRunRow(strapi, id);
    if (!row) return ctx.notFound('Backup run not found.');
    ctx.body = { run: viewFromRow(row) };
  },

  async cancelRun(ctx: any) {
    noStore(ctx);
    const id = String(ctx.params?.id ?? '');
    if (!UUID.test(id)) return ctx.badRequest('invalid run id');
    const state = await requestCancel(strapi, id);
    if (state === 'not-active') {
      ctx.status = 409;
      ctx.body = { error: { message: 'This backup is not pending or running.' } };
      return;
    }
    logDatabaseBackup(strapi, 'info', 'backup.cancel_requested', { runId: id, by: ctx.state.user?.id, state });
    wakeDatabaseBackupRunner();
    const row = await getRunRow(strapi, id);
    ctx.body = { state, run: row ? viewFromRow(row) : null };
  },

  async verifyRun(ctx: any) {
    noStore(ctx);
    const id = String(ctx.params?.id ?? '');
    if (!UUID.test(id)) return ctx.badRequest('invalid run id');
    if (!(await requestVerify(strapi, id))) {
      ctx.status = 409;
      ctx.body = { error: { message: 'Only a stored backup that is not already being verified can be verified.' } };
      return;
    }
    logDatabaseBackup(strapi, 'info', 'backup.verify_requested', { runId: id, by: ctx.state.user?.id });
    wakeDatabaseBackupRunner();
    const row = await getRunRow(strapi, id);
    ctx.body = { run: row ? viewFromRow(row) : null };
  },

  async downloadUrl(ctx: any) {
    noStore(ctx);
    const id = String(ctx.params?.id ?? '');
    if (!UUID.test(id)) return ctx.badRequest('invalid run id');
    const row = await getRunRow(strapi, id);
    if (!row || row.status !== 'succeeded' || !row.s3_key) {
      return ctx.notFound('No stored archive for this run.');
    }
    const storage = storageClient();
    if (!storage) {
      ctx.status = 503;
      ctx.body = { error: { message: 'Backup storage is not configured on this server.' } };
      return;
    }
    const url = await presignDownload(storage.client, String(row.s3_bucket ?? storage.config.s3.bucket), String(row.s3_key));
    logDatabaseBackup(strapi, 'info', 'backup.download_url_issued', { runId: id, by: ctx.state.user?.id, key: row.s3_key });
    ctx.body = { url, expiresInSeconds: 900 };
  },

  async deleteRun(ctx: any) {
    noStore(ctx);
    const id = String(ctx.params?.id ?? '');
    if (!UUID.test(id)) return ctx.badRequest('invalid run id');
    const row = await getRunRow(strapi, id);
    if (!row || row.status !== 'succeeded') {
      ctx.status = 409;
      ctx.body = { error: { message: 'Only a stored backup can be deleted.' } };
      return;
    }
    const storage = storageClient();
    if (!storage) {
      ctx.status = 503;
      ctx.body = { error: { message: 'Backup storage is not configured on this server.' } };
      return;
    }
    if (row.s3_key) {
      await deleteBackupObject(storage.client, String(row.s3_bucket ?? storage.config.s3.bucket), String(row.s3_key));
    }
    await markDeleted(strapi, id, 'manual');
    logDatabaseBackup(strapi, 'info', 'backup.deleted', { runId: id, by: ctx.state.user?.id, key: row.s3_key });
    const updated = await getRunRow(strapi, id);
    ctx.body = { run: updated ? viewFromRow(updated) : null };
  },

  async testConnection(ctx: any) {
    noStore(ctx);
    const storage = storageClient();
    if (!storage) {
      ctx.status = 503;
      ctx.body = { error: { message: 'Backup storage is not configured on this server.' } };
      return;
    }
    ctx.body = await testBackupConnection(storage.client, storage.config);
  },
});
