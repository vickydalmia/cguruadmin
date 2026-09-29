import type { Core } from '@strapi/strapi';
import { createHash } from 'node:crypto';
import { savePendingMessages, TELEGRAM_PENDING_TABLE } from './pending-store';
import { runTelegramMediaWorker, cleanDiscardedMessages } from './media-worker';
import type { TelegramLease } from './worker-lease';
import { withTelegramLease } from './worker-lease';
import { enqueueTelegramFeedRefresh } from './feed-refresh';
import {
  TELEGRAM_CONFIG_DEFAULTS,
  TELEGRAM_CONFIG_UID,
  TELEGRAM_MAX_UPDATE_PAGES,
  TELEGRAM_MEMBER_COUNT_REFRESH_MS,
} from '../constants/telegram';
import {
  createBotApi,
  redactBotToken,
  type BotApi,
  type TelegramMessage,
} from './bot-api';
import { readTelegramIngestState, writeTelegramIngestState } from './state';

// Polling commits matching messages and the next offset together. A separate
// bounded worker prepares photos and publishes ready posts on every cron tick,
// including ticks before the next poll is due. Both workers use renewable
// leases without holding database connections during external requests.

export type TelegramIngestSkipReason = 'disabled' | 'unconfigured' | 'not-due' | 'running';

export type TelegramIngestResult = {
  skipped: TelegramIngestSkipReason | null;
  created: number;
  updated: number;
  deleted: number;
  error: string | null;
};

export type TelegramIngestConfig = {
  enabled: boolean;
  botToken: string | null;
  channel: string | null;
  channelUsername: string | null;
  pollIntervalMinutes: number;
  maxStoredPosts: number;
};

export type RunTelegramIngestOptions = {
  now?: Date;
  /** Ignore the poll interval (manual trigger). */
  force?: boolean;
  /** Test seam: build the API client from the token. */
  createApi?: (token: string) => BotApi;
};

const running = new WeakSet<Core.Strapi>();

const ALLOWED_UPDATES = ['channel_post', 'edited_channel_post'];

export async function loadTelegramIngestConfig(strapi: Core.Strapi): Promise<TelegramIngestConfig | null> {
  const row: any = await strapi.documents(TELEGRAM_CONFIG_UID as any).findFirst({
    fields: ['enabled', 'botToken', 'channel', 'channelUsername', 'pollIntervalMinutes', 'maxStoredPosts'] as any,
  });
  if (!row) return null;
  const integer = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return {
    enabled: row.enabled === true,
    botToken: typeof row.botToken === 'string' && row.botToken.trim() ? row.botToken.trim() : null,
    channel: typeof row.channel === 'string' && row.channel.trim() ? row.channel.trim() : null,
    channelUsername:
      typeof row.channelUsername === 'string' && row.channelUsername.trim()
        ? row.channelUsername.trim().replace(/^@/, '')
        : null,
    pollIntervalMinutes: integer(row.pollIntervalMinutes, TELEGRAM_CONFIG_DEFAULTS.pollIntervalMinutes),
    maxStoredPosts: integer(row.maxStoredPosts, TELEGRAM_CONFIG_DEFAULTS.maxStoredPosts),
  };
}

/** Username used for public permalinks: explicit override, else an @channel. */
export function channelUsernameFor(config: Pick<TelegramIngestConfig, 'channel' | 'channelUsername'>): string | null {
  if (config.channelUsername) return config.channelUsername;
  if (config.channel?.startsWith('@')) return config.channel.slice(1);
  return null;
}

/** True when a message was posted in the configured channel. */
export function messageMatchesChannel(message: TelegramMessage, channel: string): boolean {
  const chat = message.chat;
  if (!chat) return false;
  if (channel.startsWith('@')) {
    return typeof chat.username === 'string' && chat.username.toLowerCase() === channel.slice(1).toLowerCase();
  }
  return String(chat.id) === channel;
}

async function pollUpdates(
  strapi: Core.Strapi, config: TelegramIngestConfig, api: BotApi,
  lease: TelegramLease, options: RunTelegramIngestOptions,
) {
  const now = options.now ?? new Date();
  let state = await readTelegramIngestState(strapi);
  const connectionKey = createHash('sha256').update(`${config.botToken}:${config.channel!.toLowerCase()}`).digest('hex');
  if (state.connectionKey !== connectionKey) {
    const next = { ...state, connectionKey, channel: config.channel!.toLowerCase(),
      ...(state.connectionKey ? { updateOffset: null, lastPolledAt: null, memberCount: null, memberCountAt: null, chatId: null } : {}) };
    const stale = await strapi.db.transaction(async ({ trx }: any) => {
      await lease.assertOwned(trx);
      const rows = await trx(TELEGRAM_PENDING_TABLE).whereNot({ connection_key: connectionKey });
      await trx(TELEGRAM_PENDING_TABLE).whereNot({ connection_key: connectionKey }).delete();
      await writeTelegramIngestState(strapi, next);
      return rows;
    });
    await cleanDiscardedMessages(strapi, stale);
    state = next;
  }
  if (!options.force && state.lastPolledAt && now.getTime() < new Date(state.lastPolledAt).getTime() + config.pollIntervalMinutes * 60_000) {
    const discarded = await strapi.db.transaction(async ({ trx }: any) => {
      await lease.assertOwned(trx);
      return savePendingMessages(trx, connectionKey, [], config.maxStoredPosts, now);
    });
    await cleanDiscardedMessages(strapi, discarded);
    return { state, skipped: 'not-due' as const, error: null };
  }
  try {
    const discarded = await strapi.db.transaction(async ({ trx }: any) => {
      await lease.assertOwned(trx);
      return savePendingMessages(trx, connectionKey, [], config.maxStoredPosts, now);
    });
    await cleanDiscardedMessages(strapi, discarded);
    const deadline = Date.now() + 60_000;
    for (let page = 0; page < TELEGRAM_MAX_UPDATE_PAGES && Date.now() < deadline; page++) {
      const updates = await api.getUpdates({
        ...(state.updateOffset !== null ? { offset: state.updateOffset } : {}),
        limit: 100, timeout: 0, allowed_updates: ALLOWED_UPDATES,
      });
      if (!updates.length) break;
      const matching = updates.filter(update => {
        const message = update.channel_post ?? update.edited_channel_post;
        return message && messageMatchesChannel(message, config.channel!);
      });
      const message = matching.at(-1)?.channel_post ?? matching.at(-1)?.edited_channel_post;
      const next = { ...state, updateOffset: Math.max(...updates.map(update => update.update_id)) + 1,
        ...(message ? { chatId: String(message.chat.id), lastIngestedAt: now.toISOString() } : {}) };
      const discarded = await strapi.db.transaction(async ({ trx }: any) => {
        await lease.assertOwned(trx);
        const stale = await savePendingMessages(trx, connectionKey, matching, config.maxStoredPosts, now);
        await writeTelegramIngestState(strapi, next);
        return stale;
      });
      state = next;
      await cleanDiscardedMessages(strapi, discarded);
      if (updates.length < 100) break;
    }
    let memberCount = state.memberCount;
    let memberCountAt = state.memberCountAt;
    if (!memberCountAt || now.getTime() - new Date(memberCountAt).getTime() >= TELEGRAM_MEMBER_COUNT_REFRESH_MS) {
      try {
        memberCount = await api.getChatMemberCount(config.channel!);
        memberCountAt = now.toISOString();
      } catch {
        strapi.log.warn('[telegram] member count unavailable');
      }
    }
    const next = { ...state, lastPolledAt: now.toISOString(), lastError: null, lastErrorAt: null, memberCount, memberCountAt };
    await strapi.db.transaction(async ({ trx }: any) => {
      await lease.assertOwned(trx);
      await writeTelegramIngestState(strapi, next);
      if (memberCount !== state.memberCount) await enqueueTelegramFeedRefresh(strapi);
    });
    return { state: next, skipped: null, error: null };
  } catch (error: any) {
    const message = redactBotToken(error?.message ?? String(error), config.botToken).slice(0, 500);
    strapi.log.error({ event: 'telegram.ingest_failed', error: message });
    await strapi.db.transaction(async ({ trx }: any) => {
      await lease.assertOwned(trx);
      await writeTelegramIngestState(strapi, { ...state, lastPolledAt: now.toISOString(), lastError: message, lastErrorAt: now.toISOString() });
    }).catch(() => undefined);
    return { state, skipped: null, error: message };
  }
}

/** Polling and media have separate leases; neither holds a connection over I/O. */
export async function runTelegramIngest(strapi: Core.Strapi, options: RunTelegramIngestOptions = {}): Promise<TelegramIngestResult> {
  const empty: TelegramIngestResult = { skipped: null, created: 0, updated: 0, deleted: 0, error: null };
  if (running.has(strapi)) return { ...empty, skipped: 'running' };
  running.add(strapi);
  try {
    const config = await loadTelegramIngestConfig(strapi);
    if (!config?.enabled) return { ...empty, skipped: 'disabled' };
    if (!config.botToken || !config.channel) {
      strapi.log.warn('[telegram] ingestion is enabled but the connection is incomplete');
      return { ...empty, skipped: 'unconfigured' };
    }
    const api = options.createApi?.(config.botToken) ?? createBotApi({ token: config.botToken });
    const poll = await withTelegramLease(strapi, 'ingest', lease => pollUpdates(strapi, config, api, lease, options));
    if (!poll) return { ...empty, skipped: 'running' };
    const media = poll.state.connectionKey
      ? await runTelegramMediaWorker(strapi, api, poll.state.connectionKey, channelUsernameFor(config), config.maxStoredPosts)
      : {};
    return { ...empty, ...media, skipped: poll.skipped, error: poll.error };
  } finally {
    running.delete(strapi);
  }
}
