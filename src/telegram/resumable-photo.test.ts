import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFalClient } from '@fal-ai/client';
import { resumableBackgroundRemoval, PhotoPending, PhotoSubmissionUncertain } from './resumable-photo';
import { PhotoCheckComplete, photoDiagnostic } from './photo-diagnostics';
import type { PendingMessage } from './pending-store';

vi.mock('@fal-ai/client', async importOriginal => ({ ...await importOriginal<any>(), createFalClient: vi.fn() }));
beforeEach(() => { vi.stubEnv('FAL_KEY', 'fixture-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function fixture() {
  const job = { stage: 'pending', request_id: null } as PendingMessage;
  const checkpoint = vi.fn(async patch => { Object.assign(job, patch); });
  const client = {
    storage: { upload: vi.fn(async () => 'https://fal.media/source.png') },
    queue: {
      submit: vi.fn(async () => ({ request_id: 'request-1' })),
      status: vi.fn(async () => ({ status: 'COMPLETED' })),
      result: vi.fn(async () => ({ data: { image: { url: 'https://fal.media/result.png' } } })),
    },
  };
  vi.mocked(createFalClient).mockReturnValue(client as any);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('png'))));
  return { job, checkpoint, client, remove: resumableBackgroundRemoval(job, checkpoint) };
}

it('resumes a persisted provider request after a queue wait and downstream upload failure', async () => {
  const { job, checkpoint, client, remove } = fixture();
  client.queue.status.mockResolvedValueOnce({ status: 'IN_QUEUE' });
  await expect(remove(Buffer.from('source'), 'image/jpeg')).rejects.toBeInstanceOf(PhotoPending);
  expect(job.request_id).toBe('request-1');
  // Simulate another process reading the durable checkpoint after restart.
  const resumed = resumableBackgroundRemoval({ ...job }, checkpoint);
  await expect(resumed(Buffer.from('source'), 'image/jpeg')).resolves.toMatchObject({ requestId: 'request-1' });
  await expect(resumed(Buffer.from('source'), 'image/jpeg')).resolves.toBeTruthy();
  expect(client.queue.submit).toHaveBeenCalledTimes(1);
  expect(client.storage.upload).toHaveBeenCalledTimes(1);
});

it('does not repeat a paid request when submit acceptance is uncertain', async () => {
  const { job, checkpoint, client, remove } = fixture();
  client.queue.submit.mockRejectedValueOnce(new Error('connection lost'));
  await expect(remove(Buffer.from('source'), 'image/jpeg')).rejects.toBeInstanceOf(PhotoSubmissionUncertain);
  const resumed = resumableBackgroundRemoval({ ...job }, checkpoint);
  await expect(resumed(Buffer.from('source'), 'image/jpeg')).rejects.toBeInstanceOf(PhotoSubmissionUncertain);
  expect(client.queue.submit).toHaveBeenCalledTimes(1);
});

it('does not submit when the provider key is missing', async () => {
  const { client, remove } = fixture();
  vi.stubEnv('FAL_KEY', '');
  await expect(remove(Buffer.from('source'), 'image/jpeg')).rejects.toMatchObject({ code: 'BACKGROUND_REMOVAL_NOT_CONFIGURED' });
  expect(client.queue.submit).not.toHaveBeenCalled();
});

it('rejects provider output outside its media hosts', async () => {
  const { client, remove } = fixture();
  client.queue.result.mockResolvedValueOnce({ data: { image: { url: 'http://127.0.0.1/private' } } });
  await expect(remove(Buffer.from('source'), 'image/jpeg')).rejects.toMatchObject({ code: 'BACKGROUND_REMOVAL_INVALID_OUTPUT' });
  expect(fetch).not.toHaveBeenCalled();
});

it('checks source upload without submitting or checkpointing a paid request', async () => {
  const { job, checkpoint, client } = fixture();
  const onStep = vi.fn();
  const check = resumableBackgroundRemoval(job, checkpoint, onStep, true);
  await expect(check(Buffer.from('source'), 'image/jpeg')).rejects.toBeInstanceOf(PhotoCheckComplete);
  expect(client.storage.upload).toHaveBeenCalledTimes(1);
  expect(client.queue.submit).not.toHaveBeenCalled();
  expect(checkpoint).not.toHaveBeenCalled();
  expect(onStep).toHaveBeenLastCalledWith('fal-submit');
});

it('reports a still-running saved request as waiting during a diagnostic check', async () => {
  const { job, checkpoint, client } = fixture();
  Object.assign(job, { stage: 'submitted', request_id: 'saved-request' });
  client.queue.status.mockResolvedValueOnce({ status: 'IN_QUEUE' });
  const error = await resumableBackgroundRemoval(job, checkpoint, undefined, true)(Buffer.from('source'), 'image/jpeg').catch(error => error);
  expect(photoDiagnostic(error, 'fal-status')).toMatchObject({ type: 'PhotoPending', message: 'The saved background-removal request is still processing. No new request was submitted.' });
  expect(client.storage.upload).not.toHaveBeenCalled();
  expect(client.queue.submit).not.toHaveBeenCalled();
  expect(checkpoint).not.toHaveBeenCalled();
});
