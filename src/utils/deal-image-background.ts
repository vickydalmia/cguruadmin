import { ApiError, createFalClient } from '@fal-ai/client';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export const DEAL_IMAGE_PROCESSOR_VERSION = 'fal-bria-rmbg-2.0-v1';
export const DEAL_IMAGE_FAL_ENDPOINT = 'fal-ai/bria/background/remove';

export type DealImageErrorCode =
  | 'BACKGROUND_REMOVAL_CREDITS_EXHAUSTED'
  | 'BACKGROUND_REMOVAL_NOT_CONFIGURED'
  | 'BACKGROUND_REMOVAL_RATE_LIMITED'
  | 'BACKGROUND_REMOVAL_TIMED_OUT'
  | 'BACKGROUND_REMOVAL_REJECTED'
  | 'BACKGROUND_REMOVAL_UNAVAILABLE'
  | 'BACKGROUND_REMOVAL_INVALID_OUTPUT'
  | 'DEAL_IMAGE_INVALID_SOURCE'
  | 'DEAL_IMAGE_ARCHIVE_WRITE_FAILED'
  | 'DEAL_IMAGE_OPTIMIZATION_FAILED'
  | 'DEAL_IMAGE_STORAGE_FAILED';

const PUBLIC_ERROR: Record<
  DealImageErrorCode,
  { message: string; retryable: boolean; status: number }
> = {
  BACKGROUND_REMOVAL_CREDITS_EXHAUSTED: {
    message:
      'Background-removal credits are unavailable. The image was not saved. Please add credits or contact an administrator.',
    retryable: false,
    status: 402,
  },
  BACKGROUND_REMOVAL_NOT_CONFIGURED: {
    message:
      'The background-removal service is not configured correctly. The image was not saved.',
    retryable: false,
    status: 503,
  },
  BACKGROUND_REMOVAL_RATE_LIMITED: {
    message:
      'The background-removal service is busy. The image was not saved. Please retry shortly.',
    retryable: true,
    status: 429,
  },
  BACKGROUND_REMOVAL_TIMED_OUT: {
    message:
      'The background-removal service timed out. The image was not saved. Please retry.',
    retryable: true,
    status: 504,
  },
  BACKGROUND_REMOVAL_REJECTED: {
    message:
      'The background-removal service could not process this image. The image was not saved. Please try a PNG, JPG or WebP image.',
    retryable: false,
    status: 422,
  },
  BACKGROUND_REMOVAL_UNAVAILABLE: {
    message:
      'The background-removal service could not process this image. The image was not saved. Please retry.',
    retryable: true,
    status: 503,
  },
  BACKGROUND_REMOVAL_INVALID_OUTPUT: {
    message:
      'Background removal returned an invalid image. The image was not saved.',
    retryable: true,
    status: 502,
  },
  DEAL_IMAGE_INVALID_SOURCE: {
    message:
      'This Deal image is invalid or unsupported. The image was not saved.',
    retryable: false,
    status: 422,
  },
  DEAL_IMAGE_ARCHIVE_WRITE_FAILED: {
    message:
      'The transparent image could not be saved locally. The image was not uploaded to AWS.',
    retryable: true,
    status: 507,
  },
  DEAL_IMAGE_OPTIMIZATION_FAILED: {
    message:
      'The transparent image could not be optimized. The image was not saved.',
    retryable: true,
    status: 500,
  },
  DEAL_IMAGE_STORAGE_FAILED: {
    message:
      'The transparent image could not be saved to AWS. Please retry.',
    retryable: true,
    status: 503,
  },
};

export class DealImageProcessingError extends Error {
  readonly code: DealImageErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly referenceId: string;
  readonly providerRequestId?: string;
  readonly cause?: unknown;

  constructor(
    code: DealImageErrorCode,
    options: {
      cause?: unknown;
      providerRequestId?: string;
      referenceId?: string;
    } = {},
  ) {
    super(PUBLIC_ERROR[code].message);
    this.name = 'DealImageProcessingError';
    this.code = code;
    this.retryable = PUBLIC_ERROR[code].retryable;
    this.status = PUBLIC_ERROR[code].status;
    this.referenceId =
      options.referenceId ?? crypto.randomBytes(8).toString('hex');
    this.providerRequestId = options.providerRequestId;
    this.cause = options.cause;
  }

  toResponse() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      referenceId: this.referenceId,
    };
  }
}

export interface PreparedTransparentDealImage {
  png: Buffer;
  pngPath: string;
  sourceHash: string;
  width: number;
  height: number;
  providerRequestId?: string;
  reusedArchive: boolean;
  skippedProvider: boolean;
}

interface FalOutput {
  image?: {
    url?: string;
    content_type?: string;
    width?: number;
    height?: number;
  };
}

export interface PrepareTransparentDealImageOptions {
  source: Buffer;
  sourceMime: string;
  fileName: string;
  outputDirectory: string;
  permanent: boolean;
  /**
   * Migration-only bridge for archives created from a differently encoded
   * copy of the same WordPress attachment. Normal uploads must remain
   * content-hash-only so replacing bytes under the same name cannot reuse a
   * stale transparent image.
   */
  allowLegacyFileNameArchive?: boolean;
  falKey?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  removeBackground?: (
    source: Buffer,
    sourceMime: string,
  ) => Promise<{ png: Buffer; requestId?: string }>;
}

const sha256 = (value: Buffer): string =>
  crypto.createHash('sha256').update(value).digest('hex');

const safeFileStem = (fileName: string): string => {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  return (
    stem
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'deal-image'
  );
};

async function alphaStats(
  input: Buffer,
): Promise<{ meaningful: boolean; width: number; height: number }> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { animated: false }).metadata();
  } catch (cause) {
    throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE', { cause });
  }

  if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) {
    throw new DealImageProcessingError('DEAL_IMAGE_INVALID_SOURCE');
  }

  const { data, info } = await sharp(input, { animated: false })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const total = info.width * info.height;
  let transparent = 0;
  for (let offset = 3; offset < data.length; offset += info.channels) {
    if (data[offset] < 250) transparent += 1;
  }
  const minimum = Math.max(16, Math.ceil(total * 0.001));
  return {
    meaningful: Boolean(metadata.hasAlpha && transparent >= minimum),
    width: info.width,
    height: info.height,
  };
}

export async function validateTransparentDealPng(
  input: Buffer,
): Promise<{ width: number; height: number }> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(input, { animated: false }).metadata();
  } catch (cause) {
    throw new DealImageProcessingError(
      'BACKGROUND_REMOVAL_INVALID_OUTPUT',
      { cause },
    );
  }
  if (metadata.format !== 'png') {
    throw new DealImageProcessingError('BACKGROUND_REMOVAL_INVALID_OUTPUT');
  }
  const stats = await alphaStats(input).catch((cause) => {
    if (
      cause instanceof DealImageProcessingError &&
      cause.code === 'DEAL_IMAGE_INVALID_SOURCE'
    ) {
      throw new DealImageProcessingError(
        'BACKGROUND_REMOVAL_INVALID_OUTPUT',
        { cause },
      );
    }
    throw cause;
  });
  if (!stats.meaningful) {
    throw new DealImageProcessingError('BACKGROUND_REMOVAL_INVALID_OUTPUT');
  }
  return { width: stats.width, height: stats.height };
}

function dataUriToBuffer(value: string): Buffer | null {
  const match = /^data:image\/png;base64,([a-z0-9+/=\s]+)$/i.exec(value);
  return match ? Buffer.from(match[1].replace(/\s/g, ''), 'base64') : null;
}

function providerRequestId(error: unknown): string | undefined {
  return error instanceof ApiError && error.requestId
    ? error.requestId
    : undefined;
}

function providerMessage(error: unknown): string {
  if (error instanceof ApiError) {
    let body = '';
    try {
      body = JSON.stringify(error.body);
    } catch {
      // The provider body is diagnostic input only; classification can still
      // fall back to the public error message when it is not serializable.
    }
    return `${error.message} ${body}`.toLowerCase();
  }
  if (error instanceof Error) return error.message.toLowerCase();
  return String(error).toLowerCase();
}

export function classifyFalError(error: unknown): DealImageProcessingError {
  if (error instanceof DealImageProcessingError) return error;
  const status = error instanceof ApiError ? error.status : undefined;
  const message = providerMessage(error);
  const options = {
    cause: error,
    providerRequestId: providerRequestId(error),
  };

  if (
    status === 402 ||
    /insufficient|credit|balance|quota|billing|payment|spend(?:ing)?|exhausted|funds/.test(
      message,
    )
  ) {
    return new DealImageProcessingError(
      'BACKGROUND_REMOVAL_CREDITS_EXHAUSTED',
      options,
    );
  }
  if (status === 401 || status === 403) {
    return new DealImageProcessingError(
      'BACKGROUND_REMOVAL_NOT_CONFIGURED',
      options,
    );
  }
  if (status === 429) {
    return new DealImageProcessingError(
      'BACKGROUND_REMOVAL_RATE_LIMITED',
      options,
    );
  }
  if (
    (error instanceof Error && error.name === 'AbortError') ||
    /abort|timed?\s*out|timeout/.test(message)
  ) {
    return new DealImageProcessingError(
      'BACKGROUND_REMOVAL_TIMED_OUT',
      options,
    );
  }
  if (status === 400 || status === 404 || status === 422) {
    return new DealImageProcessingError(
      'BACKGROUND_REMOVAL_REJECTED',
      options,
    );
  }
  return new DealImageProcessingError(
    'BACKGROUND_REMOVAL_UNAVAILABLE',
    options,
  );
}

const falConcurrency = Math.max(
  1,
  Number.parseInt(process.env.FAL_BACKGROUND_REMOVAL_CONCURRENCY ?? '2', 10) ||
    2,
);
let activeFalRequests = 0;
const falWaiters: Array<() => void> = [];

async function withFalSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeFalRequests >= falConcurrency) {
    await new Promise<void>((resolve) => falWaiters.push(resolve));
  }
  activeFalRequests += 1;
  try {
    return await operation();
  } finally {
    activeFalRequests -= 1;
    falWaiters.shift()?.();
  }
}

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function downloadFalPng(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  const embedded = dataUriToBuffer(url);
  if (embedded) return embedded;
  const response = await fetchImpl(url, { signal });
  if (!response.ok) {
    throw new ApiError({
      message: `FAL output download returned ${response.status}`,
      status: response.status,
    });
  }
  return Buffer.from(await response.arrayBuffer());
}

async function callFal(
  source: Buffer,
  sourceMime: string,
  options: {
    falKey: string;
    timeoutMs: number;
    maxAttempts: number;
    fetchImpl: typeof fetch;
  },
): Promise<{ png: Buffer; requestId?: string }> {
  const client = createFalClient({
    credentials: options.falKey,
    retry: { maxRetries: 0 },
  });
  let lastError: DealImageProcessingError | null = null;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await withFalSlot(async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
        try {
          // Copy into an ArrayBuffer-backed view: Node 24's Buffer type may
          // expose SharedArrayBuffer, which is not a valid DOM BlobPart.
          const uploadBytes = new Uint8Array(source.length);
          uploadBytes.set(source);
          const sourceUrl = await client.storage.upload(
            new Blob([uploadBytes], { type: sourceMime }),
            { lifecycle: { expiresIn: '1h' } },
          );
          const result = await client.subscribe(
            DEAL_IMAGE_FAL_ENDPOINT as any,
            {
              input: { image_url: sourceUrl, sync_mode: true },
              abortSignal: controller.signal,
              timeout: options.timeoutMs,
              storageSettings: { expiresIn: 'immediate' },
            },
          );
          const output = result.data as FalOutput;
          const outputUrl = output.image?.url;
          if (!outputUrl) {
            throw new DealImageProcessingError(
              'BACKGROUND_REMOVAL_INVALID_OUTPUT',
              { providerRequestId: result.requestId },
            );
          }
          const png = await downloadFalPng(
            outputUrl,
            options.fetchImpl,
            controller.signal,
          );
          return { png, requestId: result.requestId };
        } finally {
          clearTimeout(timeout);
        }
      });
    } catch (error) {
      lastError = classifyFalError(error);
      if (!lastError.retryable || attempt === options.maxAttempts) {
        throw lastError;
      }
      await wait(Math.min(2_000, 250 * 2 ** (attempt - 1)));
    }
  }
  throw lastError ?? new DealImageProcessingError('BACKGROUND_REMOVAL_UNAVAILABLE');
}

async function atomicWrite(filePath: string, bytes: Buffer): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto
    .randomBytes(6)
    .toString('hex')}`;
  try {
    await fs.writeFile(temporaryPath, bytes, { flag: 'wx' });
    await fs.rename(temporaryPath, filePath);
  } catch (cause) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new DealImageProcessingError('DEAL_IMAGE_ARCHIVE_WRITE_FAILED', {
      cause,
    });
  }
}

async function readValidPermanentArchive(
  outputDirectory: string,
  sourceHash: string,
  fileName: string,
  allowLegacyFileNameArchive: boolean,
): Promise<{
  png: Buffer;
  pngPath: string;
  width: number;
  height: number;
  matchedSourceHash: boolean;
} | null> {
  let names: string[];
  try {
    names = await fs.readdir(outputDirectory);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw new DealImageProcessingError('DEAL_IMAGE_ARCHIVE_WRITE_FAILED', {
      cause: error,
    });
  }

  const canonicalName = `${sourceHash}.png`;
  const hashCandidates = [
    canonicalName,
    ...names
      .filter(
        (name) =>
          name.startsWith(`${sourceHash}-`) &&
          name.toLowerCase().endsWith('.png'),
      )
      .sort(),
  ];
  const legacySuffix = `-${safeFileStem(fileName)}.png`;
  const legacyNameCandidates = allowLegacyFileNameArchive
    ? names.filter((name) => name.endsWith(legacySuffix)).sort()
    : [];
  const candidates = [
    ...[...new Set(hashCandidates)].map((name) => ({
      name,
      matchedSourceHash: true,
    })),
    ...(legacyNameCandidates.length === 1
      ? [{ name: legacyNameCandidates[0]!, matchedSourceHash: false }]
      : []),
  ];
  for (const { name, matchedSourceHash } of candidates) {
    const candidatePath = path.join(outputDirectory, name);
    try {
      const png = await fs.readFile(candidatePath);
      const dimensions = await validateTransparentDealPng(png);
      return {
        png,
        pngPath: candidatePath,
        ...dimensions,
        matchedSourceHash,
      };
    } catch (error: any) {
      if (error?.code === 'ENOENT') continue;
      await fs.rm(candidatePath, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

export async function prepareTransparentDealImage(
  options: PrepareTransparentDealImageOptions,
): Promise<PreparedTransparentDealImage> {
  const sourceHash = sha256(options.source);
  const suffix = options.permanent
    ? ''
    : `-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const pngPath = path.join(options.outputDirectory, options.permanent
    ? `${sourceHash}.png`
    : `${sourceHash}-${safeFileStem(options.fileName)}${suffix}.png`);

  try {
    await fs.mkdir(options.outputDirectory, { recursive: true });
  } catch (cause) {
    throw new DealImageProcessingError('DEAL_IMAGE_ARCHIVE_WRITE_FAILED', {
      cause,
    });
  }

  if (options.permanent) {
    const archived = await readValidPermanentArchive(
      options.outputDirectory,
      sourceHash,
      options.fileName,
      options.allowLegacyFileNameArchive ?? false,
    );
    if (archived) {
      let archivedPath = archived.pngPath;
      if (!archived.matchedSourceHash) {
        await atomicWrite(pngPath, archived.png);
        archivedPath = pngPath;
      }
      return {
        png: archived.png,
        pngPath: archivedPath,
        sourceHash,
        width: archived.width,
        height: archived.height,
        reusedArchive: true,
        skippedProvider: true,
      };
    }
  }

  const sourceStats = await alphaStats(options.source);
  let png: Buffer;
  let requestId: string | undefined;
  let skippedProvider = false;

  if (sourceStats.meaningful) {
    png = await sharp(options.source, { animated: false })
      .rotate()
      .png()
      .toBuffer();
    skippedProvider = true;
  } else if (options.removeBackground) {
    const result = await options.removeBackground(
      options.source,
      options.sourceMime,
    );
    png = result.png;
    requestId = result.requestId;
  } else {
    const falKey = options.falKey ?? process.env.FAL_KEY;
    if (!falKey) {
      throw new DealImageProcessingError(
        'BACKGROUND_REMOVAL_NOT_CONFIGURED',
      );
    }
    const result = await callFal(options.source, options.sourceMime, {
      falKey,
      timeoutMs: options.timeoutMs ?? 120_000,
      maxAttempts: options.maxAttempts ?? 3,
      fetchImpl: options.fetchImpl ?? fetch,
    });
    png = result.png;
    requestId = result.requestId;
  }

  const dimensions = await validateTransparentDealPng(png);
  await atomicWrite(pngPath, png);
  let persisted: Buffer;
  try {
    persisted = await fs.readFile(pngPath);
  } catch (cause) {
    throw new DealImageProcessingError('DEAL_IMAGE_ARCHIVE_WRITE_FAILED', {
      cause,
      providerRequestId: requestId,
    });
  }
  await validateTransparentDealPng(persisted);

  return {
    png: persisted,
    pngPath,
    sourceHash,
    ...dimensions,
    providerRequestId: requestId,
    reusedArchive: false,
    skippedProvider,
  };
}
