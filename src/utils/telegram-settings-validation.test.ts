import { describe, expect, it, vi } from 'vitest';
import {
  normalizeTelegramSettings,
  validateTelegramSettings,
  validateTelegramSettingsForWrite,
} from './telegram-settings-validation';

const TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

describe('telegram settings validation', () => {
  it('accepts a complete enabled configuration', () => {
    expect(() =>
      validateTelegramSettings({ enabled: true, botToken: TOKEN, channel: '@couponzguru', pollIntervalMinutes: 5 }),
    ).not.toThrow();
    expect(() => validateTelegramSettings({ enabled: true, botToken: TOKEN, channel: '-1001234567890' })).not.toThrow();
  });

  it('requires token and channel only while enabled', () => {
    expect(() => validateTelegramSettings({ enabled: false })).not.toThrow();
    expect(() => validateTelegramSettings({ enabled: true })).toThrow(/2 problems/);
  });

  it('rejects malformed token, channel and username', () => {
    expect(() => validateTelegramSettings({ botToken: 'nope' })).toThrow(/BotFather/);
    expect(() => validateTelegramSettings({ channel: 'couponzguru' })).toThrow(/@username/);
    expect(() => validateTelegramSettings({ channelUsername: 'a b' })).toThrow(/username only/);
  });

  it('rejects out-of-range integers', () => {
    expect(() => validateTelegramSettings({ pollIntervalMinutes: 0 })).toThrow(/1 to 60/);
    expect(() => validateTelegramSettings({ feedPostCount: 13 })).toThrow(/1 to 12/);
    expect(() => validateTelegramSettings({ maxStoredPosts: 5.5 })).toThrow(/10 to 200/);
  });

  it('trims inputs and strips the @ from the username', () => {
    const data: any = { botToken: ` ${TOKEN} `, channel: ' @Chan ', channelUsername: '@Chan', title: 'x' };
    normalizeTelegramSettings(data);
    expect(data).toEqual({ botToken: TOKEN, channel: '@Chan', channelUsername: 'Chan', title: 'x' });
    const cleared: any = { botToken: '   ' };
    normalizeTelegramSettings(cleared);
    expect(cleared.botToken).toBeNull();
  });

  it('merges the stored row before checking the enabled rule', async () => {
    const findOne = vi.fn().mockResolvedValue({ botToken: TOKEN, channel: '@chan', enabled: false });
    const strapi = { db: { query: vi.fn(() => ({ findOne })) } } as any;
    await expect(validateTelegramSettingsForWrite(strapi, { enabled: true })).resolves.toBeUndefined();
    findOne.mockResolvedValue({ enabled: false });
    await expect(validateTelegramSettingsForWrite(strapi, { enabled: true })).rejects.toThrow(/required/);
  });
});
