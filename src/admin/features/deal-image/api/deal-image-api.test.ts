import { describe, expect, it } from 'vitest';
import { dealImageError } from './deal-image-contract';

describe('dealImageError', () => {
  it('preserves the safe structured credit error from the server', () => {
    expect(
      dealImageError({
        response: {
          data: {
            error: {
              code: 'BACKGROUND_REMOVAL_CREDITS_EXHAUSTED',
              message:
                'Background-removal credits are unavailable. The image was not saved.',
              retryable: false,
              referenceId: 'support-123',
            },
          },
        },
      }),
    ).toEqual({
      code: 'BACKGROUND_REMOVAL_CREDITS_EXHAUSTED',
      message:
        'Background-removal credits are unavailable. The image was not saved.',
      retryable: false,
      referenceId: 'support-123',
    });
  });

  it('uses a safe retryable fallback for an unstructured network error', () => {
    expect(dealImageError(new Error('socket reset'))).toEqual({
      code: 'DEAL_IMAGE_UPLOAD_FAILED',
      message: 'The transparent image could not be saved. Please retry.',
      retryable: true,
      referenceId: 'unavailable',
    });
  });
});
