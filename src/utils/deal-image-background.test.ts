import { ApiError } from '@fal-ai/client';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyFalError,
  DealImageProcessingError,
  prepareTransparentDealImage,
  validateTransparentDealPng,
} from './deal-image-background';

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'deal-image-test-'),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function opaqueJpeg() {
  return sharp({
    create: {
      width: 40,
      height: 30,
      channels: 3,
      background: { r: 240, g: 240, b: 240 },
    },
  })
    .jpeg()
    .toBuffer();
}

async function transparentPng() {
  const subject = await sharp({
    create: {
      width: 16,
      height: 16,
      channels: 4,
      background: { r: 30, g: 90, b: 180, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: 40,
      height: 30,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: subject, left: 12, top: 7 }])
    .png()
    .toBuffer();
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('prepareTransparentDealImage', () => {
  it('calls the provider with original bytes and persists its PNG before returning', async () => {
    const directory = await temporaryDirectory();
    const source = await opaqueJpeg();
    const output = await transparentPng();
    let received: Buffer | null = null;

    const prepared = await prepareTransparentDealImage({
      source,
      sourceMime: 'image/jpeg',
      fileName: 'Laptop Deal.jpg',
      outputDirectory: directory,
      permanent: true,
      removeBackground: async (bytes) => {
        received = bytes;
        return { png: output, requestId: 'fal-request-1' };
      },
    });

    expect(received).toEqual(source);
    expect(await fs.readFile(prepared.pngPath)).toEqual(output);
    expect(prepared.png).toEqual(output);
    expect(prepared.providerRequestId).toBe('fal-request-1');
    await expect(validateTransparentDealPng(prepared.png)).resolves.toEqual({
      width: 40,
      height: 30,
    });
  });

  it('normalizes an already-transparent source without calling FAL', async () => {
    const directory = await temporaryDirectory();
    const source = await transparentPng();
    let calls = 0;

    const prepared = await prepareTransparentDealImage({
      source,
      sourceMime: 'image/png',
      fileName: 'Already clean.png',
      outputDirectory: directory,
      permanent: true,
      removeBackground: async () => {
        calls += 1;
        return { png: source };
      },
    });

    expect(calls).toBe(0);
    expect(prepared.skippedProvider).toBe(true);
    expect(prepared.reusedArchive).toBe(false);
  });

  it('reuses a valid source-hash archive without a second provider call', async () => {
    const directory = await temporaryDirectory();
    const source = await opaqueJpeg();
    const output = await transparentPng();
    let calls = 0;
    const options = {
      source,
      sourceMime: 'image/jpeg',
      fileName: 'Shared Product.jpg',
      outputDirectory: directory,
      permanent: true,
      removeBackground: async () => {
        calls += 1;
        return { png: output };
      },
    };

    await prepareTransparentDealImage(options);
    const reused = await prepareTransparentDealImage(options);

    expect(calls).toBe(1);
    expect(reused.reusedArchive).toBe(true);
    expect(reused.png).toEqual(output);
  });

  it('rejects an opaque provider result and does not create an archive', async () => {
    const directory = await temporaryDirectory();
    const source = await opaqueJpeg();

    await expect(
      prepareTransparentDealImage({
        source,
        sourceMime: 'image/jpeg',
        fileName: 'Broken.jpg',
        outputDirectory: directory,
        permanent: true,
        removeBackground: async () => ({
          png: await sharp(source).png().toBuffer(),
        }),
      }),
    ).rejects.toMatchObject({
      code: 'BACKGROUND_REMOVAL_INVALID_OUTPUT',
    });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('fails before provider/upload work when the archive is not writable', async () => {
    const directory = await temporaryDirectory();
    const notDirectory = path.join(directory, 'blocked');
    await fs.writeFile(notDirectory, 'file');
    let providerCalls = 0;

    await expect(
      prepareTransparentDealImage({
        source: await opaqueJpeg(),
        sourceMime: 'image/jpeg',
        fileName: 'Blocked.jpg',
        outputDirectory: notDirectory,
        permanent: true,
        removeBackground: async () => {
          providerCalls += 1;
          return { png: await transparentPng() };
        },
      }),
    ).rejects.toMatchObject({
      code: 'DEAL_IMAGE_ARCHIVE_WRITE_FAILED',
    });
    expect(providerCalls).toBe(0);
  });
});

describe('classifyFalError', () => {
  it('maps exhausted credits to a non-retryable uploader error', () => {
    const error = classifyFalError(
      new ApiError({
        message: 'Insufficient balance',
        status: 402,
        requestId: 'fal-credit-request',
      }),
    );
    expect(error).toMatchObject({
      code: 'BACKGROUND_REMOVAL_CREDITS_EXHAUSTED',
      retryable: false,
      providerRequestId: 'fal-credit-request',
    });
  });

  it('maps rate limits to a retryable uploader error', () => {
    const error = classifyFalError(
      new ApiError({ message: 'rate limited', status: 429 }),
    );
    expect(error).toMatchObject({
      code: 'BACKGROUND_REMOVAL_RATE_LIMITED',
      retryable: true,
    });
  });

  it('never exposes a provider response in the public payload', () => {
    const error = new DealImageProcessingError(
      'BACKGROUND_REMOVAL_UNAVAILABLE',
      { cause: new Error('secret provider body') },
    );
    expect(JSON.stringify(error.toResponse())).not.toContain(
      'secret provider body',
    );
  });
});
