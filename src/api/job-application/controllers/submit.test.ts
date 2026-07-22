import { describe, expect, it, vi } from 'vitest';
import createController from './submit';

describe('job application submission', () => {
  it('rejects incomplete applications before any upload or database write', async () => {
    const strapi = { documents: vi.fn(), plugin: vi.fn() } as any;
    const ctx = {
      request: { body: { jobSlug: 'graphic-designer', email: 'not-an-email' }, files: {} },
      badRequest: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith('Please complete all required fields.');
    expect(strapi.documents).not.toHaveBeenCalled();
    expect(strapi.plugin).not.toHaveBeenCalled();
  });
});
