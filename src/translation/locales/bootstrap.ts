import type { Core } from '@strapi/strapi';

import { ensureContentLocales } from '../ensure-locales';
import { primeEnabledContentLocales } from './registry';

/**
 * Boot-time content-locale bootstrap with recovery. The sync locale mirror
 * (`enabledContentLocaleCodesSync`) is read by hot paths that cannot await —
 * ISR path expansion, the redeem resolver, the public dictionary — so a
 * failed prime used to degrade every locale-aware read to English for the
 * whole process lifetime, and the translation dispatcher never started.
 *
 * Now a failure is retried in the background: 60 s, doubling to a 10-minute
 * cap, until `ensureContentLocales` + `primeEnabledContentLocales` succeed;
 * `onReady` (start the dispatcher and backfill runner) then runs exactly once.
 * India/USA (translation off) still succeed on the first attempt: the prime
 * simply records an empty list.
 */

const INITIAL_RETRY_MS = 60_000;
const MAX_RETRY_MS = 10 * 60_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

type BootstrapOptions = {
  onReady: () => Promise<void>;
  initialRetryMs?: number;
  maxRetryMs?: number;
};

async function attempt(strapi: Core.Strapi, onReady: () => Promise<void>): Promise<void> {
  await ensureContentLocales(strapi);
  await primeEnabledContentLocales(strapi);
  await onReady();
}

function describe(err: unknown): string {
  return String((err as any)?.message ?? err);
}

/**
 * Resolves `true` when the bootstrap succeeded synchronously, `false` when it
 * failed and a background retry was scheduled. Never throws.
 */
export async function bootstrapContentLocales(
  strapi: Core.Strapi,
  options: BootstrapOptions,
): Promise<boolean> {
  stopContentLocaleBootstrapRetry();
  const myGeneration = ++generation;
  const initial = options.initialRetryMs ?? INITIAL_RETRY_MS;
  const max = options.maxRetryMs ?? MAX_RETRY_MS;

  const schedule = (delay: number) => {
    timer = setTimeout(async () => {
      timer = null;
      if (myGeneration !== generation) return;
      try {
        await attempt(strapi, options.onReady);
        if (myGeneration === generation) {
          strapi.log.info('[translation] content-locale bootstrap recovered');
        }
      } catch (err) {
        if (myGeneration !== generation) return;
        const next = Math.min(delay * 2, max);
        strapi.log.warn(
          `[translation] content-locale bootstrap still failing: ${describe(err)}; retrying in ${Math.round(next / 1000)}s`,
        );
        schedule(next);
      }
    }, delay);
    timer.unref?.();
  };

  try {
    await attempt(strapi, options.onReady);
    return true;
  } catch (err) {
    strapi.log.error(
      `[translation] content-locale bootstrap failed: ${describe(err)}; retrying in ${Math.round(initial / 1000)}s`,
    );
    schedule(initial);
    return false;
  }
}

export function stopContentLocaleBootstrapRetry(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
}
