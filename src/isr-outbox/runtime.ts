import type { Core } from '@strapi/strapi';
import { readIsrOutboxConfig } from './config';
import { IsrOutboxDispatcher } from './dispatcher';
import { logIsrOutbox } from './log';
import { insertIsrOutboxEvent } from './store';
import type { IsrOutboxInsert } from './types';

let dispatcher: IsrOutboxDispatcher | null = null;

export function startIsrOutbox(strapi: Core.Strapi): void {
  const config = readIsrOutboxConfig();
  if (!config.gatewayUrl || !config.adminSecret) {
    const message =
      'ISR_GATEWAY_URL and ISR_ADMIN_SECRET are required for ISR outbox delivery';
    if (process.env.NODE_ENV === 'production') throw new Error(message);
    logIsrOutbox(strapi, 'warn', 'isr.outbox.dispatcher_disabled', {
      reason: message,
    });
    return;
  }
  dispatcher = new IsrOutboxDispatcher(strapi, config);
  dispatcher.start();
}

export function wakeIsrOutbox(): void {
  dispatcher?.wake();
}

export async function stopIsrOutbox(): Promise<void> {
  await dispatcher?.stop();
  dispatcher = null;
}

export async function enqueueStandaloneIsrEvent(
  strapi: Core.Strapi,
  input: IsrOutboxInsert,
): Promise<{ id: string; eventKey: string }> {
  return strapi.db.transaction(
    async ({ trx, onCommit }: { trx: any; onCommit: (fn: () => void) => void }) => {
      const event = await insertIsrOutboxEvent(trx, input);
      onCommit(wakeIsrOutbox);
      return event;
    },
  );
}
