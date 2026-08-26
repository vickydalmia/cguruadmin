import crypto from 'node:crypto';
// Deal-image ERRORS: the public error-code contract and the processing
// error class. One of the modules split out of deal-image-background.ts.

export type DealImageErrorCode =
  | 'BACKGROUND_REMOVAL_CREDITS_EXHAUSTED'
  | 'BACKGROUND_REMOVAL_NOT_CONFIGURED'
  | 'BACKGROUND_REMOVAL_RATE_LIMITED'
  | 'BACKGROUND_REMOVAL_TIMED_OUT'
  | 'BACKGROUND_REMOVAL_REJECTED'
  | 'BACKGROUND_REMOVAL_UNAVAILABLE'
  | 'BACKGROUND_REMOVAL_INVALID_OUTPUT'
  | 'DEAL_IMAGE_INVALID_SOURCE'
  | 'DEAL_IMAGE_ARCHIVE_WRITE_FAILED'
  | 'DEAL_IMAGE_OPTIMIZATION_FAILED'
  | 'DEAL_IMAGE_STORAGE_FAILED';

const PUBLIC_ERROR: Record<
  DealImageErrorCode,
  { message: string; retryable: boolean; status: number }
> = {
  BACKGROUND_REMOVAL_CREDITS_EXHAUSTED: {
    message:
      'Background-removal credits are unavailable. The image was not saved. Please add credits or contact an administrator.',
    retryable: false,
    status: 402,
  },
  BACKGROUND_REMOVAL_NOT_CONFIGURED: {
    message:
      'The background-removal service is not configured correctly. The image was not saved.',
    retryable: false,
    status: 503,
  },
  BACKGROUND_REMOVAL_RATE_LIMITED: {
    message:
      'The background-removal service is busy. The image was not saved. Please retry shortly.',
    retryable: true,
    status: 429,
  },
  BACKGROUND_REMOVAL_TIMED_OUT: {
    message:
      'The background-removal service timed out. The image was not saved. Please retry.',
    retryable: true,
    status: 504,
  },
  BACKGROUND_REMOVAL_REJECTED: {
    message:
      'The background-removal service could not process this image. The image was not saved. Please try a PNG, JPG or WebP image.',
    retryable: false,
    status: 422,
  },
  BACKGROUND_REMOVAL_UNAVAILABLE: {
    message:
      'The background-removal service could not process this image. The image was not saved. Please retry.',
    retryable: true,
    status: 503,
  },
  BACKGROUND_REMOVAL_INVALID_OUTPUT: {
    message:
      'Background removal returned an invalid image. The image was not saved.',
    retryable: true,
    status: 502,
  },
  DEAL_IMAGE_INVALID_SOURCE: {
    message:
      'This Deal image is invalid or unsupported. The image was not saved.',
    retryable: false,
    status: 422,
  },
  DEAL_IMAGE_ARCHIVE_WRITE_FAILED: {
    message:
      'The transparent image could not be saved locally. The image was not uploaded to AWS.',
    retryable: true,
    status: 507,
  },
  DEAL_IMAGE_OPTIMIZATION_FAILED: {
    message:
      'The transparent image could not be optimized. The image was not saved.',
    retryable: true,
    status: 500,
  },
  DEAL_IMAGE_STORAGE_FAILED: {
    message:
      'The transparent image could not be saved to AWS. Please retry.',
    retryable: true,
    status: 503,
  },
};

export class DealImageProcessingError extends Error {
  readonly code: DealImageErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly referenceId: string;
  readonly providerRequestId?: string;
  readonly cause?: unknown;

  constructor(
    code: DealImageErrorCode,
    options: {
      cause?: unknown;
      providerRequestId?: string;
      referenceId?: string;
    } = {},
  ) {
    super(PUBLIC_ERROR[code].message);
    this.name = 'DealImageProcessingError';
    this.code = code;
    this.retryable = PUBLIC_ERROR[code].retryable;
    this.status = PUBLIC_ERROR[code].status;
    this.referenceId =
      options.referenceId ?? crypto.randomBytes(8).toString('hex');
    this.providerRequestId = options.providerRequestId;
    this.cause = options.cause;
  }

  toResponse() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      referenceId: this.referenceId,
    };
  }
}
