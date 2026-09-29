import { purgeResponseCaches } from '../middlewares/cache';
import type { Core } from '@strapi/strapi';
import { randomUUID } from 'node:crypto';
import { runInBackground } from '../background/execution-context';
import { applyTranslationSettings } from '../api/site-configuration/services/translation-hot-apply';
import { loadSiteConfiguration } from '../api/site-configuration/services/site-configuration';
import { readTranslationOutboxConfig } from './outbox/config';
import { translationOutboxRunning } from './outbox/runtime';
import { writeWorkerHeartbeat } from './outbox/worker-health';

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;
let generation = 0;

/** One cheap configuration read per process; no queue scans on disabled sites. */
export function startTranslationConfigurationWatcher(strapi: Core.Strapi): void {
  stopTranslationConfigurationWatcher();
  const currentGeneration = generation;
  const workerId = randomUUID();
  let previous = '';
  let failures = 0;
  let retryAt = 0;
  const tick = async () => {
    if (busy || currentGeneration !== generation) return;
    busy = true;
    try {
      const configuration = await loadSiteConfiguration(strapi);
      if (currentGeneration !== generation) return;
      const key = JSON.stringify(configuration);
      if (key !== previous && Date.now() >= retryAt) {
        const result = await applyTranslationSettings(strapi);
        if (result.ok) {
          previous = key;
          failures = 0;
          retryAt = 0;
          purgeResponseCaches();
        } else {
          retryAt = Date.now() + Math.min(300_000, 15_000 * 2 ** Math.min(failures++, 5));
        }
      }
      if (currentGeneration === generation && configuration.translationEnabled && readTranslationOutboxConfig().enabled) {
        await writeWorkerHeartbeat(strapi, workerId, translationOutboxRunning() ? 'running' : 'paused');
      }
    } catch (error) {
      strapi.log.error(`[translation] configuration watcher: ${String(error)}`);
    } finally {
      busy = false;
    }
  };
  timer = runInBackground(() => setInterval(() => void runInBackground(tick), 15_000));
  timer.unref?.();
  void runInBackground(tick);
}

export function stopTranslationConfigurationWatcher(): void {
  generation += 1;
  if (timer) clearInterval(timer);
  timer = null;
}
