// Request CHUNKING for the bulk unique-code import: split parsed codes into
// HTTP-request-sized batches bounded by item count and serialized UTF-8
// bytes. File parsing lives in ./parse-codes-file.
import { utf8ByteLength } from './parse-codes-file';

/**
 * Codes per HTTP request.
 *
 * Sized against Strapi's koa body parser, whose `jsonLimit` defaults to 1 MB.
 * A 20,000-code file posted in one request would be roughly 20,000 x (code +
 * quotes + comma) — comfortably over that for anything but the shortest codes,
 * and the request would be rejected wholesale with a 413. This remains the
 * maximum item count, while chunkCodes also measures the serialized request's
 * UTF-8 bytes because one JavaScript character can occupy several bytes.
 *
 * The plugin controller enforces this same figure as its per-request maximum
 * (MAX_CODES_PER_REQUEST) — a bigger chunk would be rejected with a 400.
 */
export const DEFAULT_CHUNK_SIZE = 2_000;

/**
 * Hard body budget for one import request. Koa defaults to a 1 MB JSON limit;
 * 900 KB leaves headroom below both decimal and binary interpretations while
 * still fitting roughly 1,100 maximum-length three-byte codes per request.
 */
export const MAX_IMPORT_REQUEST_BYTES = 900_000;

/**
 * Exact UTF-8 byte size of the JSON body the admin client sends. Exported so
 * tests and future callers can pin the same transport contract as chunkCodes.
 */
export function importRequestByteLength(
  poolDocumentId: string,
  codes: readonly string[],
): number {
  return utf8ByteLength(JSON.stringify({ poolDocumentId, codes }));
}

export type ChunkCodesOptions = {
  poolDocumentId?: string;
  maxRequestBytes?: number;
};

/**
 * Split the upload into request-sized batches, bounded by both item count and
 * the serialized JSON body's UTF-8 byte size. Returns an empty array for an
 * empty input, so the caller never posts the empty payload the controller
 * rejects with a 400.
 */
export function chunkCodes(
  codes: readonly string[],
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  options: ChunkCodesOptions = {},
): string[][] {
  const size = Math.max(1, Math.floor(chunkSize));
  const poolDocumentId = options.poolDocumentId ?? '';
  const emptyRequestBytes = importRequestByteLength(poolDocumentId, []);
  const configuredBudget =
    options.maxRequestBytes ?? MAX_IMPORT_REQUEST_BYTES;
  const maxRequestBytes = Number.isFinite(configuredBudget)
    ? Math.max(1, Math.floor(configuredBudget))
    : MAX_IMPORT_REQUEST_BYTES;
  if (emptyRequestBytes >= maxRequestBytes) {
    throw new RangeError(
      'Import request metadata exceeds the configured byte limit.',
    );
  }
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = emptyRequestBytes;

  for (const code of codes) {
    const serializedCodeBytes = utf8ByteLength(JSON.stringify(code));
    const nextEntryBytes = serializedCodeBytes + (current.length > 0 ? 1 : 0);

    if (
      current.length > 0 &&
      (current.length >= size ||
        currentBytes + nextEntryBytes > maxRequestBytes)
    ) {
      chunks.push(current);
      current = [];
      currentBytes = emptyRequestBytes;
    }

    const entryBytes = serializedCodeBytes + (current.length > 0 ? 1 : 0);
    if (currentBytes + entryBytes > maxRequestBytes) {
      throw new RangeError(
        'A single code exceeds the configured import request byte limit.',
      );
    }
    current.push(code);
    currentBytes += entryBytes;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
