import { describe, expect, it, vi } from 'vitest';
import { syncTelegramRedirects, telegramFeedScope, telegramWriteScope } from './telegram-write';
import { createOutboxPayload } from '../../../isr-outbox/payload';

const before = { documentId: 'page', slug: 'join-telegram', enabled: true };

describe('telegram page ISR and redirect lifecycle', () => {
  it('refreshes page content and route/sitemap metadata on edits', () => {
    const payload = createOutboxPayload(telegramWriteScope(before, before));
    expect(payload.paths).toContain('/join-telegram/');
    expect(payload.paths).toContain('/sitemap_index.xml');
    expect(payload.scopes).toContain('routes');
  });
  it('invalidates old and new paths and allows intentional absence', () => {
    const payload = createOutboxPayload(telegramWriteScope(before, { ...before, slug: 'telegram' }));
    expect(payload.paths).toContain('/telegram/');
    expect(payload.optionalPaths).toEqual(['/join-telegram/']);
    expect(createOutboxPayload(telegramWriteScope(before, { ...before, enabled: false })).optionalPaths).toEqual(['/join-telegram/']);
  });
  it('creates a permanent redirect on rename and retires redirects on disable', async () => {
    const api = { findMany: vi.fn(async () => [{ documentId: 'older', from: '/tg/', to: '/join-telegram/' }]), update: vi.fn(), create: vi.fn() };
    await syncTelegramRedirects({ documents: () => api } as any, before, { ...before, slug: 'telegram' });
    expect(api.update).toHaveBeenCalledWith({ documentId: 'older', data: { to: '/telegram/', statusCode: 301, active: true } });
    expect(api.create).toHaveBeenCalledWith({ data: { from: '/join-telegram/', to: '/telegram/', statusCode: 301, active: true, managedBy: 'telegram-page:page' } });
    const disable = { findMany: vi.fn(async () => [{ documentId: 'old' }]), update: vi.fn(), create: vi.fn() };
    await syncTelegramRedirects({ documents: () => disable } as any, before, { ...before, enabled: false });
    expect(disable.update).toHaveBeenCalledWith({ documentId: 'old', data: { active: false } });
    expect(disable.create).not.toHaveBeenCalled();
  });
  it('does no work for content-only edits', async () => {
    const api = { findMany: vi.fn(), update: vi.fn(), create: vi.fn() };
    await syncTelegramRedirects({ documents: () => api } as any, before, before);
    expect(api.findMany).not.toHaveBeenCalled();
  });
  it('scopes feed changes to the live page only', () => {
    expect(telegramFeedScope(before)).toEqual({ slugs: ['join-telegram'] });
    expect(telegramFeedScope({ ...before, enabled: false })).toBeNull();
    expect(telegramFeedScope(null)).toBeNull();
  });
});
