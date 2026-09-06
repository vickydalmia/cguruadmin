// Every dictionary write changes text on EVERY storefront page, so the only
// honest invalidation is a full sweep. Coalesced by reason: while one
// `ui-dictionary` sweep is still pending, further writes add nothing.
import type { Core } from '@strapi/strapi';
import { enqueueCoalescedIsrSweep } from '../../isr-outbox/runtime';
import { UI_DICTIONARY_SWEEP_REASON } from './constants';

/** `chrome` drops the storefront's cached dictionaries; `routes` re-renders. */
export const UI_DICTIONARY_SWEEP_SCOPES = ['chrome', 'routes'] as const;

export function requestUiDictionarySweep(strapi: Core.Strapi) {
  return enqueueCoalescedIsrSweep(strapi, {
    reason: UI_DICTIONARY_SWEEP_REASON,
    scopes: [...UI_DICTIONARY_SWEEP_SCOPES],
  });
}
