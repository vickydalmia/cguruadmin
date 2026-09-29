import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rehostPhoto, uploadTelegramPhoto } from './post-media';
import { callFal } from '../utils/deal-image-fal';
import { DEAL_IMAGE_PROCESSOR_VERSION } from '../utils/deal-image-background';
import { dealImageProcessingMetadata } from '../utils/deal-image-upload-metadata';
import { alphaStats } from '../utils/deal-image-transparency';

vi.mock('../utils/deal-image-fal', () => ({ callFal: vi.fn() }));

async function transparentPng() {
  const subject = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#124a89' } }).png().toBuffer();
  return sharp({ create: { width: 40, height: 30, channels: 4, background: '#00000000' } })
    .composite([{ input: subject, left: 12, top: 7 }]).png().toBuffer();
}

const source = (bytes: Buffer, contentType = 'image/jpeg') => ({ bytes, contentType, name: 'telegram-1001234-1.jpg', title: 'Product offer' });

function harness() {
  const uploaded: { filepath?: string; metadata?: ReturnType<typeof dealImageProcessingMetadata>; bytes?: Buffer } = {};
  const upload = vi.fn(async ({ files }: any) => {
    uploaded.filepath = files[0].filepath;
    uploaded.metadata = dealImageProcessingMetadata(files[0].filepath);
    uploaded.bytes = await fs.readFile(files[0].filepath);
    return [{ id: 71 }];
  });
  const strapi = {
    db: { query: vi.fn(() => ({ findOne: vi.fn(async () => ({ id: 7 })) })) },
    plugin: vi.fn(() => ({ service: vi.fn(() => ({ upload })) })),
  } as any;
  return { strapi, upload, uploaded };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('FAL_KEY', 'test-provider-key');
});
afterEach(() => vi.unstubAllEnvs());

describe('Telegram transparent photo uploads', () => {
  it('removes the background before passing a PNG and processing metadata to the shared optimizer', async () => {
    const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
    vi.mocked(callFal).mockResolvedValueOnce({ png: await transparentPng() });
    const { strapi, upload, uploaded } = harness();
    await expect(uploadTelegramPhoto(strapi, source(bytes))).resolves.toBe(71);
    expect(callFal).toHaveBeenCalledWith(bytes, 'image/jpeg', expect.any(Object));
    expect((await alphaStats(uploaded.bytes!)).meaningful).toBe(true);
    expect(uploaded.metadata).toMatchObject({ version: DEAL_IMAGE_PROCESSOR_VERSION, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({
      data: { fileInfo: { name: 'telegram-1001234-1-transparent.png', alternativeText: 'Product offer', caption: null, folder: 7 } },
      files: [expect.objectContaining({ mimetype: 'image/png', detectedMimeType: 'image/png' })],
    }));
    expect(dealImageProcessingMetadata(uploaded.filepath)).toBeUndefined();
    await expect(fs.stat(path.dirname(uploaded.filepath!))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves already-transparent images without another provider request', async () => {
    const { strapi, uploaded } = harness();
    await uploadTelegramPhoto(strapi, source(await transparentPng(), 'image/png'));
    expect(callFal).not.toHaveBeenCalled();
    expect((await alphaStats(uploaded.bytes!)).meaningful).toBe(true);
  });

  it('never uploads opaque output returned by the provider', async () => {
    const bytes = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#ffffff' } }).png().toBuffer();
    vi.mocked(callFal).mockResolvedValueOnce({ png: bytes });
    const { strapi, upload } = harness();
    await expect(uploadTelegramPhoto(strapi, source(bytes, 'image/png'))).rejects.toMatchObject({ code: 'BACKGROUND_REMOVAL_INVALID_OUTPUT' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('clears temporary files and metadata when S3 upload fails', async () => {
    const { strapi, upload } = harness();
    let filepath = '';
    upload.mockImplementationOnce(async ({ files }: any) => { filepath = files[0].filepath; throw new Error('S3 unavailable'); });
    await expect(uploadTelegramPhoto(strapi, source(await transparentPng(), 'image/png'))).rejects.toThrow('S3 unavailable');
    expect(dealImageProcessingMetadata(filepath)).toBeUndefined();
    await expect(fs.stat(path.dirname(filepath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips oversized Telegram photos before downloading or contacting the provider', async () => {
    const { strapi, upload } = harness();
    const api = { getFile: vi.fn(), downloadFile: vi.fn() } as any;
    await expect(rehostPhoto(strapi, api, { photo: [{ file_size: 6 * 1024 * 1024, width: 1000, height: 1000 }] } as any, null)).rejects.toMatchObject({ code: 'DEAL_IMAGE_INVALID_SOURCE' });
    expect(api.getFile).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(callFal).not.toHaveBeenCalled();
  });
});
