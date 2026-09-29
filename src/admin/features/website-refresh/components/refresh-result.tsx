import * as React from 'react';
import { Box, Button, Flex, Typography } from '@strapi/design-system';
import type { RefreshStatus } from '../api/website-refresh-api';

function date(value?: string | null) {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' }) : 'Unavailable';
}
function age(generatedAt: string, checkedAt?: string) {
  const seconds = Math.max(0, Math.floor(((checkedAt ? Date.parse(checkedAt) : Date.now()) - Date.parse(generatedAt)) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
export function RefreshResult({ status }: { status: RefreshStatus }) {
  const [copyMessage, setCopyMessage] = React.useState('');
  async function copy() {
    try { await navigator.clipboard.writeText(JSON.stringify(status, null, 2)); setCopyMessage('Copied'); }
    catch { setCopyMessage('Copy unavailable. Select the diagnostic response below.'); }
  }
  return <Box background="neutral100" padding={3}>
    <Flex direction="column" alignItems="stretch" gap={3}>
      <Typography role="status" aria-live="polite" fontWeight="bold">Request #{status.id}: {status.message}</Typography>
      {status.requestedAt && <Typography variant="pi">Requested: {date(status.requestedAt)}</Typography>}
      {status.acceptedAt && <Typography variant="pi">Accepted by website: {date(status.acceptedAt)}</Typography>}
      {status.checkedAt && <Typography variant="pi">Last checked: {date(status.checkedAt)}</Typography>}
      {status.deliveryError && <Typography textColor="danger600">Delivery error: {status.deliveryError}</Typography>}
      {status.nextRetryAt && <Typography variant="pi">Next delivery attempt: {date(status.nextRetryAt)} (attempts so far: {status.attempts})</Typography>}
      {status.statusError && <Typography textColor="warning600">Status check error: {status.statusError}</Typography>}
      {status.pages?.map((page) => <Box key={page.path} background="neutral0" padding={3}>
        <Flex direction="column" alignItems="stretch" gap={2}>
          <Typography fontWeight="bold">{page.path} — {page.state === 'rendered' ? 'Generated' : page.state === 'failed' ? 'Failed' : 'Waiting for regeneration'}</Typography>
          <Typography variant="pi">Cached page generated: {date(page.generatedAt)}</Typography>
          {page.generatedAt && <Typography variant="pi">Cache age at last check: {age(page.generatedAt, status.checkedAt)}</Typography>}
          {page.state !== 'rendered' && page.generatedAt && <Typography variant="pi">This timestamp belongs to the previous cached page, not the requested regeneration.</Typography>}
          {page.cachedHttpStatus !== null && <Typography variant="pi">Cached response: HTTP {page.cachedHttpStatus}</Typography>}
          {page.attemptsMade !== null && <Typography variant="pi">Render attempts: {page.attemptsMade} / {page.maxAttempts}</Typography>}
          {page.lastAttemptAt && <Typography variant="pi">Last render attempt: {date(page.lastAttemptAt)}</Typography>}
          {page.error && <Typography textColor="danger600">Render error: {page.error}</Typography>}
          {page.state === 'failed' && !page.error && <Typography variant="pi">Detailed failure is no longer retained in the queue. Use the request and version identifiers below to find server logs.</Typography>}
        </Flex>
      </Box>)}
      {Boolean(status.removedPaths?.length) && <Typography variant="pi">Unavailable pages: {status.removedPaths!.join(', ')}</Typography>}
      <details>
        <summary>Diagnostic response</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: '12px' }}>{JSON.stringify(status, null, 2)}</pre>
        <Button type="button" variant="tertiary" onClick={() => void copy()}>Copy diagnostics</Button>
        {copyMessage && <Typography role="status" variant="pi">{copyMessage}</Typography>}
      </details>
    </Flex>
  </Box>;
}
