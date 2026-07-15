/**
 * Replacement for the built-in `uid` input (registered via
 * app.addFields({ type: 'uid' }) in ../app.tsx).
 *
 * Strapi's stock UID input seeds the field with the model's singular name
 * ("store", "brand", …) when the source field is empty, so a fresh entry opens
 * with a bogus "store" slug the editor has to delete first (QC bug). This
 * version starts EMPTY and mirrors the useful part of the stock behavior:
 * while the slug hasn't been hand-edited, it auto-fills from the `name` field
 * (slugified) — and an empty name yields an empty slug, never "store". A
 * "Regenerate" button re-derives it on demand.
 *
 * Trade-off: this drops Strapi's live availability indicator. Uniqueness is
 * still enforced by the schema (`required` + `uid`) on save. All UID fields in
 * this project target `name`, so the source field is hardcoded to `name`.
 */

import * as React from 'react';
import { useField, useForm } from '@strapi/strapi/admin';
import { Button, Field, Flex, TextInput } from '@strapi/design-system';

const SOURCE_FIELD = 'name';

const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

interface SlugInputProps {
  name: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  labelAction?: React.ReactNode;
}

const SlugInput = ({
  name,
  label,
  hint,
  disabled,
  required,
  labelAction,
}: SlugInputProps) => {
  const field = useField<string>(name);
  const source = useForm('SlugInput', (state) => state.values?.[SOURCE_FIELD]) as
    | string
    | undefined;

  // Lock auto-fill once the slug is hand-edited, and treat an already-saved
  // slug (present on mount) as locked so we never clobber a custom slug.
  const editedRef = React.useRef<boolean>(Boolean(field.value));

  React.useEffect(() => {
    if (editedRef.current) return;
    const next = slugify(String(source ?? ''));
    if ((field.value ?? '') !== next) {
      field.onChange(name, next as any);
    }
    // Intentionally keyed on `source` only — reacts to name edits, not to our
    // own slug writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const onManualChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    editedRef.current = true;
    field.onChange(name, e.target.value as any);
  };

  const regenerate = () => {
    field.onChange(name, slugify(String(source ?? '')) as any);
  };

  return (
    <Field.Root name={name} hint={hint} error={field.error} required={required}>
      <Field.Label action={labelAction}>{label}</Field.Label>
      <Flex gap={2} alignItems="flex-start">
        <TextInput
          name={name}
          value={field.value ?? ''}
          onChange={onManualChange}
          disabled={disabled}
          placeholder="auto-generated from the name"
        />
        <Button
          variant="tertiary"
          onClick={regenerate}
          disabled={disabled || !source}
        >
          Regenerate
        </Button>
      </Flex>
      <Field.Hint />
      <Field.Error />
    </Field.Root>
  );
};

export default React.memo(SlugInput);
