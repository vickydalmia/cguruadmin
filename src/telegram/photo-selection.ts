import { TELEGRAM_MAX_PHOTO_BYTES } from '../constants/telegram';
import type { TelegramMessage } from './bot-api';

export function largestPhoto(message: TelegramMessage) {
  const sizes = Array.isArray(message.photo) ? message.photo : [];
  const eligible = sizes.filter(size => (size.file_size ?? 0) <= TELEGRAM_MAX_PHOTO_BYTES);
  if (eligible.length === 0) return null;
  return eligible.reduce((best, size) => size.width * size.height > best.width * best.height ? size : best);
}

/** Download handles and unused renditions may change on a caption edit. */
export function samePhoto(left: TelegramMessage, right: TelegramMessage): boolean {
  return Boolean(left.photo?.length) === Boolean(right.photo?.length)
    && (largestPhoto(left)?.file_unique_id ?? null) === (largestPhoto(right)?.file_unique_id ?? null);
}
