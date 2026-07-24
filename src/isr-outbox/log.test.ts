import { describe, expect, it, vi } from 'vitest';
import { logIsrOutbox } from './log';

describe('logIsrOutbox', () => {
  it('emits readable JSON with event details and affected paths', () => {
    const info = vi.fn();
    const strapi = { log: { info } } as any;

    logIsrOutbox(strapi, 'info', 'isr.outbox.enqueued', {
      outboxId: '42',
      payload: {
        paths: ['/', '/coupon/123/', '/amazon-coupons/'],
        scopes: ['routes'],
      },
    });

    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0]?.[0];
    expect(typeof line).toBe('string');
    expect(line).not.toBe('[object Object]');
    expect(JSON.parse(line)).toEqual({
      event: 'isr.outbox.enqueued',
      component: 'isr-outbox',
      outboxId: '42',
      payload: {
        paths: ['/', '/coupon/123/', '/amazon-coupons/'],
        scopes: ['routes'],
      },
    });
  });
});
