// Deal-image FAL PROVIDER: the background-removal call, its error
// classification, retry/timeout handling, and the process-wide concurrency
// slots (activeFalRequests/falWaiters live HERE and only here). One of the
// modules split out of deal-image-background.ts.
import { ApiError, createFalClient } from '@fal-ai/client';
import {
  DealImageProcessingError,
  type DealImageErrorCode,
} from './deal-image-errors';

interface FalOutput {
  image?: {
    url?: string;
    content_type?: string;
    width?: number;
    height?: number;
  };
}

export const DEAL_IMAGE_FAL_ENDPOINT = 'fal-ai/bria/background/remove';

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

export async function callFal(
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
