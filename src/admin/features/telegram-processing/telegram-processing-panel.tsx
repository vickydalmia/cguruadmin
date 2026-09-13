import type { PanelComponent } from '@strapi/content-manager/strapi-admin';
import { useAuth } from '@strapi/strapi/admin';
import { Button, Flex, Typography } from '@strapi/design-system';
import { isSuperAdminUser } from '../../utils/super-admin';
import { useTelegramProcessing } from './use-telegram-processing';
import { ProcessingDetails } from './processing-details';

function ProcessingControls() {
  const state = useTelegramProcessing();
  return <Flex direction="column" alignItems="stretch" gap={3}>
    <Typography variant="pi">{state.total} posts awaiting images. New posts appear after their images are ready.</Typography>
    <Button disabled={state.busy} variant="secondary" onClick={() => void state.refresh()}>Refresh status</Button>
    {state.error && <Typography role="alert" textColor="danger600">{state.error}</Typography>}
    {state.jobs.map(job => <Flex key={job.id} direction="column" alignItems="stretch" gap={2}>
      <Typography variant="pi">Post {job.messageId}: {job.stage}</Typography>
      <ProcessingDetails job={job} />
      {job.error && <>
        <Button disabled={state.busy || job.checking} variant="tertiary" onClick={() => void state.check(job)}>Check image failure</Button>
        <Typography variant="pi">Checks the source and saved processing without starting a paid background-removal job.</Typography>
      </>}
      {job.error && job.error !== 'FAL_SUBMISSION_UNCERTAIN' && job.stage !== 'submitting' && <Button disabled={state.busy} variant="tertiary" onClick={() => void state.retry(job, false)}>Retry saved processing</Button>}
      {job.error === 'FAL_SUBMISSION_UNCERTAIN' && <Typography variant="pi">The previous request may already have been accepted. Its status cannot be recovered, so retrying saved processing is unavailable.</Typography>}
      {job.stage === 'blocked' && <>
        <Typography variant="pi">Starting again may use background-removal credits.</Typography>
        <Button disabled={state.busy} variant="secondary" onClick={() => void state.retry(job, true)}>Process image again</Button>
      </>}
    </Flex>)}
    {state.total > 20 && <Flex gap={2}>
      <Button disabled={state.busy || state.page === 1} onClick={() => state.setPage(state.page - 1)}>Previous</Button>
      <Button disabled={state.busy || state.page * 20 >= state.total} onClick={() => state.setPage(state.page + 1)}>Next</Button>
    </Flex>}
  </Flex>;
}

export const TelegramProcessingPanel: PanelComponent = ({ model }) => {
  const user = useAuth('TelegramProcessingPanel', auth => auth.user);
  if (!isSuperAdminUser(user) || model !== 'api::telegram.telegram') return null;
  return { title: 'Telegram images', content: <ProcessingControls /> };
};
