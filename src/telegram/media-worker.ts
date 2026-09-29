import type { Core } from '@strapi/strapi';
import { createHash } from 'node:crypto';
import { ApiError } from '@fal-ai/client';
import { classifyFalError } from '../utils/deal-image-fal';
import { TELEGRAM_POST_UID } from '../constants/telegram';
import { DealImageProcessingError } from '../utils/deal-image-errors';
import { isPostgresConnection } from '../utils/database-dialect';
import type { BotApi } from './bot-api';
import { parseTelegramPost } from './parse-post';
import { rehostPhoto, removeUploadedFile } from './post-media';
import { largestPhoto, samePhoto } from './photo-selection';
import { upsertPost, enforceRetention, outsidePostRetention, type PreparedPhoto } from './posts';
import { withTelegramFeedBatch } from './feed-batch';
import { withTelegramLease, TelegramLeaseLost, type TelegramLease } from './worker-lease';
import { PhotoPending, PhotoSubmissionUncertain, resumableBackgroundRemoval } from './resumable-photo';
import { TELEGRAM_PENDING_TABLE, checkpointPending, pendingMessage, PendingRevisionChanged, retryPatch, type PendingMessage } from './pending-store';
import { photoDiagnostic, PhotoCheckComplete, PHOTO_DIAGNOSIS_REQUEST, type PhotoStep } from './photo-diagnostics';

async function ownedJob(trx: any, lease: TelegramLease, job: PendingMessage) {
  await lease.assertOwned(trx);
  let query = trx(TELEGRAM_PENDING_TABLE).where({ id: job.id });
  if (isPostgresConnection(trx)) query = query.forUpdate();
  const current: PendingMessage | undefined = await query.first();
  if (!current || (Number(current.update_id) !== Number(job.update_id) && !samePhoto(pendingMessage(current), pendingMessage(job)))) {
    throw new PendingRevisionChanged();
  }
  // Caption edits can arrive while external image work is running. Keep its
  // checkpoint, but fence against image replacements and publish fresh copy.
  job.update_id = current.update_id;
  job.message = current.message;
}

/** Retired jobs must never delete a photo used by a public post or another job. */
export async function cleanDiscardedMessages(strapi: Core.Strapi, jobs: PendingMessage[]) {
  for (const job of jobs) {
    if (!job.media_id) continue;
    const pending = await strapi.db.connection(TELEGRAM_PENDING_TABLE).where({ media_id: job.media_id }).first();
    const publicPost = await strapi.db.query(TELEGRAM_POST_UID).findOne({ where: { photo: { id: job.media_id } }, select: ['id'] });
    if (!pending && !publicPost) await removeUploadedFile(strapi, { id: job.media_id });
  }
}

async function processJob(strapi: Core.Strapi, api: BotApi, job: PendingMessage, username: string | null, lease: TelegramLease, maxStored: number, inspectOnly = false) {
  const message = pendingMessage(job);
  let step: PhotoStep = 'post-lookup';
  const onStep = (next: PhotoStep) => { step = next; };
  const checkpoint = async (patch: Partial<PendingMessage>) => {
    await strapi.db.transaction(async ({ trx }: any) => {
      await ownedJob(trx, lease, job);
      await checkpointPending(trx, job, patch);
    });
    Object.assign(job, patch);
  };
  try {
    const existing: any = await strapi.db.query(TELEGRAM_POST_UID).findOne({
      where: { chatId: job.chat_id, messageId: job.message_id }, populate: { photo: true } as any,
    });
    if (!inspectOnly && !existing && await outsidePostRetention(strapi, message, maxStored)) {
      await strapi.db.transaction(async ({ trx }: any) => {
        await ownedJob(trx, lease, job);
        await trx(TELEGRAM_PENDING_TABLE).where({ id: job.id, update_id: job.update_id }).delete();
      });
      await cleanDiscardedMessages(strapi, [job]);
      return 'skipped';
    }
    let photo: PreparedPhoto = null;
    const selected = largestPhoto(message);
    if (message.photo?.length && (!existing || existing.photoFileUniqueId !== selected?.file_unique_id)) {
      // Stable upload name recovers the narrow upload-success/checkpoint-failure
      // window without another paid preparation or a duplicate S3 object.
      const fingerprint = createHash('sha256').update(selected?.file_unique_id ?? 'invalid').digest('hex').slice(0, 16);
      const name = `telegram-${job.id}-${fingerprint}`;
      onStep('upload-lookup');
      const uploaded = await strapi.db.query('plugin::upload.file').findOne({
        where: job.media_id ? { id: job.media_id } : { name: `${name}-transparent.png` }, select: ['id'],
      });
      if (uploaded && selected) photo = { fileId: uploaded.id, fileUniqueId: selected.file_unique_id };
      else photo = await rehostPhoto(strapi, api, message, parseTelegramPost(message.text ?? message.caption, message.entities ?? message.caption_entities).title, {
        name: `${name}.png`, removeBackground: resumableBackgroundRemoval(job, checkpoint, onStep, inspectOnly), onStep,
        beforeUpload: async () => {
          if (inspectOnly) { onStep('image-upload'); throw new PhotoCheckComplete(); }
          await strapi.db.transaction(({ trx }: any) => ownedJob(trx, lease, job));
        },
        onUploaded: async id => {
          try { await checkpoint({ media_id: id, stage: 'uploaded', error_code: null, error_details: null }); }
          catch (error) {
            if (error instanceof PendingRevisionChanged) await cleanDiscardedMessages(strapi, [{ ...job, media_id: id }]);
            throw error;
          }
        },
      });
    }
    onStep('post-publish');
    if (inspectOnly) throw new PhotoCheckComplete();
    const result = await withTelegramFeedBatch(strapi, async trx => {
      await ownedJob(trx, lease, job);
      const result = await upsertPost(strapi, pendingMessage(job), username, photo);
      await trx(TELEGRAM_PENDING_TABLE).where({ id: job.id, update_id: job.update_id }).delete();
      return result;
    });
    onStep('photo-cleanup');
    if (result.retiredPhoto) await removeUploadedFile(strapi, result.retiredPhoto);
    return result.outcome;
  } catch (error) {
    const details = photoDiagnostic(error, step);
    if (error instanceof ApiError) error = classifyFalError(error);
    if (error instanceof TelegramLeaseLost || error instanceof PendingRevisionChanged) return 'skipped';
    if (inspectOnly) {
      // Diagnostic requests preserve retry/backoff and never publish a post.
      await checkpoint({ error_details: JSON.stringify(details) });
      return 'skipped';
    }
    if (error instanceof PhotoPending) await checkpoint({ error_code: null, error_details: null, next_attempt_at: new Date(Date.now() + 60_000) });
    else if (error instanceof DealImageProcessingError && error.code === 'BACKGROUND_REMOVAL_NOT_CONFIGURED') {
      await checkpoint({ error_code: error.code, error_details: JSON.stringify(details), next_attempt_at: new Date(Date.now() + 5 * 60_000) });
    } else {
      const uncertain = error instanceof PhotoSubmissionUncertain || (job.stage === 'submitting' && !job.request_id);
      const code = uncertain ? 'FAL_SUBMISSION_UNCERTAIN' : error instanceof DealImageProcessingError ? error.code : 'TELEGRAM_PHOTO_FAILED';
      await checkpoint({ ...retryPatch(job, code, !uncertain && (!(error instanceof DealImageProcessingError) || error.retryable)), error_details: JSON.stringify(details) });
      strapi.log.warn({ event: 'telegram.photo_deferred', messageId: job.message_id, code, attempts: job.attempts, details });
    }
    return 'skipped';
  }
}

/** One replica, no transaction around external work; publication is fenced. */
export async function runTelegramMediaWorker(strapi: Core.Strapi, api: BotApi, connectionKey: string, username: string | null, maxStored: number) {
  return await withTelegramLease(strapi, 'media', async lease => {
    const result = { created: 0, updated: 0, deleted: 0 };
    const check: PendingMessage | undefined = await strapi.db.connection(TELEGRAM_PENDING_TABLE)
      .where({ connection_key: connectionKey, error_details: PHOTO_DIAGNOSIS_REQUEST }).first();
    if (check) {
      await processJob(strapi, api, check, username, lease, maxStored, true);
      return result;
    }
    // Drain an old oversized feed before allowing more published growth.
    result.deleted += await enforceRetention(strapi, maxStored, lease);
    if (result.deleted === 100) return result;
    const jobs: PendingMessage[] = await strapi.db.connection(TELEGRAM_PENDING_TABLE)
      .where({ connection_key: connectionKey }).whereNot({ stage: 'blocked' }).andWhere('next_attempt_at', '<=', new Date())
      .orderBy([{ column: 'posted_at', order: 'desc' }, { column: 'message_id', order: 'desc' }]).limit(20);
    const deadline = Date.now() + 60_000;
    for (const job of jobs) {
      if (Date.now() >= deadline) break;
      const outcome = await processJob(strapi, api, job, username, lease, maxStored);
      if (outcome === 'created') result.created++;
      if (outcome === 'updated') result.updated++;
      if (outcome !== 'skipped') result.deleted += await enforceRetention(strapi, maxStored, lease);
    }
    return result;
  }) ?? { created: 0, updated: 0, deleted: 0 };
}
