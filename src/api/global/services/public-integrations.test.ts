import { describe, it, expect } from 'vitest';
import { publicGlobalIntegrations, publicChannelFooter } from './public-integrations';

describe('public integration destinations', () => {
  it('uses shared URLs while preserving translated text and disabled banners', () => {
    const result = publicGlobalIntegrations({
      telegramCta: { enabled: false, heading: 'Arabic copy', ctaUrl: 'https://old.example' },
      sendyUrl: 'https://private.example', sendyListId: 'private-list',
    }, { telegramUrl: 'https://t.me/site', whatsappUrl: 'https://whatsapp.com/channel/site' });
    expect(result.telegramCta).toEqual({ enabled: false, heading: 'Arabic copy', ctaUrl: 'https://t.me/site' });
    expect(result).not.toHaveProperty('sendyUrl');
    expect(result).not.toHaveProperty('sendyListId');
  });
  it('replaces duplicate channel footer destinations and preserves other ordering', () => {
    const footer = { socialLinks: [
      { platform: 'telegram', url: 'https://old.example' },
      { platform: 'facebook', url: 'https://facebook.com/site' },
      { platform: 'whatsapp', url: 'https://old.example' },
    ] };
    expect(publicChannelFooter(footer, { telegramUrl: 'https://t.me/site', whatsappUrl: '' }).socialLinks).toEqual([
      { platform: 'facebook', url: 'https://facebook.com/site' },
      { platform: 'telegram', url: 'https://t.me/site' },
    ]);
    expect(footer.socialLinks).toHaveLength(3);
    expect(publicChannelFooter(null, {})).toBeNull();
  });
  it('does not fall back to the retired URL after the setting is cleared', () => {
    expect(publicGlobalIntegrations({ telegramCta: { ctaUrl: 'https://old.example' } }, {}).telegramCta.ctaUrl).toBe('');
  });
});
