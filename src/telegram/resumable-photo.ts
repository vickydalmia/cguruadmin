import { createFalClient, ApiError } from '@fal-ai/client';
import { DEAL_IMAGE_FAL_ENDPOINT, classifyFalError } from '../utils/deal-image-fal';
import { DealImageProcessingError } from '../utils/deal-image-errors';
import type { PendingMessage } from './pending-store';
import { PhotoCheckComplete, type PhotoStep } from './photo-diagnostics';

export class PhotoPending extends Error {
  constructor() { super('Saved image processing is still in progress'); this.name = 'PhotoPending'; }
}
export class PhotoSubmissionUncertain extends Error {
  constructor() { super('Image submission acceptance is uncertain'); this.name = 'PhotoSubmissionUncertain'; }
}

const boundedFetch: typeof fetch = (input, init) => fetch(input, {
  ...init, signal: init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
    : AbortSignal.timeout(30_000),
});

/** No subscribe/re-submit loop: each source revision has one durable request. */
export function resumableBackgroundRemoval(
  job: PendingMessage, checkpoint: (patch: Partial<PendingMessage>) => Promise<void>,
  onStep?: (step: PhotoStep) => void, inspectOnly = false,
) {
  return async (source: Buffer, mime: string): Promise<{ png: Buffer; requestId?: string }> => {
    if (job.stage === 'submitting' && !job.request_id) { onStep?.('fal-submit'); throw new PhotoSubmissionUncertain(); }
    if (!process.env.FAL_KEY) throw new DealImageProcessingError('BACKGROUND_REMOVAL_NOT_CONFIGURED');
    const client = createFalClient({ credentials: process.env.FAL_KEY, retry: { maxRetries: 0 }, fetch: boundedFetch });
    if (!job.request_id) {
      onStep?.('fal-upload');
      const sourceUrl = await client.storage.upload(new Blob([new Uint8Array(source)], { type: mime }), { lifecycle: { expiresIn: '1d' } });
      // The explicit admin check may verify source upload, but never submit a
      // billable background-removal job or change its durable checkpoint.
      if (inspectOnly) { onStep?.('fal-submit'); throw new PhotoCheckComplete(); }
      await checkpoint({ stage: 'submitting', submitted_at: new Date() });
      try {
        onStep?.('fal-submit');
        const submitted = await client.queue.submit(DEAL_IMAGE_FAL_ENDPOINT as any, {
          input: { image_url: sourceUrl, sync_mode: false }, storageSettings: { expiresIn: '1d' },
          headers: { 'X-Fal-No-Retry': '1' }, startTimeout: 120,
        });
        await checkpoint({ request_id: submitted.request_id, stage: 'submitted' });
      } catch (error) {
        // Explicit rejection proves no accepted request. A transport failure
        // cannot prove that, so a paid submission must not be repeated.
        if (error instanceof ApiError && [400, 401, 402, 403, 404, 422, 429].includes(error.status)) {
          await checkpoint({ stage: 'pending', submitted_at: null });
          throw classifyFalError(error);
        }
        throw new PhotoSubmissionUncertain();
      }
    }
    const requestId = job.request_id!;
    onStep?.('fal-status');
    const status = await client.queue.status(DEAL_IMAGE_FAL_ENDPOINT, { requestId, logs: false });
    if (status.status !== 'COMPLETED') {
      if (job.submitted_at && Date.now() - new Date(job.submitted_at).getTime() > 24 * 60 * 60_000) {
        throw new DealImageProcessingError('BACKGROUND_REMOVAL_REJECTED');
      }
      throw new PhotoPending();
    }
    onStep?.('fal-result');
    const result = await client.queue.result(DEAL_IMAGE_FAL_ENDPOINT, { requestId });
    const url = (result.data as any)?.image?.url;
    const parsed = typeof url === 'string' ? new URL(url) : null;
    if (!parsed || parsed.protocol !== 'https:' || !(parsed.hostname === 'fal.media' || parsed.hostname.endsWith('.fal.media'))) {
      throw new DealImageProcessingError('BACKGROUND_REMOVAL_INVALID_OUTPUT');
    }
    onStep?.('fal-download');
    const response = await boundedFetch(url, { redirect: 'error' });
    if (!response.ok || !response.body) throw new DealImageProcessingError('BACKGROUND_REMOVAL_UNAVAILABLE');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 20 * 1024 * 1024) throw new DealImageProcessingError('BACKGROUND_REMOVAL_INVALID_OUTPUT');
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return { png: Buffer.concat(chunks), requestId };
  };
}
