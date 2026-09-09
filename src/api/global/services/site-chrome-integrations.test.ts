import { describe, it, expect, vi } from 'vitest';
import createHomepageController from '../../homepage/controllers/custom';

vi.mock('../../../translation/locales/registry', () => ({
  enabledContentLocaleCodesSync: () => ['ar'],
}));

describe('site-chrome integration wiring', () => {
  it('serves the same shared destinations in translated pages without exposing Sendy', async () => {
    const reads: any[] = [];
    const controller = createHomepageController({ strapi: {
      documents: (uid: string) => ({ findFirst: async (query: any) => {
        reads.push({ uid, ...query });
        if (uid === 'api::global.global') return query.locale === 'ar'
          ? { telegramCta: { heading: 'Arabic heading' }, telegramUrl: 'https://t.me/stale', sendyUrl: 'https://private.example', sendyListId: 'private-list' }
          : { telegramUrl: 'https://t.me/shared', whatsappUrl: 'https://whatsapp.com/channel/shared' };
        if (uid === 'api::footer.footer') return { sections: [], socialLinks: [{ platform: 'telegram', url: 'https://t.me/retired' }] };
        return null;
      } }),
      service: () => ({ publicSettings: async () => ({ features: {} }) }),
      contentType: () => ({}),
      contentAPI: { sanitize: { output: async (value: any) => value } },
    } as any });
    const response = await controller.siteChrome({ query: { locale: 'ar' }, state: { auth: null }, send: (body: any) => body } as any);
    expect(response.global.telegramUrl).toBe('https://t.me/shared');
    expect(response.global.telegramCta.heading).toBe('Arabic heading');
    expect(response.footer.socialLinks).toEqual([
      { platform: 'telegram', url: 'https://t.me/shared' },
      { platform: 'whatsapp', url: 'https://whatsapp.com/channel/shared' },
    ]);
    expect(JSON.stringify(response)).not.toContain('private');
    expect(reads).toContainEqual({ uid: 'api::global.global', locale: 'en', fields: ['telegramUrl', 'whatsappUrl'] });
  });
});
