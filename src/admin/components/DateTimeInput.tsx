/**
 * Replacement for the built-in `datetime` input (registered via
 * app.addFields in ../app.tsx) — identical to Strapi's own DateTimeInput
 * except the time dropdown offers 5-minute steps instead of 15 (QC request
 * for coupon scheduledAt/expiresAt precision). Mirrors
 * @strapi/admin .../FormInputs/DateTime.mjs: field value is an ISO string,
 * picker value a Date.
 *
 * Row 62 — this override also carries the guard for two RangeError crashes in
 * the design-system DateTimePicker. The full trace lives in
 * ../utils/parse-time-text.ts; the short version is that the picker calls
 * `.toISOString()` on whatever `value` it is given and `Intl…format()` on
 * whatever the time box parses to, and neither call is defended.
 *
 * This component is registered GLOBALLY for every datetime field, so both
 * guards are written to fail safe: if the design system changes shape under
 * us, the sanitiser stops matching and does nothing, which is exactly today's
 * behaviour rather than a new failure mode.
 */

import * as React from 'react';
import { useField } from '@strapi/strapi/admin';
import { DateTimePicker, Field } from '@strapi/design-system';
import {
  isUnsafeTimeText,
  timeSeparatorsFor,
  toIsoStringOrNull,
  toSafeDate,
} from '../utils/parse-time-text';

const MAX_DATE = new Date(2099, 11, 31);
const TIME_STEP_MINUTES = 5;

// Passed explicitly rather than left to the design-system default so the
// sanitiser below has a stable selector. DateTimePicker spreads this onto the
// SAME element it attaches the crashing onBlur to (the Combobox text input),
// so matching on it identifies exactly the right node.
const TIME_LABEL = 'Choose time';

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

  // GUARD 1 (render path). A stored value that does not parse — a malformed
  // datetime string, or an Invalid Date — used to reach the picker's internal
  // `i.toISOString()` and throw during render, blanking the whole edit form.
  // Degrading to an empty picker leaves the editor a box they can fix.
  const value = toSafeDate(field.value);

  const containerRef = React.useRef<HTMLDivElement>(null);

  // GUARD 2 (blur path). The time box is free text and permits "-", "." and
  // "+". Blurring on one of those makes the picker's own parser build
  // `new Date(0, 0, 0, NaN, 0)` and hand it to Intl.format, which throws
  // RangeError. React error boundaries do NOT catch throws from event
  // handlers, so that escapes to window and wedges the form.
  //
  // The listener runs in the CAPTURE phase on our own wrapper. React delegates
  // its bubble-phase onBlur at the app root, which the event only reaches
  // after capture has descended past this node — so we always run first and
  // can neutralise the input before the picker's handler reads `target.value`.
  //
  // Blanking (rather than rewriting) is what makes this safe: the picker's
  // parser starts with `if (!hour && !minute) return;`, so an empty string
  // takes its own early-exit path and it restores the last committed value —
  // the identical outcome to typing anything else it rejects, like "99".
  React.useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;

    const separators = timeSeparatorsFor();

    const sanitiseTimeText = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.getAttribute('aria-label') !== TIME_LABEL) return;
      if (!isUnsafeTimeText(target.value, separators)) return;
      target.value = '';
    };

    node.addEventListener('focusout', sanitiseTimeText, true);
    return () => node.removeEventListener('focusout', sanitiseTimeText, true);
  }, []);

  return (
    <Field.Root error={field.error} name={name} hint={hint} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      {/*
        `display: contents` keeps this wrapper out of the layout tree entirely,
        so the rendered box model is byte-identical to before it was added —
        while still sitting in the DOM tree, which is all event capture needs.
      */}
      <div ref={containerRef} style={{ display: 'contents' }}>
        <DateTimePicker
          clearLabel="Clear"
          timeLabel={TIME_LABEL}
          disabled={disabled}
          onChange={(date?: Date) => {
            // GUARD 3 (write path). Same RangeError, other direction: never
            // call .toISOString() on a Date the picker could not resolve.
            field.onChange(name, toIsoStringOrNull(date) as any);
          }}
          onClear={() => field.onChange(name, null as any)}
          value={value}
          maxDate={MAX_DATE}
          step={TIME_STEP_MINUTES}
        />
      </div>
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
};

export default React.memo(DateTimeInput);
