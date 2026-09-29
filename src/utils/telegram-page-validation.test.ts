import { describe, expect, it, vi } from 'vitest';
import { validateTelegramPage } from './telegram-page-validation';

function strapiWithCurrent(current: any = {}) {
  const findOne = vi.fn().mockResolvedValue(current);
  return { strapi: { db: { query: vi.fn(() => ({ findOne })) } } as any, findOne };
}

describe('telegram page validation', () => {
  it('accepts content edits and validates the slug shape', async () => {
    const { strapi } = strapiWithCurrent();
    await expect(validateTelegramPage(strapi, { hero: { titleLead: 'x' } })).resolves.toBeUndefined();
    await expect(validateTelegramPage(strapi, { slug: 'join-telegram' })).resolves.toBeUndefined();
    await expect(validateTelegramPage(strapi, { slug: 'Join Telegram' })).rejects.toThrow(/lowercase/);
  });

  it('requires the hero headline before the page can be enabled', async () => {
    const { strapi } = strapiWithCurrent({ hero: null });
    await expect(validateTelegramPage(strapi, { enabled: true })).rejects.toThrow(/headline/);
    await expect(validateTelegramPage(strapi, { enabled: true, hero: { titleLead: 'Never Miss a' } })).resolves.toBeUndefined();
    const saved = strapiWithCurrent({ hero: { titleLead: 'Saved' } });
    await expect(validateTelegramPage(saved.strapi, { enabled: true })).resolves.toBeUndefined();
    await expect(validateTelegramPage(saved.strapi, { enabled: true, hero: null })).rejects.toThrow(/headline/);
  });

  it('accepts twelve stores and rejects a thirteenth', async () => {
    const { strapi, findOne } = strapiWithCurrent();
    await expect(
      validateTelegramPage(strapi, { favouriteStores: { stores: Array.from({ length: 12 }, (_, id) => ({ id })) } }, 'ar'),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { locale: 'ar' } }));
    await expect(
      validateTelegramPage(strapi, { favouriteStores: { stores: Array.from({ length: 13 }, (_, id) => ({ id })) } }),
    ).rejects.toMatchObject({ details: { errors: [{ path: ['favouriteStores', 'stores'] }] } });
  });
});
