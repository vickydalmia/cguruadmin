import { createHash } from 'node:crypto';
import type { TelegramMessage, TelegramUpdate } from './bot-api';
import { samePhoto } from './photo-selection';

export const TELEGRAM_PENDING_TABLE = 'telegram_pending_messages';
export type PendingMessage = {
  id: string; connection_key: string; chat_id: string; message_id: number;
  update_id: number; posted_at: string | Date; message: string;
  stage: 'pending' | 'submitting' | 'submitted' | 'uploaded' | 'blocked';
  attempts: number; next_attempt_at: string | Date; error_code: string | null;
  error_details?: string | null;
  request_id: string | null; submitted_at: string | Date | null; media_id: number | null;
};

export function pendingMessage(row: PendingMessage): TelegramMessage { return JSON.parse(row.message); }

/** Persist before acknowledging the Telegram offset. The caller owns trx. */
export async function savePendingMessages(
  trx: any, connectionKey: string, updates: TelegramUpdate[], maxStored: number, now: Date,
): Promise<PendingMessage[]> {
  const discarded: PendingMessage[] = [];
  for (const update of updates) {
    const message = update.channel_post ?? update.edited_channel_post;
    if (!message) continue;
    const identity = { connection_key: connectionKey, chat_id: String(message.chat.id), message_id: message.message_id };
    const existing: PendingMessage | undefined = await trx(TELEGRAM_PENDING_TABLE).where(identity).first();
    if (existing && Number(existing.update_id) >= update.update_id) continue;
    const photoUnchanged = existing && samePhoto(pendingMessage(existing), message);
    const data = {
      ...identity,
      id: createHash('sha256').update(`${connectionKey}:${message.chat.id}:${message.message_id}`).digest('hex'),
      update_id: update.update_id, posted_at: new Date(message.date * 1000), message: JSON.stringify(message),
      ...(!photoUnchanged ? { stage: 'pending', attempts: 0, request_id: null, submitted_at: null, media_id: null, error_code: null, error_details: null, next_attempt_at: now } : {}),
    };
    if (existing) {
      if (!photoUnchanged) discarded.push(existing);
      await trx(TELEGRAM_PENDING_TABLE).where({ id: existing.id }).update(data);
    } else await trx(TELEGRAM_PENDING_TABLE).insert(data);
  }
  // Pending source records have a separate bounded budget; a provider outage
  // cannot evict the last successfully published feed.
  const stale: PendingMessage[] = await trx(TELEGRAM_PENDING_TABLE).where({ connection_key: connectionKey })
    .orderBy([{ column: 'posted_at', order: 'desc' }, { column: 'message_id', order: 'desc' }]).offset(maxStored);
  if (stale.length) await trx(TELEGRAM_PENDING_TABLE).whereIn('id', stale.map(row => row.id)).delete();
  return [...discarded, ...stale];
}

export async function checkpointPending(trx: any, job: PendingMessage, patch: Partial<PendingMessage>): Promise<void> {
  const changed = await trx(TELEGRAM_PENDING_TABLE).where({ id: job.id, update_id: job.update_id }).update(patch);
  if (!changed) throw new PendingRevisionChanged();
  Object.assign(job, patch);
}

export class PendingRevisionChanged extends Error {
  constructor() { super('Telegram message was replaced or retired'); }
}

const BACKOFF_MINUTES = [1, 5, 15, 60];
export function retryPatch(job: PendingMessage, code: string, retryable: boolean, now = new Date()): Partial<PendingMessage> {
  const attempts = Number(job.attempts) + 1;
  const blocked = !retryable || attempts >= 5;
  return {
    attempts, error_code: code, ...(blocked ? { stage: 'blocked' as const } : {}),
    next_attempt_at: new Date(now.getTime() + (BACKOFF_MINUTES[Math.min(attempts - 1, 3)] * 60_000)),
  };
}
