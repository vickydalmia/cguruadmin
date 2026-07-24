import type { Core } from '@strapi/strapi';
import { hasOutboxWork } from './payload';
import { insertIsrOutboxEvent } from './store';
import type { IsrOutboxInsert } from './types';

export type CommittedIsrOutboxEvent = Readonly<{
  id: string;
  eventKey: string;
  reason: string;
  payload: IsrOutboxInsert['payload'];
}>;

export async function runContentTransaction<T>(
  strapi: Core.Strapi,
  executeWrite: () => Promise<T>,
  createEvent: (result: T) => Promise<IsrOutboxInsert | null>,
  afterCommit: (event: CommittedIsrOutboxEvent | null) => void,
): Promise<T> {
  return strapi.db.transaction(
    async ({ trx, onCommit }: { trx: any; onCommit: (fn: () => void) => void }) => {
      const result = await executeWrite();
      const input = await createEvent(result);
      const inserted =
        input && hasOutboxWork(input.payload)
          ? await insertIsrOutboxEvent(trx, input)
          : null;
      const event =
        inserted && input
          ? {
              ...inserted,
              reason: input.reason,
              payload: inserted.payload,
            }
          : null;
      onCommit(() => afterCommit(event));
      return result;
    },
  );
}
