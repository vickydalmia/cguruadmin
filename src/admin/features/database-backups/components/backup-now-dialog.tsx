import * as React from 'react';
import { Dialog, Field, Textarea, Typography } from '@strapi/design-system';
import { ConfirmDialog } from '@strapi/strapi/admin';

import { BACKUP_NOTE_MAX_LENGTH } from '../../../../constants/database-backup';

/**
 * "Back up now" confirmation with an optional note (shown in the history
 * table, e.g. "before the Diwali import"). The note is the only input.
 */
export function BackupNowDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (note: string | null) => Promise<unknown>;
}) {
  const [note, setNote] = React.useState('');
  React.useEffect(() => {
    if (open) setNote('');
  }, [open]);
  const tooLong = note.length > BACKUP_NOTE_MAX_LENGTH;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <ConfirmDialog
        title="Back up the database now?"
        variant="default"
        onConfirm={async () => {
          if (tooLong) return;
          onOpenChange(false);
          await onConfirm(note.trim() ? note.trim() : null);
        }}
      >
        <Typography>
          A full PostgreSQL dump is taken and uploaded to the backup bucket. The website and the
          admin stay available while it runs.
        </Typography>
        <Field.Root
          name="backup-note"
          error={tooLong ? `Keep the note under ${BACKUP_NOTE_MAX_LENGTH} characters.` : undefined}
          hint="Optional. Shown in the history, e.g. why this backup was taken."
        >
          <Field.Label>Note</Field.Label>
          <Textarea
            value={note}
            onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setNote(event.target.value)}
          />
          <Field.Hint />
          <Field.Error />
        </Field.Root>
      </ConfirmDialog>
    </Dialog.Root>
  );
}
