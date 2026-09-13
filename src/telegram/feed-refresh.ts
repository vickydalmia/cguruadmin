import type { Core } from '@strapi/strapi';
import { readTelegramRoute } from '../api/telegram-page/services/telegram-route';
import { telegramFeedScope } from '../api/telegram-page/services/telegram-write';
import { createOutboxPayload } from '../isr-outbox/payload';
import { enqueueStandaloneIsrEvent } from '../isr-outbox/runtime';

/** One coalesced page event for committed feed batches and member-count changes. */
export async function enqueueTelegramFeedRefresh(strapi: Core.Strapi): Promise<void> {
  const scope = telegramFeedScope(await readTelegramRoute(strapi));
  if (scope) await enqueueStandaloneIsrEvent(strapi, {
    payload: createOutboxPayload(scope), reason: 'telegram:feed', eventKey: 'telegram-feed:page',
  });
}
