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
  Typography,
  VisuallyHidden,
} from '@strapi/design-system';
import * as React from 'react';
import styled from 'styled-components';
import {
  dealImageError,
  type DealImageApiError,
  type DealImageAsset,
  useDealImageApi,
} from '../api/deal-image-api';
import { DealImageLibraryDialog } from './deal-image-library-dialog';

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

const CurrentImageFrame = styled.div`
  display: grid;
  place-items: center;
  min-height: 20rem;
  overflow: hidden;
  background-color: ${({ theme }) => theme.colors.neutral100};
  background-image:
    linear-gradient(45deg, ${({ theme }) => theme.colors.neutral200} 25%, transparent 25%),
    linear-gradient(-45deg, ${({ theme }) => theme.colors.neutral200} 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, ${({ theme }) => theme.colors.neutral200} 75%),
    linear-gradient(-45deg, transparent 75%, ${({ theme }) => theme.colors.neutral200} 75%);
  background-position:
    0 0,
    0 1rem,
    1rem -1rem,
    -1rem 0;
  background-size: 2rem 2rem;
`;

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
  const [isLibraryOpen, setIsLibraryOpen] = React.useState(false);
  const [isLibraryLoading, setIsLibraryLoading] = React.useState(true);

  const current =
    field.value && typeof field.value === 'object'
      ? (field.value as DealImageAsset)
      : null;

  const loadAssets = React.useCallback(async () => {
    try {
      setAssets(await api.list());
    } catch {
      // The upload remains usable even if the optional reuse list is offline.
    } finally {
      setIsLibraryLoading(false);
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

  React.useEffect(() => {
    if (!isUploading) return;

    const form = inputRef.current?.closest('form');
    if (!form) return;

    const preventDealSave = (event: SubmitEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleNotification({
        type: 'warning',
        title: 'Deal image upload in progress',
        message:
          'The Deal cannot be saved until the image is transparent, optimized, and saved to AWS.',
      });
    };

    form.addEventListener('submit', preventDealSave, true);
    return () => form.removeEventListener('submit', preventDealSave, true);
  }, [isUploading, toggleNotification]);

  const upload = React.useCallback(
    async (file: File) => {
      if (isUploading) {
        toggleNotification({
          type: 'warning',
          title: 'Deal image upload in progress',
          message:
            'Wait for the current image to finish processing before choosing another image.',
        });
        return;
      }

      setIsLibraryOpen(false);
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
      isUploading,
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
      <Flex
        direction="column"
        alignItems="stretch"
        gap={3}
        aria-busy={isUploading}
      >
        <Field.Label action={labelAction}>{label}</Field.Label>

        {current && previewUrl(current) ? (
          <Box
            borderColor="neutral200"
            hasRadius
            overflow="hidden"
          >
            <CurrentImageFrame>
              <img
                src={previewUrl(current)!}
                alt={current.alternativeText || current.name}
                width={640}
                height={220}
                style={{
                  display: 'block',
                  width: '100%',
                  height: 220,
                  objectFit: 'contain',
                }}
              />
            </CurrentImageFrame>
            <Flex padding={3} justifyContent="space-between" gap={3}>
              <Box minWidth={0}>
                <Typography tag="p" fontWeight="semiBold" ellipsis>
                  {current.name}
                </Typography>
                <Typography variant="pi" textColor="neutral600" tag="p">
                  Current Deal image
                </Typography>
              </Box>
              <Button
                size="S"
                variant="danger-light"
                disabled={disabled || isUploading}
                onClick={() => {
                  if (!isUploading) field.onChange(name, null);
                }}
              >
                Remove
              </Button>
            </Flex>
          </Box>
        ) : null}

        <Box
          padding={4}
          background="neutral100"
          borderColor="neutral200"
          hasRadius
        >
          <Flex direction="column" alignItems="stretch" gap={3}>
            <Box>
              <Typography tag="p" fontWeight="semiBold">
                Add a Deal image
              </Typography>
              <Typography
                tag="p"
                variant="pi"
                textColor="neutral600"
                marginTop={1}
              >
                Upload a new image for background removal, or reuse one that is
                already processed.
              </Typography>
            </Box>
            <Flex gap={2} wrap="wrap">
              <VisuallyHidden>
                <input
                  ref={inputRef}
                  name={`${name}-upload`}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif"
                  tabIndex={-1}
                  disabled={disabled || isUploading}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void upload(file);
                  }}
                />
              </VisuallyHidden>
              <Button
                type="button"
                loading={isUploading}
                disabled={disabled || isUploading}
                onClick={() => inputRef.current?.click()}
              >
                Upload new image
              </Button>
              <Button
                type="button"
                variant="secondary"
                loading={isLibraryLoading}
                disabled={
                  disabled ||
                  isUploading ||
                  isLibraryLoading ||
                  assets.length === 0
                }
                onClick={() => setIsLibraryOpen(true)}
              >
                Choose from gallery
              </Button>
            </Flex>
            <Typography tag="p" variant="pi" textColor="neutral600">
              New uploads are processed once. Only transparent WebP/AVIF
              versions are saved to AWS.
            </Typography>
          </Flex>
        </Box>

        {isUploading ? (
          <Alert
            variant="warning"
            title="Deal image upload in progress"
          >
            <Typography role="status" aria-live="polite">
              The image is being made transparent, optimized, and saved to
              AWS. Wait before removing it, selecting another image, or saving
              the Deal. {elapsedSeconds}s elapsed.
            </Typography>
          </Alert>
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

        <Field.Hint />
        <Field.Error />
      </Flex>
      <DealImageLibraryDialog
        assets={assets}
        current={current}
        open={isLibraryOpen}
        onOpenChange={setIsLibraryOpen}
        onSelect={(asset) => {
          if (!isUploading) field.onChange(name, asset as any);
        }}
      />
    </Field.Root>
  );
};

export default React.memo(DealImageInput);
