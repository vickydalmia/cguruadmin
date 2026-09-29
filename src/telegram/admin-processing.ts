import type { Core } from '@strapi/strapi';
import { TELEGRAM_PENDING_TABLE, type PendingMessage } from './pending-store';
import { readTelegramIngestState } from './state';
import { withTelegramLease } from './worker-lease';
import { TELEGRAM_POST_UID } from '../constants/telegram';
import { parseTelegramPost } from './parse-post';
import { readPhotoDiagnostic, PHOTO_DIAGNOSIS_REQUEST } from './photo-diagnostics';

export async function listTelegramProcessing(strapi: Core.Strapi, page: number) {
  const state = await readTelegramIngestState(strapi);
  if (!state.connectionKey) return { jobs: [], total: 0 };
  const query = () => strapi.db.connection(TELEGRAM_PENDING_TABLE).where({ connection_key: state.connectionKey });
  const [rows, count] = await Promise.all([
    query().orderBy('posted_at', 'desc').offset((page - 1) * 20).limit(20),
    query().count({ total: '*' }).first(),
  ]);
  return { total: Number(count?.total ?? 0), jobs: rows.map((row: PendingMessage) => ({
    id: row.id, revision: Number(row.update_id), messageId: row.message_id,
    stage: row.stage, attempts: row.attempts, error: row.error_code, nextAttemptAt: row.next_attempt_at,
    errorDetails: readPhotoDiagnostic(row.error_details),
    checking: row.error_details === PHOTO_DIAGNOSIS_REQUEST,
    title: parseTelegramPost(JSON.parse(row.message).text ?? JSON.parse(row.message).caption, []).title,
    postedAt: row.posted_at,
  })) };
}

/** Explicit read-only projection. No bot settings or provider request data. */
export async function listStoredTelegramPosts(strapi: Core.Strapi, page: number) {
  const query = strapi.db.query(TELEGRAM_POST_UID);
  const [rows, total] = await Promise.all([
    query.findMany({ select: ['documentId', 'messageId', 'title', 'postedAt', 'hidden', 'permalink'],
      populate: { photo: { select: ['url', 'alternativeText', 'formats'] } } as any,
      orderBy: [{ postedAt: 'desc' }, { messageId: 'desc' }], offset: (page - 1) * 20, limit: 20 }),
    query.count(),
  ]);
  return { total, jobs: rows.map((row: any) => ({
    id: row.documentId, messageId: row.messageId, title: row.title, postedAt: row.postedAt,
    stage: row.hidden ? 'hidden' : 'ready', permalink: row.permalink,
    photo: row.photo ? { url: row.photo.formats?.thumbnail?.url ?? row.photo.formats?.small?.url ?? row.photo.url, alt: row.photo.alternativeText ?? row.title ?? '' } : null,
  })) };
}

export async function retryTelegramProcessing(strapi: Core.Strapi, id: string, revision: number, newProcessing: boolean) {
  // Same lease as the media worker prevents resetting an in-flight paid call.
  return withTelegramLease(strapi, 'media', lease => strapi.db.transaction(async ({ trx }: any) => {
    await lease.assertOwned(trx);
    const state = await readTelegramIngestState(strapi);
    const where = { id, update_id: revision, connection_key: state.connectionKey };
    const job: PendingMessage | undefined = await trx(TELEGRAM_PENDING_TABLE).where(where).first();
    if (!job) return false;
    if ((job.stage === 'submitting' || job.error_code === 'FAL_SUBMISSION_UNCERTAIN') && !newProcessing) return false;
    await trx(TELEGRAM_PENDING_TABLE).where(where).update({
      attempts: 0, error_code: null, error_details: null, next_attempt_at: new Date(),
      stage: job.media_id ? 'uploaded' : !newProcessing && job.request_id ? 'submitted' : 'pending',
      ...(newProcessing && !job.media_id ? { request_id: null, submitted_at: null } : {}),
    });
    return true;
  }));
}

/** Ask the normal worker for one non-billable check; credentials stay there. */
export async function requestTelegramPhotoCheck(strapi: Core.Strapi, id: string, revision: number) {
  return withTelegramLease(strapi, 'media', lease => strapi.db.transaction(async ({ trx }: any) => {
    await lease.assertOwned(trx);
    const state = await readTelegramIngestState(strapi);
    return Boolean(await trx(TELEGRAM_PENDING_TABLE)
      .where({ id, update_id: revision, connection_key: state.connectionKey })
      .whereNotNull('error_code').update({ error_details: PHOTO_DIAGNOSIS_REQUEST }));
  }));
}
