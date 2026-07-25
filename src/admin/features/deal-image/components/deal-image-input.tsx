import {
  useField,
  useForm,
  useNotification,
} from '@strapi/strapi/admin';
import {
  Alert,
  Box,
  Button,
  Field,
  Flex,
  SingleSelect,
  SingleSelectOption,
  Typography,
} from '@strapi/design-system';
import * as React from 'react';
import {
  dealImageError,
  type DealImageApiError,
  type DealImageAsset,
  useDealImageApi,
} from '../api/deal-image-api';

interface DealImageInputProps {
  name: string;
  label?: string;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  labelAction?: React.ReactNode;
}

const previewUrl = (asset: DealImageAsset | null): string | null => {
  if (!asset) return null;
  const thumbnail = asset.formats?.thumbnail;
  if (
    thumbnail &&
    typeof thumbnail === 'object' &&
    typeof (thumbnail as any).url === 'string'
  ) {
    return (thumbnail as any).url;
  }
  return asset.url;
};

const DealImageInput = ({
  name,
  label = 'Deal image',
  hint,
  disabled = false,
  required = false,
  labelAction,
}: DealImageInputProps) => {
  const field = useField<DealImageAsset | null>(name);
  const setFormSubmitting = useForm(
    'DealImageInput',
    (state) => state.setSubmitting,
  );
  const { toggleNotification } = useNotification();
  const api = useDealImageApi();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [assets, setAssets] = React.useState<DealImageAsset[]>([]);
  const [pendingFile, setPendingFile] = React.useState<File | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const [failure, setFailure] = React.useState<DealImageApiError | null>(null);

  const current =
    field.value && typeof field.value === 'object'
      ? (field.value as DealImageAsset)
      : null;

  const loadAssets = React.useCallback(async () => {
    try {
      setAssets(await api.list());
    } catch {
      // The upload remains usable even if the optional reuse list is offline.
    }
  }, [api]);

  React.useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  React.useEffect(() => {
    if (!isUploading) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isUploading]);

  const upload = React.useCallback(
    async (file: File) => {
      setPendingFile(file);
      setFailure(null);
      setIsUploading(true);
      setFormSubmitting(true);
      try {
        const asset = await api.upload(file);
        field.onChange(name, asset as any);
        setPendingFile(null);
        setAssets((previous) => [
          asset,
          ...previous.filter((item) => item.id !== asset.id),
        ]);
        toggleNotification({
          type: 'success',
          title: 'Transparent Deal image saved',
          message:
            'The background was removed and the optimized image was saved to AWS.',
        });
        if (inputRef.current) inputRef.current.value = '';
      } catch (error) {
        const nextFailure = dealImageError(error);
        setFailure(nextFailure);
        toggleNotification({
          type: 'danger',
          title: 'Deal image was not saved',
          message: nextFailure.message,
        });
      } finally {
        setIsUploading(false);
        setFormSubmitting(false);
      }
    },
    [
      api,
      field,
      name,
      setFormSubmitting,
      toggleNotification,
    ],
  );

  return (
    <Field.Root
      name={name}
      hint={hint}
      error={field.error}
      required={required}
    >
      <Flex direction="column" alignItems="stretch" gap={3}>
        <Field.Label action={labelAction}>{label}</Field.Label>

        {current && previewUrl(current) ? (
          <Box
            padding={3}
            background="neutral100"
            borderColor="neutral200"
            hasRadius
          >
            <img
              src={previewUrl(current)!}
              alt={current.alternativeText || current.name}
              style={{
                display: 'block',
                width: '100%',
                height: 220,
                objectFit: 'contain',
              }}
            />
            <Typography
              variant="pi"
              textColor="neutral600"
              tag="p"
              marginTop={2}
            >
              {current.name}
            </Typography>
          </Box>
        ) : null}

        <Field.Root name={`${name}-upload`}>
          <Field.Label>Upload a new Deal image</Field.Label>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/avif"
            disabled={disabled || isUploading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
          <Typography variant="pi" textColor="neutral600">
            The original stays temporary. Only the transparent WebP/AVIF
            versions are saved to AWS.
          </Typography>
        </Field.Root>

        {isUploading ? (
          <Typography variant="pi" textColor="primary600">
            Removing background, optimizing, and saving to AWS…{' '}
            {elapsedSeconds}s elapsed. Keep this page open.
          </Typography>
        ) : null}

        {failure ? (
          <Alert
            variant="danger"
            title="Image was not saved"
            closeLabel="Dismiss"
            onClose={() => setFailure(null)}
            action={
              pendingFile ? (
                <Button
                  size="S"
                  variant="secondary"
                  onClick={() => void upload(pendingFile)}
                >
                  Retry
                </Button>
              ) : undefined
            }
          >
            {failure.message} Reference: {failure.referenceId}.
          </Alert>
        ) : null}

        {assets.length > 0 ? (
          <Field.Root name={`${name}-existing`}>
            <Field.Label>Or reuse a transparent Deal image</Field.Label>
            <SingleSelect
              value={current?.id ? String(current.id) : undefined}
              disabled={disabled || isUploading}
              placeholder="Select a processed Deal image"
              onClear={() => field.onChange(name, null)}
              onChange={(value) => {
                const selected = assets.find(
                  (asset) => String(asset.id) === String(value),
                );
                if (selected) field.onChange(name, selected as any);
              }}
            >
              {assets.map((asset) => (
                <SingleSelectOption
                  key={asset.id}
                  value={String(asset.id)}
                >
                  {asset.name}
                </SingleSelectOption>
              ))}
            </SingleSelect>
          </Field.Root>
        ) : null}

        {current ? (
          <Flex justifyContent="flex-end">
            <Button
              size="S"
              variant="danger-light"
              disabled={disabled || isUploading}
              onClick={() => field.onChange(name, null)}
            >
              Remove
            </Button>
          </Flex>
        ) : null}

        <Field.Hint />
        <Field.Error />
      </Flex>
    </Field.Root>
  );
};

export default React.memo(DealImageInput);
