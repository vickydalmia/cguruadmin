import { TELEGRAM_MAX_PHOTO_BYTES } from '../constants/telegram';
import { diagnosticContentType } from './photo-diagnostics';

// Minimal Telegram Bot API client for channel-post ingestion. Only the
// handful of methods the ingest needs; every request carries a timeout and
// every error message is scrubbed of the bot token before it can reach a log
// or the admin. File downloads go through here too because the download URL
// embeds the token — callers receive bytes, never that URL.

export type TelegramMessageEntity = {
  type: string;
  offset: number;
  length: number;
  url?: string;
};

export type TelegramPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type TelegramChat = {
  id: number;
  type: string;
  title?: string;
  username?: string;
};

export type TelegramMessage = {
  message_id: number;
  date: number;
  edit_date?: number;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  photo?: TelegramPhotoSize[];
};

export type TelegramUpdate = {
  update_id: number;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
};

type ApiEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; description?: string; error_code?: number; parameters?: { retry_after?: number } };

export class TelegramApiError extends Error {
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly code?: string;
  readonly contentType?: string;
  readonly detectedType?: string;

  constructor(message: string, options: { status?: number; retryAfterSeconds?: number; cause?: unknown; code?: string; contentType?: string; detectedType?: string } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    // lib is ES2020: no ErrorOptions in the Error constructor signature.
    if (options.cause !== undefined) (this as any).cause = options.cause;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.code = options.code;
    this.contentType = options.contentType === undefined ? undefined : diagnosticContentType(options.contentType);
    this.detectedType = options.detectedType === undefined ? undefined : diagnosticContentType(options.detectedType);
  }
}

/** Remove every occurrence of the token from diagnostic text. */
export function redactBotToken(text: string, token: string | null | undefined): string {
  if (!token) return text;
  return text.split(token).join('<bot-token>');
}

export type BotApiOptions = {
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
};

export type GetUpdatesParams = {
  offset?: number;
  limit?: number;
  timeout?: number;
  allowed_updates?: string[];
};

export type BotApi = {
  getUpdates(params: GetUpdatesParams): Promise<TelegramUpdate[]>;
  getChatMemberCount(chatId: string): Promise<number>;
  getFile(fileId: string): Promise<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }>;
  downloadFile(filePath: string): Promise<{ bytes: Buffer; contentType: string | null }>;
};

const RETRIABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const BINARY_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/x-octet-stream']);

function photoContentType(bytes: Buffer): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function createBotApi(options: BotApiOptions): BotApi {
  const token = options.token;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');

  async function call<T>(method: string, params: Record<string, unknown>, attempt = 0): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (cause) {
      const message = redactBotToken(cause instanceof Error ? cause.message : String(cause), token);
      if (attempt === 0) return call<T>(method, params, attempt + 1);
      throw new TelegramApiError(`Telegram ${method} request failed: ${message}`);
    }

    let envelope: ApiEnvelope<T> | null = null;
    try {
      envelope = (await response.json()) as ApiEnvelope<T>;
    } catch {
      envelope = null;
    }

    if (envelope?.ok === true) return envelope.result;

    const status = response.status;
    const retryAfterSeconds =
      envelope && envelope.ok === false ? envelope.parameters?.retry_after : undefined;
    if (attempt === 0 && RETRIABLE_STATUS.has(status) && (retryAfterSeconds ?? 0) <= 5) {
      if (retryAfterSeconds) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
      }
      return call<T>(method, params, attempt + 1);
    }
    const description =
      envelope && envelope.ok === false && envelope.description
        ? envelope.description
        : `HTTP ${status}`;
    throw new TelegramApiError(
      `Telegram ${method} failed: ${redactBotToken(description, token)}`,
      { status, retryAfterSeconds },
    );
  }

  return {
    getUpdates: (params) => call<TelegramUpdate[]>('getUpdates', params),
    getChatMemberCount: (chatId) => call<number>('getChatMemberCount', { chat_id: chatId }),
    getFile: (fileId) => call('getFile', { file_id: fileId }),
    async downloadFile(filePath) {
      // Only Telegram-relative file paths; never follow a token-bearing URL
      // to another origin, and never pass traversal through URL normalization.
      // getFile paths are opaque: an extension is not required, and safe dots
      // may occur in names. Validate each segment instead of imposing a name
      // format. Encoded paths, URL delimiters and dot segments stay forbidden.
      if (typeof filePath !== 'string' || /[^a-zA-Z0-9_./-]/.test(filePath)
        || filePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        const code = typeof filePath !== 'string' ? 'TELEGRAM_FILE_PATH_INVALID'
          : /^https?:\/\//i.test(filePath) ? 'TELEGRAM_FILE_PATH_URL'
          : filePath.startsWith('/') ? 'TELEGRAM_FILE_PATH_ABSOLUTE'
          : filePath.split('/').some(segment => segment === '.' || segment === '..') ? 'TELEGRAM_FILE_PATH_TRAVERSAL'
          : /^[a-zA-Z0-9_./-]+$/.test(filePath) ? 'TELEGRAM_FILE_PATH_FORMAT'
          : 'TELEGRAM_FILE_PATH_CHARACTERS';
        throw new TelegramApiError('Invalid Telegram file path', { code });
      }
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/file/bot${token}/${filePath}`, {
          signal: AbortSignal.timeout(Math.max(timeoutMs, 30_000)),
          redirect: 'error',
        });
      } catch (cause) {
        throw new TelegramApiError(
          `Telegram file download failed: ${redactBotToken(cause instanceof Error ? cause.message : String(cause), token)}`,
        );
      }
      if (!response.ok) {
        throw new TelegramApiError(`Telegram file download failed: HTTP ${response.status}`, {
          status: response.status,
        });
      }
      const declaredType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      // Telegram file downloads can use a generic binary Content-Type.
      // Validate the downloaded signature before giving Strapi an image MIME.
      if (!PHOTO_TYPES.has(declaredType) && !BINARY_TYPES.has(declaredType)) {
        await response.body?.cancel();
        throw new TelegramApiError('Telegram photo has an unsupported content type', { code: 'TELEGRAM_PHOTO_CONTENT_TYPE', contentType: declaredType });
      }
      if (Number(response.headers.get('content-length')) > TELEGRAM_MAX_PHOTO_BYTES) {
        await response.body?.cancel();
        throw new TelegramApiError('Telegram photo exceeds the size limit');
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (reader) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > TELEGRAM_MAX_PHOTO_BYTES) {
            await reader.cancel();
            throw new TelegramApiError('Telegram photo exceeds the size limit');
          }
          chunks.push(value);
        }
      } catch (cause) {
        throw new TelegramApiError(redactBotToken(cause instanceof Error ? cause.message : String(cause), token));
      } finally {
        reader?.releaseLock();
      }
      const bytes = Buffer.concat(chunks, size);
      const contentType = photoContentType(bytes);
      if (!contentType || (PHOTO_TYPES.has(declaredType) && declaredType !== contentType)) {
        throw new TelegramApiError('Telegram photo has invalid image content', {
          code: contentType ? 'TELEGRAM_PHOTO_TYPE_MISMATCH' : 'TELEGRAM_PHOTO_SIGNATURE_INVALID',
          contentType: declaredType, detectedType: contentType ?? 'unknown',
        });
      }
      return { bytes, contentType };
    },
  };
}
