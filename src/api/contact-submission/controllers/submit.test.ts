import { describe, expect, it, vi } from 'vitest';
import createController from './submit';

const validBody = {
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  topic: 'Partnership opportunities',
  message: 'Please contact me.',
};

describe('contact submission', () => {
  it('rejects incomplete messages before any database write', async () => {
    const strapi = { documents: vi.fn() } as any;
    const ctx = {
      request: { body: { fullName: 'Jane', email: 'not-an-email' } },
      badRequest: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith(
      'Please complete all required fields.',
    );
    expect(strapi.documents).not.toHaveBeenCalled();
  });

  it('stores a normalized valid submission', async () => {
    const create = vi.fn().mockResolvedValue({});
    const strapi = { documents: vi.fn(() => ({ create })) } as any;
    const ctx = {
      request: {
        body: {
          ...validBody,
          fullName: '  Jane Doe  ',
          email: '  JANE@EXAMPLE.COM ',
        },
      },
      badRequest: vi.fn(),
      send: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(create).toHaveBeenCalledWith({
      data: {
        fullName: 'Jane Doe',
        email: 'jane@example.com',
        topic: 'Partnership opportunities',
        message: 'Please contact me.',
        status: 'new',
      },
    });
    expect(ctx.status).toBe(201);
    expect(ctx.send).toHaveBeenCalledWith({ data: { submitted: true } });
  });

  it('silently accepts a honeypot submission without persisting it', async () => {
    const strapi = { documents: vi.fn() } as any;
    const ctx = {
      request: { body: { ...validBody, company: 'Spam Incorporated' } },
      badRequest: vi.fn(),
      send: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(strapi.documents).not.toHaveBeenCalled();
    expect(ctx.status).toBe(201);
    expect(ctx.send).toHaveBeenCalledWith({ data: { submitted: true } });
  });
});
