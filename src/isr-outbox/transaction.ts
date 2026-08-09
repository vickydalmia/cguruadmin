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

/**
 * `createEvent` receives the write's own transaction as its second argument.
 *
 * It runs BEFORE the commit, while `executeWrite()` still holds row locks on
 * everything it touched. Any write it performs must therefore go through this
 * `trx` — issuing it on a pool connection instead waits on a lock that cannot
 * be released until this callback returns, which is a self-deadlock with no
 * timeout. See the note on `touchEntityPageUpdatedAt`, which is exactly the
 * bug this parameter exists to prevent.
 */
export async function runContentTransaction<T>(
  strapi: Core.Strapi,
  executeWrite: (trx: any) => Promise<T>,
  createEvent: (result: T, trx: any) => Promise<IsrOutboxInsert | null>,
  afterCommit: (event: CommittedIsrOutboxEvent | null) => void,
): Promise<T> {
  return strapi.db.transaction(
    async ({ trx, onCommit }: { trx: any; onCommit: (fn: () => void) => void }) => {
      const result = await executeWrite(trx);
      const input = await createEvent(result, trx);
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
