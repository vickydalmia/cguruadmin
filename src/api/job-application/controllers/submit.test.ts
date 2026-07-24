import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import createController from './submit';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const validBody = {
  jobSlug: 'graphic-designer',
  fullName: 'Jane Doe',
  email: 'jane@example.com',
  phone: '+1 555 0100',
};

describe('job application submission', () => {
  let dir: string;
  let pdfPath: string;
  let exePath: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'submit-controller-'));
    pdfPath = join(dir, 'real.pdf');
    exePath = join(dir, 'evil.bin');
    await writeFile(
      pdfPath,
      Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]),
    );
    await writeFile(exePath, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

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

  it('rejects an executable disguised as a PDF before any upload or database work', async () => {
    const strapi = { documents: vi.fn(), plugin: vi.fn() } as any;
    const ctx = {
      request: {
        body: validBody,
        files: {
          resume: {
            name: 'resume.pdf',
            type: 'application/pdf',
            size: 66,
            filepath: exePath,
          },
        },
      },
      badRequest: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith('Resume must be a PDF or DOCX file.');
    expect(strapi.documents).not.toHaveBeenCalled();
    expect(strapi.plugin).not.toHaveBeenCalled();
  });

  it('rejects a declared type outside the allow list even when the bytes are a real PDF', async () => {
    const strapi = { documents: vi.fn(), plugin: vi.fn() } as any;
    const ctx = {
      request: {
        body: validBody,
        files: {
          resume: { name: 'resume.svg', type: 'image/svg+xml', size: 10, filepath: pdfPath },
        },
      },
      badRequest: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith('Resume must be a PDF or DOCX file.');
    expect(strapi.plugin).not.toHaveBeenCalled();
  });

  it('rejects an oversize resume with the size message', async () => {
    const strapi = { documents: vi.fn(), plugin: vi.fn() } as any;
    const ctx = {
      request: {
        body: validBody,
        files: {
          resume: {
            name: 'resume.pdf',
            type: 'application/pdf',
            size: 5 * 1024 * 1024 + 1,
            filepath: pdfPath,
          },
        },
      },
      badRequest: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith('Resume must be 5 MB or smaller.');
    expect(strapi.plugin).not.toHaveBeenCalled();
  });

  it('rejects a resume file that exposes no readable temp path', async () => {
    const strapi = { documents: vi.fn(), plugin: vi.fn() } as any;
    const ctx = {
      request: {
        body: validBody,
        files: {
          resume: { name: 'resume.pdf', type: 'application/pdf', size: 10 },
        },
      },
      badRequest: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith('Resume must be a PDF or DOCX file.');
    expect(strapi.plugin).not.toHaveBeenCalled();
  });

  it('rejects a spoofed docx whose bytes are neither zip nor docx', async () => {
    const strapi = { documents: vi.fn(), plugin: vi.fn() } as any;
    const ctx = {
      request: {
        body: validBody,
        files: {
          resume: { name: 'resume.docx', type: DOCX_MIME, size: 66, filepath: exePath },
        },
      },
      badRequest: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith('Resume must be a PDF or DOCX file.');
    expect(strapi.plugin).not.toHaveBeenCalled();
  });

  it('uploads and records a genuine PDF resume', async () => {
    const upload = vi.fn().mockResolvedValue([{ id: 42 }]);
    const findFirst = vi.fn().mockResolvedValue({ documentId: 'job-doc-id' });
    const create = vi.fn().mockResolvedValue({});
    const strapi = {
      documents: vi.fn((uid: string) =>
        uid === 'api::job.job' ? { findFirst } : { create },
      ),
      plugin: vi.fn(() => ({ service: vi.fn(() => ({ upload })) })),
    } as any;
    const ctx = {
      request: {
        body: validBody,
        files: {
          resume: {
            name: 'resume.pdf',
            type: 'application/pdf',
            size: 73,
            filepath: pdfPath,
          },
        },
      },
      badRequest: vi.fn(),
      notFound: vi.fn(),
      send: vi.fn(),
    } as any;

    await createController({ strapi }).submit(ctx);

    expect(ctx.badRequest).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].data.resume).toBe(42);
    expect(ctx.status).toBe(201);
    expect(ctx.send).toHaveBeenCalledWith({ data: { submitted: true } });
  });
});
