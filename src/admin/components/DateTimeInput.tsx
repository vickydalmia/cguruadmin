/**
 * Replacement for the built-in `datetime` input (registered via
 * app.addFields in ../app.tsx) — identical to Strapi's own DateTimeInput
 * except the time dropdown offers 5-minute steps instead of 15 (QC request
 * for coupon scheduledAt/expiresAt precision). Mirrors
 * @strapi/admin .../FormInputs/DateTime.mjs: field value is an ISO string,
 * picker value a Date.
 */

import * as React from 'react';
import { useField } from '@strapi/strapi/admin';
import { DateTimePicker, Field } from '@strapi/design-system';

const MAX_DATE = new Date(2099, 11, 31);
const TIME_STEP_MINUTES = 5;

interface DateTimeInputProps {
  name: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  labelAction?: React.ReactNode;
}

const DateTimeInput = ({
  name,
  label,
  hint,
  disabled,
  required,
  labelAction,
}: DateTimeInputProps) => {
  const field = useField<string | Date>(name);
  const value =
    typeof field.value === 'string' ? new Date(field.value) : field.value ?? undefined;

  return (
    <Field.Root error={field.error} name={name} hint={hint} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <DateTimePicker
        clearLabel="Clear"
        disabled={disabled}
        onChange={(date?: Date) => {
          field.onChange(name, (date ? date.toISOString() : null) as any);
        }}
        onClear={() => field.onChange(name, null as any)}
        value={value}
        maxDate={MAX_DATE}
        step={TIME_STEP_MINUTES}
      />
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
};

export default React.memo(DateTimeInput);
