import { Field, SingleSelect, SingleSelectOption, Typography } from '@strapi/design-system';

export function UploadQualityField({ value, onChange, disabled }: {
  value: 'default' | 'high';
  onChange: (value: 'default' | 'high') => void;
  disabled: boolean;
}) {
  return (
    <Field.Root name="imageQuality" hint={value === 'high'
      ? 'High keeps more detail for large banners and Retina screens. Files are larger and may take longer to upload and load. Smaller versions are still generated for mobile. It cannot improve a low-resolution original.'
      : 'Default balances image clarity and loading speed for everyday images.'}>
      <Field.Label>Image quality</Field.Label>
      <SingleSelect value={value} onChange={(next) => onChange(next === 'high' ? 'high' : 'default')} disabled={disabled}>
        <SingleSelectOption value="default">Default</SingleSelectOption>
        <SingleSelectOption value="high">High</SingleSelectOption>
      </SingleSelect>
      <Field.Hint />
      <Typography variant="pi" textColor="neutral600">Applies to all images in this upload. Existing images are unchanged.</Typography>
    </Field.Root>
  );
}
