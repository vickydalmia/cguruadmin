import type { Core } from '@strapi/strapi';
import {
  TELEGRAM_BOT_TOKEN_PATTERN,
  TELEGRAM_CHANNEL_PATTERN,
  TELEGRAM_CONFIG_LIMITS,
  TELEGRAM_CONFIG_UID,
  TELEGRAM_USERNAME_PATTERN,
} from '../constants/telegram';
import { toValidationError, type Problem } from './write-validation/problems';

const TEXT_FIELDS = ['botToken', 'channel', 'channelUsername'] as const;
const RANGE_FIELDS = ['pollIntervalMinutes', 'maxStoredPosts', 'feedPostCount'] as const;

/** Trim text inputs, drop a leading @ from the username, empty → null. */
export function normalizeTelegramSettings(data: any): void {
  if (!data || typeof data !== 'object') return;
  for (const field of TEXT_FIELDS) {
    if (typeof data[field] !== 'string') continue;
    let value = data[field].trim();
    if (field === 'channelUsername') value = value.replace(/^@/, '');
    data[field] = value || null;
  }
}

export function validateTelegramSettings(merged: any): void {
  const problems: Problem[] = [];
  const token = merged?.botToken;
  const channel = merged?.channel;
  const username = merged?.channelUsername;

  if (token != null && token !== '' && (typeof token !== 'string' || !TELEGRAM_BOT_TOKEN_PATTERN.test(token))) {
    problems.push({ path: ['botToken'], message: 'Paste the token exactly as @BotFather sent it (digits, a colon, then letters).' });
  }
  if (channel != null && channel !== '' && (typeof channel !== 'string' || !TELEGRAM_CHANNEL_PATTERN.test(channel))) {
    problems.push({ path: ['channel'], message: 'Use the public @username or the numeric -100… chat id.' });
  }
  if (username != null && username !== '' && (typeof username !== 'string' || !TELEGRAM_USERNAME_PATTERN.test(username))) {
    problems.push({ path: ['channelUsername'], message: 'Use the channel username only (letters, digits, underscores).' });
  }
  for (const field of RANGE_FIELDS) {
    const value = merged?.[field];
    if (value == null) continue;
    const { min, max } = TELEGRAM_CONFIG_LIMITS[field];
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push({ path: [field], message: `Enter a whole number from ${min} to ${max}.` });
    }
  }
  if (merged?.enabled === true) {
    if (!token) problems.push({ path: ['botToken'], message: 'A bot token is required while ingestion is enabled.' });
    if (!channel) problems.push({ path: ['channel'], message: 'A channel is required while ingestion is enabled.' });
  }
  if (problems.length) throw toValidationError(problems);
}

/**
 * The admin submits partial payloads (the token field stays untouched on most
 * saves), so validate the stored row merged with the change.
 */
export async function validateTelegramSettingsForWrite(
  strapi: Core.Strapi,
  data: any,
): Promise<void> {
  if (!data || typeof data !== 'object') return;
  normalizeTelegramSettings(data);
  const stored = await strapi.db.query(TELEGRAM_CONFIG_UID).findOne({});
  validateTelegramSettings({ ...(stored ?? {}), ...data });
}
