import { describe, expect, it, vi } from 'vitest';
import { subscriptionWriteScope, syncSubscriptionRedirects } from './subscription-write';
import { createOutboxPayload } from '../../../isr-outbox/payload';

const before = { documentId: 'page', slug: 'subscribe', enabled: true };
describe('subscription ISR and redirect lifecycle', () => {
  it('refreshes page content and route/sitemap metadata on edits', () => {
    const payload = createOutboxPayload(subscriptionWriteScope(before, before));
    expect(payload.paths).toContain('/subscribe/');
    expect(payload.paths).toContain('/sitemap_index.xml');
    expect(payload.scopes).toContain('routes');
  });
  it('invalidates old and new paths and allows intentional absence', () => {
    const payload = createOutboxPayload(subscriptionWriteScope(before, { ...before, slug: 'join' }));
    expect(payload.paths).toContain('/join/');
    expect(payload.optionalPaths).toEqual(['/subscribe/']);
    expect(createOutboxPayload(subscriptionWriteScope(before, null)).optionalPaths).toEqual(['/subscribe/']);
    expect(createOutboxPayload(subscriptionWriteScope(before, { ...before, enabled: false })).optionalPaths).toEqual(['/subscribe/']);
  });
  it('creates a permanent redirect and retargets older aliases directly', async () => {
    const api = { findMany: vi.fn(async () => [{ documentId: 'older', from: '/newsletter/', to: '/subscribe/' }]), update: vi.fn(), create: vi.fn() };
    await syncSubscriptionRedirects({ documents: () => api } as any, before, { ...before, slug: 'join' });
    expect(api.update).toHaveBeenCalledWith({ documentId: 'older', data: { to: '/join/', statusCode: 301, active: true } });
    expect(api.create).toHaveBeenCalledWith({ data: { from: '/subscribe/', to: '/join/', statusCode: 301, active: true, managedBy: 'subscription-page:page' } });
  });
  it('deactivates a reused alias before retargeting others on rename-back', async () => {
    const writes: any[] = [];
    const api = { findMany: async () => [{ documentId: 'target', from: '/join/' }, { documentId: 'older', from: '/news/' }], update: async (write: any) => writes.push(write), create: vi.fn() };
    await syncSubscriptionRedirects({ documents: () => api } as any, before, { ...before, slug: 'join' });
    expect(writes[0]).toEqual({ documentId: 'target', data: { active: false } });
    expect(writes[1].data.to).toBe('/join/');
  });
  it('deactivates owned redirects on disable/delete and does no work for content-only edits', async () => {
    const api = { findMany: vi.fn(async () => [{ documentId: 'old' }]), update: vi.fn(), create: vi.fn() };
    await syncSubscriptionRedirects({ documents: () => api } as any, before, before);
    expect(api.findMany).not.toHaveBeenCalled();
    await syncSubscriptionRedirects({ documents: () => api } as any, before, null);
    expect(api.update).toHaveBeenCalledWith({ documentId: 'old', data: { active: false } });
    expect(api.create).not.toHaveBeenCalled();
  });
});
