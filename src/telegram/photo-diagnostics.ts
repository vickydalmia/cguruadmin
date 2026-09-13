// Diagnostics deliberately use fixed descriptions, never raw exception text,
// stacks, request bodies, credentials or signed/bot API URLs.
export const PHOTO_STEPS = [
  'post-lookup', 'upload-lookup', 'telegram-file', 'telegram-download',
  'image-prepare', 'fal-upload', 'fal-submit', 'fal-status', 'fal-result',
  'fal-download', 'image-upload', 'post-publish', 'photo-cleanup',
] as const;
export type PhotoStep = typeof PHOTO_STEPS[number];
export type PhotoDiagnostic = {
  step: PhotoStep; message: string; occurredAt: string;
  type: string; status?: number; code?: string;
  contentType?: string; detectedType?: string;
};
export const PHOTO_DIAGNOSIS_REQUEST = '{"checkRequested":true}';
export class PhotoCheckComplete extends Error {
  constructor() { super('Read-only image check completed'); this.name = 'PhotoCheckComplete'; }
}

const ERROR_TYPES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError',
  'TelegramApiError', 'ApiError', 'ValidationError', 'DealImageProcessingError', 'PhotoPending', 'PhotoSubmissionUncertain', 'PhotoCheckComplete']);
const ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ENOENT', 'EACCES', 'ENOSPC', 'ENAMETOOLONG', 'SQLITE_BUSY', '23505', '23503', '42703', '42P01', '40001', '40P01',
  'TELEGRAM_FILE_PATH_INVALID', 'TELEGRAM_FILE_PATH_URL', 'TELEGRAM_FILE_PATH_ABSOLUTE',
  'TELEGRAM_FILE_PATH_TRAVERSAL', 'TELEGRAM_FILE_PATH_FORMAT', 'TELEGRAM_FILE_PATH_CHARACTERS',
  'TELEGRAM_PHOTO_CONTENT_TYPE', 'TELEGRAM_PHOTO_TYPE_MISMATCH', 'TELEGRAM_PHOTO_SIGNATURE_INVALID']);
const CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/webp', 'image/gif',
  'image/avif', 'application/octet-stream', 'binary/octet-stream', 'application/x-octet-stream',
  'text/html', 'text/plain', 'application/json', 'application/pdf', 'unknown']);
export function diagnosticContentType(value: string): string { return CONTENT_TYPES.has(value) ? value : 'unknown'; }
const REASONS: Array<[RegExp, string]> = [
  [/^Saved image processing is still in progress$/, 'The saved background-removal request is still processing. No new request was submitted.'],
  [/^Image submission acceptance is uncertain$/, 'The previous submission may have been accepted, but its request identifier was not saved. Automatic resubmission is paused.'],
  [/^Read-only image check completed$/, 'The preceding steps succeeded. This check stopped before starting paid processing or uploading an image.'],
  [/wrong file.?id|file.?id.*invalid|file is temporarily unavailable/i, 'Telegram rejected the photo identifier or the photo is temporarily unavailable.'],
  [/invalid Telegram file path/i, 'Telegram returned a file path that failed validation.'],
  [/unsupported content type/i, 'Telegram returned an unsupported Content-Type header.'],
  [/invalid image content/i, 'The downloaded bytes do not match a supported image type or the declared Content-Type.'],
  [/file.*too (?:big|large)|exceeds.*(?:limit|size)/i, 'The photo exceeds the allowed file size.'],
  [/unsupported.*(?:type|format)|invalid.*(?:image|photo|file path)|signature/i, 'The downloaded photo has an invalid or unsupported format.'],
  [/credit|balance|billing|payment|quota|funds/i, 'The provider reports unavailable processing credits.'],
  [/not configured|unauthori[sz]ed|forbidden|access.?denied|invalid.*(?:key|credential)/i, 'The service rejected its credentials or access permissions.'],
  [/abort|time.?out|timed out/i, 'The request timed out or was cancelled.'],
  [/fetch failed|network|socket|connection/i, 'The network request failed.'],
  [/enoent|no such file/i, 'A required local file or directory was not found.'],
  [/enospc|no space left/i, 'Local storage has no free space.'],
  [/enametoolong|file name too long/i, 'A generated file name exceeds the storage limit.'],
  [/eacces|permission denied/i, 'The process cannot access the required file or directory.'],
  [/invalid input syntax|value too long|column.*does not exist|relation.*does not exist|constraint/i, 'The database rejected the operation.'],
  [/cannot read properties|is not a function/i, 'An expected processing method or value is unavailable.'],
];

export function photoDiagnostic(error: unknown, step: PhotoStep, now = new Date()): PhotoDiagnostic {
  const chain: any[] = [];
  for (let current: any = error; current && chain.length < 4 && !chain.includes(current); current = current.cause) chain.push(current);
  const code = chain.map(item => item.code).find(value => typeof value === 'string' && ERROR_CODES.has(value));
  const status = chain.map(item => item.status ?? item.$metadata?.httpStatusCode)
    .find(value => Number.isInteger(value) && value >= 400 && value <= 599);
  // Text is used only for classification; none of it is copied to the result.
  const text = chain.map(item => typeof item.message === 'string' ? item.message.slice(0, 4000) : '').join(' ');
  const message = REASONS.find(([pattern]) => pattern.test(text))?.[1] ?? 'The operation failed unexpectedly.';
  const contentType = chain.map(item => item.contentType).find(value => CONTENT_TYPES.has(value));
  const detectedType = chain.map(item => item.detectedType).find(value => CONTENT_TYPES.has(value));
  return { step, message, occurredAt: now.toISOString(),
    type: ERROR_TYPES.has(chain[0]?.name) ? chain[0].name : 'Error',
    ...(status ? { status } : {}), ...(code ? { code } : {}),
    ...(contentType ? { contentType } : {}), ...(detectedType ? { detectedType } : {}),
  };
}

/** Validate the stored projection before it enters an admin response. */
export function readPhotoDiagnostic(value: string | null | undefined): PhotoDiagnostic | null {
  try {
    const data = JSON.parse(value ?? 'null');
    if (!data || !PHOTO_STEPS.includes(data.step) || !ERROR_TYPES.has(data.type)
      || !Number.isFinite(Date.parse(data.occurredAt))) return null;
    const allowed = ['The operation failed unexpectedly.', ...REASONS.map(([, message]) => message)];
    if (!allowed.includes(data.message)) return null;
    return { step: data.step, type: data.type, message: data.message, occurredAt: new Date(data.occurredAt).toISOString(),
      ...(Number.isInteger(data.status) && data.status >= 400 && data.status <= 599 ? { status: data.status } : {}),
      ...(ERROR_CODES.has(data.code) ? { code: data.code } : {}),
      ...(CONTENT_TYPES.has(data.contentType) ? { contentType: data.contentType } : {}),
      ...(CONTENT_TYPES.has(data.detectedType) ? { detectedType: data.detectedType } : {}),
    };
  } catch { return null; }
}
