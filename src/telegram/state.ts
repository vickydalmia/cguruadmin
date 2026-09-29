import type { Core } from '@strapi/strapi';
import { TELEGRAM_INGEST_STATE_KEY, TELEGRAM_INGEST_STORE } from '../constants/telegram';

/**
 * Runtime state of the ingest loop. Lives in the core store (not on the
 * Telegram single type) so the cron never writes content rows just to
 * record a heartbeat, and the state survives restarts.
 */
export type TelegramIngestState = {
  /** Next getUpdates offset (last update_id + 1); null before the first poll. */
  updateOffset: number | null;
  connectionKey?: string | null;
  channel?: string | null;
  chatId?: string | null;
  lastPolledAt: string | null;
  lastIngestedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  memberCount: number | null;
  memberCountAt: string | null;
};

export const EMPTY_TELEGRAM_INGEST_STATE: TelegramIngestState = {
  updateOffset: null,
  lastPolledAt: null,
  lastIngestedAt: null,
  lastError: null,
  lastErrorAt: null,
  memberCount: null,
  memberCountAt: null,
};

function store(strapi: Core.Strapi) {
  return strapi.store(TELEGRAM_INGEST_STORE);
}

const integerOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null);

export async function readTelegramIngestState(strapi: Core.Strapi): Promise<TelegramIngestState> {
  const stored = (await store(strapi).get({ key: TELEGRAM_INGEST_STATE_KEY })) as
    | Partial<TelegramIngestState>
    | null
    | undefined;
  if (!stored || typeof stored !== 'object') return { ...EMPTY_TELEGRAM_INGEST_STATE };
  return {
    updateOffset: integerOrNull(stored.updateOffset),
    connectionKey: stringOrNull(stored.connectionKey),
    channel: stringOrNull(stored.channel),
    chatId: stringOrNull(stored.chatId),
    lastPolledAt: stringOrNull(stored.lastPolledAt),
    lastIngestedAt: stringOrNull(stored.lastIngestedAt),
    lastError: stringOrNull(stored.lastError),
    lastErrorAt: stringOrNull(stored.lastErrorAt),
    memberCount: integerOrNull(stored.memberCount),
    memberCountAt: stringOrNull(stored.memberCountAt),
  };
}

export async function writeTelegramIngestState(
  strapi: Core.Strapi,
  state: TelegramIngestState,
): Promise<void> {
  await store(strapi).set({ key: TELEGRAM_INGEST_STATE_KEY, value: state });
}
