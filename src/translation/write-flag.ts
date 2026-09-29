import { AsyncLocalStorage } from 'node:async_hooks';
import type { LocalizedWritePlan } from './field-map';

// Loop guard: the dispatcher's own documents-API writes flow through the
// SAME document middleware that enqueues translation jobs. Two independent
// checks keep them from re-enqueueing — the write targets a non-default
// locale, and this flag. Both, deliberately: either alone has failure modes
// (a future default-locale maintenance write; a lost async context).
export type TranslationWriteContext = Readonly<{
  sourceEntry: any | null;
  targetLocale: string;
  plan: LocalizedWritePlan | null;
  targetRowExisted: boolean;
  operation: 'upsert' | 'delete';
  assertPublicationLease?: (trx: any) => Promise<void>;
}>;

const translationWriteStorage = new AsyncLocalStorage<TranslationWriteContext>();

export function runWithTranslationWriteContext<T>(
  context: TranslationWriteContext,
  fn: () => Promise<T>,
): Promise<T> {
  return translationWriteStorage.run(context, fn);
}

/** Compatibility helper for tests/callers that do not need source parity. */
export function runWithTranslationWriteFlag<T>(fn: () => Promise<T>): Promise<T> {
  return runWithTranslationWriteContext(
    {
      sourceEntry: null,
      targetLocale: '',
      plan: null,
      targetRowExisted: true,
      operation: 'upsert',
    },
    fn,
  );
}

export function isTranslationWrite(): boolean {
  return translationWriteStorage.getStore() !== undefined;
}

export function translationWriteContext(): TranslationWriteContext | null {
  return translationWriteStorage.getStore() ?? null;
}
