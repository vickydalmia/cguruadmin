import type { Core } from '@strapi/strapi';
import { hasOutboxWork } from './payload';
import { insertIsrOutboxEvent } from './store';
import type { IsrOutboxInsert } from './types';

export async function runContentTransaction<T>(
  strapi: Core.Strapi,
  executeWrite: () => Promise<T>,
  createEvent: (result: T) => Promise<IsrOutboxInsert | null>,
  afterCommit: (event: { id: string; eventKey: string } | null) => void,
): Promise<T> {
  return strapi.db.transaction(
    async ({ trx, onCommit }: { trx: any; onCommit: (fn: () => void) => void }) => {
      const result = await executeWrite();
      const input = await createEvent(result);
      const event =
        input && hasOutboxWork(input.payload)
          ? await insertIsrOutboxEvent(trx, input)
          : null;
      onCommit(() => afterCommit(event));
      return result;
    },
  );
}
