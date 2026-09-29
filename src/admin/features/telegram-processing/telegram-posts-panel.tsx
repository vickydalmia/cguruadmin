import { useState } from 'react';
import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { useAuth } from '@strapi/strapi/admin';
import { Button, Flex, Modal, Typography } from '@strapi/design-system';
import { isSuperAdminUser } from '../../utils/super-admin';
import { useTelegramProcessing } from './use-telegram-processing';
import { ProcessingDetails } from './processing-details';

function safeImage(value: string | undefined): string | undefined {
  if (value?.startsWith('/') && !value.startsWith('//')) return value;
  try { const url = new URL(value ?? ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function telegramLink(value: string | undefined): string | undefined {
  try { const url = new URL(value ?? ''); return url.protocol === 'https:' && url.hostname === 't.me' ? url.href : undefined; } catch { return undefined; }
}

function StoredPostList({ close }: { close: () => void }) {
  const [view, setView] = useState<'posts' | 'pending'>('posts');
  const state = useTelegramProcessing(view);
  return <Modal.Root open onOpenChange={open => { if (!open) close(); }}><Modal.Content>
    <Modal.Header><Modal.Title>Telegram posts · read only</Modal.Title></Modal.Header>
    <Modal.Body><Flex direction="column" alignItems="stretch" gap={4}>
      <Flex gap={2}>
        <Button variant={view === 'posts' ? 'default' : 'secondary'} onClick={() => { state.setPage(1); setView('posts'); }}>Stored posts</Button>
        <Button variant={view === 'pending' ? 'default' : 'secondary'} onClick={() => { state.setPage(1); setView('pending'); }}>Awaiting images</Button>
        <Button disabled={state.busy} variant="tertiary" onClick={() => void state.refresh()}>Refresh</Button>
      </Flex>
      <Typography variant="pi">{state.total} {view === 'posts' ? 'stored posts' : 'posts awaiting images'}. This list is read only.</Typography>
      {state.error && <Typography role="alert" textColor="danger600">{state.error}</Typography>}
      {!state.busy && state.jobs.length === 0 && <Typography>No posts yet.</Typography>}
      {state.jobs.map(job => <Flex key={job.id} gap={4} alignItems="flex-start">
        {safeImage(job.photo?.url) && <img src={safeImage(job.photo?.url)} alt={job.photo?.alt ?? ''} width={80} height={80} loading="lazy" style={{ objectFit: 'contain', flexShrink: 0 }} />}
        <Flex direction="column" alignItems="flex-start" gap={1}>
          <Typography fontWeight="bold">{job.title || `Post ${job.messageId}`}</Typography>
          <Typography variant="pi">Post {job.messageId} · {job.stage}{job.postedAt ? ` · ${new Date(job.postedAt).toLocaleString()}` : ''}</Typography>
          <ProcessingDetails job={job} />
          {telegramLink(job.permalink) && <a href={telegramLink(job.permalink)} target="_blank" rel="noopener noreferrer">Open Telegram post</a>}
        </Flex>
      </Flex>)}
    </Flex></Modal.Body>
    <Modal.Footer>
      <Button variant="tertiary" onClick={close}>Close</Button>
      <Flex gap={2}>
        <Button disabled={state.busy || state.page === 1} onClick={() => state.setPage(state.page - 1)}>Previous</Button>
        <Button disabled={state.busy || state.page * 20 >= state.total} onClick={() => state.setPage(state.page + 1)}>Next</Button>
      </Flex>
    </Modal.Footer>
  </Modal.Content></Modal.Root>;
}

function StoredPostControls() {
  const [open, setOpen] = useState(false);
  return <><Button variant="secondary" onClick={() => setOpen(true)}>View Telegram posts</Button>{open && <StoredPostList close={() => setOpen(false)} />}</>;
}
export const TelegramPostsPanel: PanelComponent = ({ model }) => {
  const user = useAuth('TelegramPostsPanel', auth => auth.user);
  if (!isSuperAdminUser(user) || model !== 'api::telegram-page.telegram-page') return null;
  return { title: 'Telegram posts', content: <StoredPostControls /> };
};
