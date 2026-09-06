import type { Core } from '@strapi/strapi';
import { loadSiteConfiguration, siteLanguages } from '../../site-configuration/services/site-configuration';
import { enqueueStandaloneIsrEvent } from '../../../isr-outbox/runtime';
import { buildRefreshRequest } from '../services/refresh-request';
import { pageTargets } from '../services/page-targets';
import { refreshStatus } from '../services/refresh-status';
import { boundOutboxPayload } from '../../../isr-outbox/payload';
import { readOutboxPayloadBounds } from '../../../isr-outbox/config';

export const WEBSITE_REFRESH_ACTION = 'admin::website-refresh.manage';
export const WEBSITE_REFRESH_ACTION_ATTRIBUTES = {
  section: 'settings', displayName: 'Refresh website cache', uid: 'website-refresh.manage',
  pluginName: 'admin', category: 'content management', subCategory: 'website refresh',
} as const;

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async options(ctx: any) {
    ctx.set('Cache-Control', 'private, no-store');
    const config = await loadSiteConfiguration(strapi);
    ctx.body = {
      country: config.countryCode, languages: siteLanguages(config),
      paths: await pageTargets(strapi, String(ctx.query?.uid ?? ''), String(ctx.query?.documentId ?? '')),
    };
  },
  async refresh(ctx: any) {
    const languages = siteLanguages(await loadSiteConfiguration(strapi));
    let request: ReturnType<typeof buildRefreshRequest>;
    try {
      request = buildRefreshRequest(ctx.request.body, languages);
      const bounds = readOutboxPayloadBounds();
      boundOutboxPayload(request.payload, bounds.maxPaths, bounds.maxPayloadBytes);
    }
    catch (error) { ctx.status = 400; ctx.body = { error: error instanceof Error ? error.message : 'Invalid request' }; return; }
    const event = await enqueueStandaloneIsrEvent(strapi, {
      ...request, reason: `manual-refresh:admin:${ctx.state.user.id}`,
    });
    ctx.set('Cache-Control', 'private, no-store');
    ctx.status = 202;
    ctx.body = { id: event.id, state: 'queued', message: 'Refresh queued. Existing cached pages remain available.' };
  },
  async status(ctx: any) {
    if (!/^\d+$/.test(String(ctx.params.id))) { ctx.status = 400; return; }
    ctx.set('Cache-Control', 'private, no-store');
    const result = await refreshStatus(strapi, String(ctx.params.id));
    ctx.status = result ? 200 : 404;
    ctx.body = result ?? { error: 'Refresh request not found.' };
  },
});
