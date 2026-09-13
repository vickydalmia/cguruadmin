import type { Core } from '@strapi/strapi';
import { TELEGRAM_POST_UID } from '../constants/telegram';
import type { TelegramMessage } from './bot-api';
import { parseTelegramPost } from './parse-post';
import { removeUploadedFile } from './post-media';
import { largestPhoto } from './photo-selection';
import { withTelegramFeedBatch } from './feed-batch';
import type { TelegramLease } from './worker-lease';

type UpsertOutcome = 'created' | 'updated' | 'skipped';

export type PreparedPhoto = { fileId: number; fileUniqueId: string } | null;
export async function upsertPost(
  strapi: Core.Strapi,
  message: TelegramMessage,
  username: string | null,
  photo: PreparedPhoto,
): Promise<{ outcome: UpsertOutcome; retiredPhoto?: any }> {
  const text = message.text ?? message.caption ?? '';
  const hasPhoto = Boolean(largestPhoto(message));
  if (!text.trim() && !hasPhoto) return { outcome: 'skipped' };

  const entities = message.entities ?? message.caption_entities ?? [];
  const parsed = parseTelegramPost(text, entities);
  const chatId = String(message.chat.id);
  const existing: any = await strapi.db.query(TELEGRAM_POST_UID).findOne({
    where: { chatId, messageId: message.message_id },
    populate: { photo: true } as any,
  });

  const base = {
    text: text || null,
    entities,
    editedAt: message.edit_date ? new Date(message.edit_date * 1000).toISOString() : null,
    permalink: username ? `https://t.me/${username}/${message.message_id}` : null,
    ...parsed,
  };

  if (existing && existing.text === (text || null)
    && (existing.editedAt ?? null) === base.editedAt
    && (existing.photoFileUniqueId ?? null) === (largestPhoto(message)?.file_unique_id ?? null)
    && (existing.permalink ?? null) === base.permalink) return { outcome: 'skipped' };

  if (existing) {
    const photoUniqueId = largestPhoto(message)?.file_unique_id ?? null;
    const photoChanged = photoUniqueId !== (existing.photoFileUniqueId ?? null);

    await strapi.documents(TELEGRAM_POST_UID as any).update({
      documentId: existing.documentId,
      data: {
        ...base,
        ...(photoChanged
          ? { photo: photo?.fileId ?? null, photoFileUniqueId: photo?.fileUniqueId ?? null }
          : {}),
      } as any,
    });
    return { outcome: 'updated', retiredPhoto: photoChanged ? existing.photo : undefined };
  }


  await strapi.documents(TELEGRAM_POST_UID as any).create({
    data: {
      messageId: message.message_id,
      chatId,
      postedAt: new Date(message.date * 1000).toISOString(),
      hidden: false,
      photo: photo?.fileId ?? null,
      photoFileUniqueId: photo?.fileUniqueId ?? null,
      ...base,
    } as any,
  });
  return { outcome: 'created' };
}

/** Matches retention's global storage order, including hidden/channel history. */
export async function outsidePostRetention(strapi: Core.Strapi, message: TelegramMessage, maxStoredPosts: number): Promise<boolean> {
  const [boundary]: any[] = await strapi.db.query(TELEGRAM_POST_UID).findMany({
    select: ['postedAt', 'messageId'],
    orderBy: [{ postedAt: 'desc' }, { messageId: 'desc' }, { id: 'desc' }],
    offset: maxStoredPosts - 1, limit: 1,
  });
  if (!boundary) return false;
  const postedAt = message.date * 1000;
  const cutoff = new Date(boundary.postedAt).getTime();
  // On an exact tie a new row wins by id, so it must not be discarded.
  return postedAt < cutoff || (postedAt === cutoff && message.message_id < Number(boundary.messageId));
}

/** Delete at most 100 records in one short content transaction. */
export async function enforceRetention(strapi: Core.Strapi, maxStoredPosts: number, lease?: TelegramLease): Promise<number> {
  const stale = await withTelegramFeedBatch(strapi, async trx => {
    await lease?.assertOwned(trx);
    const rows: any[] = await strapi.db.query(TELEGRAM_POST_UID).findMany({
      orderBy: [{ postedAt: 'desc' }, { messageId: 'desc' }, { id: 'desc' }],
      offset: maxStoredPosts, limit: 100, populate: { photo: true } as any,
    });
    for (const row of rows) await strapi.documents(TELEGRAM_POST_UID as any).delete({ documentId: row.documentId });
    return rows;
  });
  for (const row of stale) if (row.photo) await removeUploadedFile(strapi, row.photo);
  return stale.length;
}
