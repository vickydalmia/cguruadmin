import { AsyncLocalStorage } from 'node:async_hooks';

// Loop guard: the dispatcher's own documents-API writes flow through the
// SAME document middleware that enqueues translation jobs. Two independent
// checks keep them from re-enqueueing — the write targets a non-default
// locale, and this flag. Both, deliberately: either alone has failure modes
// (a future default-locale maintenance write; a lost async context).
const translationWriteStorage = new AsyncLocalStorage<true>();

export function runWithTranslationWriteFlag<T>(fn: () => Promise<T>): Promise<T> {
  return translationWriteStorage.run(true, fn);
}

export function isTranslationWrite(): boolean {
  return translationWriteStorage.getStore() === true;
}
