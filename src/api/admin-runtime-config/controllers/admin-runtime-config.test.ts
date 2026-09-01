import { afterEach, describe, expect, it, vi } from 'vitest';

import createController from './admin-runtime-config';

describe('admin runtime config controller', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('returns the running deployment public origin', async () => {
    vi.stubEnv('PUBLIC_SITE_URL', 'https://www.couponzguruusa.com/path');
    const ctx = { send: vi.fn((body: unknown) => body) } as any;

    await createController().find(ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      data: { publicSiteUrl: 'https://www.couponzguruusa.com' },
    });
  });

  it('fails closed with null when the runtime value is absent or invalid', async () => {
    vi.stubEnv('PUBLIC_SITE_URL', 'javascript:alert(1)');
    const ctx = { send: vi.fn((body: unknown) => body) } as any;

    await createController().find(ctx);

    expect(ctx.send).toHaveBeenCalledWith({ data: { publicSiteUrl: null } });
  });
});
