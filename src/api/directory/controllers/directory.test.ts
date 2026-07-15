import { describe, expect, it, vi } from 'vitest';
import createController from './directory';

describe('directory controller', () => {
  it('rejects unsupported kinds without calling the service', async () => {
    const getDirectory = vi.fn();
    const controller = createController({
      strapi: { service: vi.fn(() => ({ getDirectory })) } as any,
    });
    const ctx = {
      params: { kind: 'coupon' },
      badRequest: vi.fn((message) => message),
      send: vi.fn(),
    };

    await controller.find(ctx);

    expect(ctx.badRequest).toHaveBeenCalledOnce();
    expect(getDirectory).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it('returns the requested directory aggregate without a data envelope', async () => {
    const payload = { kind: 'brand', items: [] };
    const getDirectory = vi.fn().mockResolvedValue(payload);
    const controller = createController({
      strapi: { service: vi.fn(() => ({ getDirectory })) } as any,
    });
    const ctx = {
      params: { kind: 'brand' },
      badRequest: vi.fn(),
      send: vi.fn((value) => value),
    };

    await controller.find(ctx);

    expect(getDirectory).toHaveBeenCalledWith('brand');
    expect(ctx.send).toHaveBeenCalledWith(payload);
  });
});
