/**
 * Server-side content validation for resume uploads
 * (src/api/job-application/controllers/submit.ts).
 *
 * WHY THIS EXISTS
 * ---------------
 * The submit controller stores resumes through the upload plugin's SERVICE
 * (`strapi.plugin('upload').service('upload').upload(...)`), which bypasses
 * the plugin's MIME gate: `config/plugins.ts` `security.allowedTypes` is
 * enforced only by the plugin's CONTROLLERS (prepareUploadRequest). The
 * declared Content-Type of a multipart part is attacker-controlled, so a
 * check on `file.type` alone lets an anonymous caller put arbitrary bytes in
 * the public bucket under an innocent name.
 *
 * The verdict here is therefore made from the file's MAGIC BYTES, using the
 * same `file-type` library (21.3.4, hoisted from @strapi/upload's own
 * dependency) and the same first-4100-bytes window as the plugin's
 * utils/mime-validation.
 *
 * ACCEPT POLICY: PDF and positively-verified DOCX only. Everything else is
 * rejected — see RESUME_MIME_TYPES for why the legacy formats were dropped.
 *
 * WHAT file-type 21.3.4 REPORTS (verified against the installed version)
 * ----------------------------------------------------------------------
 * - PDF  -> 'application/pdf'  (accepted when declared PDF)
 * - DOCX -> 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
 *           (it inspects the zip's entries; works even on the first 4100
 *           bytes of a typical docx because [Content_Types].xml leads) —
 *           accepted when declared docx + named .docx
 * - bare ZIP whose docx markers are not visible -> 'application/zip' — REJECTED
 *   (this was the "any zip as docx" hole)
 * - legacy .doc (OLE2/Compound File) -> 'application/x-cfb' — REJECTED
 * - RTF saved under a .doc name -> 'application/rtf' — REJECTED
 * - plain-text / corrupt body with no known signature -> undefined — REJECTED
 *   (this was the "arbitrary bytes as .doc" hole)
 */

import { open } from 'node:fs/promises';

export const PDF_MIME = 'application/pdf';
export const DOC_MIME = 'application/msword';
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** file-type's MIME for RTF content in the installed version (verified 21.3.4). */
export const RTF_MIME = 'application/rtf';

/**
 * Declared types the endpoint accepts; content must then corroborate.
 *
 * PDF and DOCX only. Legacy `.doc` (OLE2/CFB), RTF and plain-text-as-.doc were
 * accepted previously to rescue decade-old resumes, but each rested on
 * attacker-controlled metadata (a declared MIME + a filename extension) and let
 * an anonymous caller store arbitrary ≤5 MB bytes in the public bucket. On a
 * public, unauthenticated job-application endpoint that trade is not worth it,
 * so acceptance is now narrowed to formats a content signature can POSITIVELY
 * confirm: PDF magic bytes, and a DOCX whose zip entries file-type identifies.
 */
export const RESUME_MIME_TYPES = new Set([PDF_MIME, DOCX_MIME]);

/**
 * Hard cap for a resume. The multipart layer has no per-file limit of its own
 * at this endpoint, so this module is the enforcement point (the koa formLimit
 * defaults govern urlencoded/json bodies, not multipart file size).
 */
export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

/**
 * How many leading bytes the verdict needs. Mirrors @strapi/upload's
 * utils/mime-validation, which feeds file-type the first 4100 bytes.
 */
export const RESUME_SNIFF_BYTES = 4100;

export type ResumeRejectionReason =
  /** `size` exceeds MAX_RESUME_BYTES. */
  | 'too-large'
  /** The client-declared Content-Type is not a resume type at all. */
  | 'declared-type-not-allowed'
  /** file-type recognised the bytes as something that is never a resume. */
  | 'content-mismatch'
  /** file-type recognised nothing (plain text, empty, corrupt). */
  | 'unrecognized-content';

export type ResumeValidationResult =
  | { ok: true }
  | { ok: false; reason: ResumeRejectionReason };

const reject = (reason: ResumeRejectionReason): ResumeValidationResult => ({
  ok: false,
  reason,
});

const hasExtension = (filename: string, extension: string): boolean =>
  filename.toLowerCase().endsWith(extension);

/**
 * Decide whether an uploaded file may be stored as a resume.
 *
 * Pure over its inputs: `firstBytes` in, verdict out — no filesystem access —
 * so the whole decision table is unit-testable with crafted buffers.
 */
export async function validateResumeUpload({
  firstBytes,
  declaredMime,
  filename,
  size,
}: {
  /** The file's leading bytes; RESUME_SNIFF_BYTES is enough. */
  firstBytes: Uint8Array;
  /** Client-declared Content-Type — untrusted, used only for consistency. */
  declaredMime: string;
  /** Original filename — untrusted, used only for extension consistency. */
  filename: string;
  /** Total file size in bytes. */
  size: number;
}): Promise<ResumeValidationResult> {
  if (size > MAX_RESUME_BYTES) return reject('too-large');
  if (!RESUME_MIME_TYPES.has(declaredMime)) {
    return reject('declared-type-not-allowed');
  }

  // Dynamic import because file-type is ESM-only; this is exactly how
  // @strapi/upload's own mime-validation loads it. (tsc lowers this to a
  // require() under CommonJS, which Node's require(esm) support handles on
  // the Node versions this project runs — verified on the installed runtime.)
  const { fileTypeFromBuffer } = await import('file-type');
  const detected = (await fileTypeFromBuffer(firstBytes))?.mime;

  switch (detected) {
    case PDF_MIME:
      return declaredMime === PDF_MIME ? { ok: true } : reject('content-mismatch');

    case DOCX_MIME:
      // file-type positively identified a real docx by inspecting the zip's
      // entries (the OOXML markers). Require the declaration AND the extension
      // to agree so a docx-detected file arriving under a mismatched envelope
      // is still refused.
      return declaredMime === DOCX_MIME && hasExtension(filename, '.docx')
        ? { ok: true }
        : reject('content-mismatch');

    case 'application/zip':
      // A bare zip whose OOXML markers were NOT positively identified. This used
      // to be accepted as a docx fallback whenever the declaration + extension
      // said docx — which let ANY zip through under an attacker-set docx
      // envelope. Rejected now: only a positively-detected DOCX (the case above)
      // is a resume. The sole false negative is a genuine docx with unusual
      // entry ordering that hides its markers from the sniff window — rare, and
      // re-saving from Word/LibreOffice fixes it.
      return reject('content-mismatch');

    case undefined:
      // No signature at all: plain text, empty, or corrupt. Never a PDF or a
      // real DOCX — rejected. (This is the arbitrary-bytes hole that legacy
      // `.doc` acceptance opened; it is now closed.)
      return reject('unrecognized-content');

    default:
      // Any OTHER recognised format — legacy binary .doc (x-cfb), RTF, images,
      // executables, html-in-zip, … — is not an accepted resume type.
      return reject('content-mismatch');
  }
}

/**
 * Read the leading RESUME_SNIFF_BYTES of a temp-uploaded file. IO companion to
 * validateResumeUpload; kept separate so the decision itself stays pure.
 */
export async function readFirstBytes(
  filePath: string,
  byteCount: number = RESUME_SNIFF_BYTES,
): Promise<Uint8Array> {
  const file = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await file.read(buffer, 0, byteCount, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
