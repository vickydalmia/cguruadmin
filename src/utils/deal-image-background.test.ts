import { ApiError } from '@fal-ai/client';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareTransparentDealImage } from './deal-image-background';
import { DealImageProcessingError } from './deal-image-errors';
import { classifyFalError } from './deal-image-fal';
import { validateTransparentDealPng } from './deal-image-transparency';

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

  it('reuses a legacy source-hash archive after the source filename changes', async () => {
    const directory = await temporaryDirectory();
    const source = await opaqueJpeg();
    const output = await transparentPng();
    let calls = 0;
    const first = await prepareTransparentDealImage({
      source,
      sourceMime: 'image/jpeg',
      fileName: 'Original Product Name.jpg',
      outputDirectory: directory,
      permanent: true,
      removeBackground: async () => {
        calls += 1;
        return { png: output };
      },
    });
    const sourceHash = path.basename(first.pngPath, '.png');
    const legacyPath = path.join(
      directory,
      `${sourceHash}-original-product-name.png`,
    );
    await fs.rename(first.pngPath, legacyPath);

    const reused = await prepareTransparentDealImage({
      source,
      sourceMime: 'image/jpeg',
      fileName: 'Renamed Product.jpg',
      outputDirectory: directory,
      permanent: true,
      removeBackground: async () => {
        calls += 1;
        return { png: output };
      },
    });

    expect(calls).toBe(1);
    expect(reused.reusedArchive).toBe(true);
    expect(reused.pngPath).toBe(legacyPath);
    expect(reused.png).toEqual(output);
  });

  it('allows migration to alias one legacy filename match under a new source hash', async () => {
    const directory = await temporaryDirectory();
    const oldSource = await opaqueJpeg();
    const newSource = await sharp(oldSource).png().toBuffer();
    const output = await transparentPng();
    const old = await prepareTransparentDealImage({
      source: oldSource,
      sourceMime: 'image/jpeg',
      fileName: 'Stable Product.jpg',
      outputDirectory: directory,
      permanent: true,
      removeBackground: async () => ({ png: output }),
    });
    const legacyPath = path.join(
      directory,
      `${path.basename(old.pngPath, '.png')}-stable-product.png`,
    );
    await fs.rename(old.pngPath, legacyPath);
    let providerCalls = 0;

    const reused = await prepareTransparentDealImage({
      source: newSource,
      sourceMime: 'image/png',
      fileName: 'Stable Product.jpg',
      outputDirectory: directory,
      permanent: true,
      allowLegacyFileNameArchive: true,
      removeBackground: async () => {
        providerCalls += 1;
        return { png: output };
      },
    });

    expect(providerCalls).toBe(0);
    expect(reused.reusedArchive).toBe(true);
    expect(reused.pngPath).not.toBe(legacyPath);
    expect(await fs.readFile(reused.pngPath)).toEqual(output);
  });

  it('does not use an ambiguous legacy filename match', async () => {
    const directory = await temporaryDirectory();
    const source = await opaqueJpeg();
    const output = await transparentPng();
    await Promise.all([
      fs.writeFile(path.join(directory, `old-a-same-name.png`), output),
      fs.writeFile(path.join(directory, `old-b-same-name.png`), output),
    ]);
    let providerCalls = 0;

    await prepareTransparentDealImage({
      source,
      sourceMime: 'image/jpeg',
      fileName: 'Same Name.jpg',
      outputDirectory: directory,
      permanent: true,
      allowLegacyFileNameArchive: true,
      removeBackground: async () => {
        providerCalls += 1;
        return { png: output };
      },
    });

    expect(providerCalls).toBe(1);
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

  it('reads exhausted-credit details from a forbidden provider body', () => {
    const error = classifyFalError(
      new ApiError({
        message: 'Forbidden',
        status: 403,
        body: { detail: 'Spending limit exhausted' },
        requestId: 'fal-spend-limit-request',
      }),
    );
    expect(error).toMatchObject({
      code: 'BACKGROUND_REMOVAL_CREDITS_EXHAUSTED',
      retryable: false,
      providerRequestId: 'fal-spend-limit-request',
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
