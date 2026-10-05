import { describe, expect, it, vi } from 'vitest';
import { festivalTemplateEnabled } from './festival-content';
import { validateFestivalPage } from './festival-validation';
const hero = { desktopImage: { url: '/desktop.png' }, altText: 'Savings' };
describe('Festival content', () => {
  it('activates only through the explicit flag, independent of content', () => {
    expect(festivalTemplateEnabled(null)).toBe(false);
    expect(festivalTemplateEnabled({})).toBe(false);
    expect(festivalTemplateEnabled({ enabled: false })).toBe(false);
    expect(festivalTemplateEnabled({ enabled: true })).toBe(true);
    expect(festivalTemplateEnabled({ ...{ hero }, enabled: true })).toBe(true);
  });
  it('validates partial countdown edits against the correct locale and permits removal', async () => {
    const findOne = vi.fn(async () => ({ countdown: { enabled: true, saleStartAt: '2026-10-02', saleEndAt: '2026-10-05', preSaleLabel: 'Starts', liveLabel: 'Ends', preSaleCtaLabel: 'Reserve', liveCtaLabel: 'Shop', preSaleCtaHref: '/offers/', liveCtaHref: '/offers/' } }));
    const strapi = { db: { query: () => ({ findOne }) } } as never;
    await expect(validateFestivalPage(strapi, { countdown: { saleEndAt: '2026-10-01' } }, 'ar')).rejects.toThrow(/end after the start/);
    expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { locale: 'ar' } }));
    await expect(validateFestivalPage(strapi, { countdown: null }, 'ar')).resolves.toBeUndefined();
    await expect(validateFestivalPage(strapi, { countdown: { enabled: false } }, 'ar')).resolves.toBeUndefined();
    await expect(validateFestivalPage(strapi, { hero: { linkUrl: 'javascript:alert(1)' } }, 'ar')).rejects.toThrow(/HTTP/);
  });
  it('addresses every invalid countdown value at an individual input', async () => {
    const strapi = { db: { query: () => ({ findOne: async () => null }) } } as never;
    const data = { title: 'Keep this title', hero: { desktopImage: 17, altText: 'Keep this image' }, countdown: {
      enabled: true, preSaleLabel: 'Starts', liveLabel: 'Ends', preSaleCtaLabel: 'Reserve', liveCtaLabel: 'Shop',
      preSaleCtaHref: '#top-picks', liveCtaHref: '#all-coupons',
    } };
    const original = structuredClone(data);
    await expect(validateFestivalPage(strapi, data)).rejects.toMatchObject({ details: { errors: [
      expect.objectContaining({ path: ['countdown', 'saleStartAt'] }),
      expect.objectContaining({ path: ['countdown', 'saleEndAt'] }),
      expect.objectContaining({ path: ['countdown', 'preSaleCtaHref'] }),
      expect.objectContaining({ path: ['countdown', 'liveCtaHref'] }),
    ] } });
    expect(data).toEqual(original);
  });

});
