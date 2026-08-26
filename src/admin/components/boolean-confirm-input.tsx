/**
 * Replacement for the built-in `boolean` input (registered via
 * app.addFields({ type: 'boolean' }) in ../app.tsx). Identical toggle, except
 * flipping it opens a confirmation dialog first — a QC request to stop
 * accidental ON/OFF toggles (e.g. publishing/verifying by a stray click). The
 * form value only changes after the editor confirms.
 */

import * as React from 'react';
import { useField } from '@strapi/strapi/admin';
import { Button, Dialog, Field, Toggle } from '@strapi/design-system';

interface BooleanConfirmInputProps {
  name: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  labelAction?: React.ReactNode;
}

const BooleanConfirmInput = ({
  name,
  label,
  hint,
  disabled,
  required,
  labelAction,
}: BooleanConfirmInputProps) => {
  const field = useField<boolean | null>(name);
  // The value awaiting confirmation (null = no dialog open).
  const [pending, setPending] = React.useState<boolean | null>(null);

  const requestChange = (next: boolean) => {
    if (next === field.value) return; // no-op, nothing to confirm
    setPending(next);
  };

  const confirm = () => {
    field.onChange(name, pending as any);
    setPending(null);
  };

  const cancel = () => setPending(null);

  return (
    <Field.Root name={name} hint={hint} error={field.error} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <Toggle
        onLabel="True"
        offLabel="False"
        checked={field.value ?? null}
        disabled={disabled}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          requestChange(e.target.checked)
        }
      />
      <Field.Hint />
      <Field.Error />

      <Dialog.Root
        open={pending !== null}
        onOpenChange={(open: boolean) => {
          if (!open) cancel();
        }}
      >
        <Dialog.Content>
          <Dialog.Header>Confirm change</Dialog.Header>
          <Dialog.Body>
            {`Turn "${label}" ${pending ? 'ON (True)' : 'OFF (False)'}?`}
          </Dialog.Body>
          <Dialog.Footer>
            <Dialog.Cancel>
              <Button variant="tertiary" onClick={cancel}>
                Cancel
              </Button>
            </Dialog.Cancel>
            <Dialog.Action>
              <Button onClick={confirm}>Confirm</Button>
            </Dialog.Action>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </Field.Root>
  );
};

export default React.memo(BooleanConfirmInput);
