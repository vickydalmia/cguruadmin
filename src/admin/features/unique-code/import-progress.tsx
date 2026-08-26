// PROGRESS presentation for the unique-code import: the batch counter shown
// while the sequential request loop runs. State comes from
// ./use-code-import.
import * as React from 'react';
import { Flex, ProgressBar, Typography } from '@strapi/design-system';

import { type Progress } from './use-code-import';

export function ImportProgress({ progress }: { progress: Progress }) {
  return (
    <Flex direction="column" alignItems="stretch" gap={2}>
      <ProgressBar
        value={Math.round((progress.done / Math.max(1, progress.total)) * 100)}
      />
      <Typography variant="pi" textColor="neutral600">
        Uploading batch {progress.done} of {progress.total}…
      </Typography>
    </Flex>
  );
}
