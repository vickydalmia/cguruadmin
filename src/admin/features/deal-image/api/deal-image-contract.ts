import { z } from 'zod';

export const dealImageAssetSchema = z
  .object({
    id: z.number(),
    documentId: z.string().optional(),
    name: z.string(),
    alternativeText: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
    width: z.number().nullable().optional(),
    height: z.number().nullable().optional(),
    formats: z.record(z.string(), z.unknown()).nullable().optional(),
    ext: z.string().nullable().optional(),
    mime: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
    url: z.string(),
  })
  .passthrough();

export const dealImageAssetsSchema = z.array(dealImageAssetSchema);

const dealImageErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    referenceId: z.string(),
  }),
});

export type DealImageAsset = z.infer<typeof dealImageAssetSchema>;
export type DealImageApiError = z.infer<
  typeof dealImageErrorSchema
>['error'];

export function dealImageError(error: unknown): DealImageApiError {
  const body =
    error && typeof error === 'object'
      ? (error as any).response?.data
      : undefined;
  const parsed = dealImageErrorSchema.safeParse(body);
  if (parsed.success) return parsed.data.error;
  return {
    code: 'DEAL_IMAGE_UPLOAD_FAILED',
    message: 'The transparent image could not be saved. Please retry.',
    retryable: true,
    referenceId: 'unavailable',
  };
}
