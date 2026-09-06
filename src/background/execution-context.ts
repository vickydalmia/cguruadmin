import { AsyncResource } from 'node:async_hooks';

let context: AsyncResource | undefined;

/** Capture bootstrap's clean context before any asynchronous database work. */
export function initializeBackgroundContext(): void {
  context ??= new AsyncResource('cguru-background');
}

export function runInBackground<T>(work: () => T): T {
  if (!context) throw new Error('Background context must be initialized at bootstrap');
  return context.runInAsyncScope(work);
}
