import { Flex, Typography } from '@strapi/design-system';
import type { ProcessingJob } from './use-telegram-processing';

const STEP_LABELS: Record<string, string> = {
  'post-lookup': 'Stored post lookup', 'upload-lookup': 'Saved image lookup',
  'telegram-file': 'Telegram photo lookup', 'telegram-download': 'Telegram photo download',
  'image-prepare': 'Image preparation', 'fal-upload': 'Background-removal source upload',
  'fal-submit': 'Background-removal submission', 'fal-status': 'Background-removal status',
  'fal-result': 'Background-removal result', 'fal-download': 'Processed image download',
  'image-upload': 'Media Library / storage upload', 'post-publish': 'Post publication',
  'photo-cleanup': 'Old image cleanup',
};

export function ProcessingDetails({ job }: { job: ProcessingJob }) {
  const details = job.errorDetails;
  if (!job.error && !details && !job.checking) return null;
  return <Flex direction="column" alignItems="flex-start" gap={1}>
    {job.error && <Typography variant="pi">{job.error}</Typography>}
    {job.checking && <Typography variant="pi">Image check queued. Refresh in a minute to see the result.</Typography>}
    {details && <>
      <Typography variant="pi">{details.type === 'PhotoCheckComplete' ? 'Check stopped at' : details.type === 'PhotoPending' ? 'Waiting at' : 'Failed at'}: {STEP_LABELS[details.step] ?? details.step}</Typography>
      <Typography variant="pi">{details.message}</Typography>
      <Typography variant="pi">{details.type}{details.status ? ` · HTTP ${details.status}` : ''}{details.code ? ` · ${details.code}` : ''} · {new Date(details.occurredAt).toLocaleString()}</Typography>
      {details.contentType && <Typography variant="pi">Content-Type: {details.contentType}{details.detectedType ? ` · Detected: ${details.detectedType}` : ''}</Typography>}
    </>}
    <Typography variant="pi">Failed attempts: {job.attempts} / 5. {job.stage === 'blocked' ? 'Automatic retries are paused.' : job.nextAttemptAt ? `Next retry: ${new Date(job.nextAttemptAt).toLocaleString()}.` : ''}</Typography>
  </Flex>;
}
