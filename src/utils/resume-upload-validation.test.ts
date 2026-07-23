import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DOCX_MIME,
  DOC_MIME,
  MAX_RESUME_BYTES,
  PDF_MIME,
  RESUME_SNIFF_BYTES,
  readFirstBytes,
  validateResumeUpload,
} from './resume-upload-validation';

/** Real magic bytes, padded so file-type has enough context to classify. */
const bytes = (magic: number[] | string, padding = 512): Uint8Array => {
  const head =
    typeof magic === 'string' ? Buffer.from(magic, 'latin1') : Buffer.from(magic);
  return Buffer.concat([head, Buffer.alloc(padding)]);
};

// A genuine minimal .docx (real OOXML zip: [Content_Types].xml, _rels/.rels,
// word/document.xml). file-type 21.3.4 only reports the docx MIME for a
// properly-formed OOXML archive — a hand-built or bare zip reports
// 'application/zip' — so the positive-DOCX accept path is exercised with real
// docx bytes, exactly what the endpoint must accept.
const REAL_DOCX_BASE64 =
  'UEsDBBQAAAAIAGa691yWsN0u5AAAAHUBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbJWQvVLDMAzHX8WnlUscGDiOS9KBjxEYygPo' +
  'bCXx1ZZ9llvat8dpoQMbo/3/+EnqN8fg1YGyuMgD3LYdKGITreN5gM/ta/MASgqyRR+ZBjiRwGbst6dEomqWZYCllPSotZiFAkob' +
  'E3FVppgDlvrMs05odjiTvuu6e20iF+LSlLUDxv6ZJtz7ol6O9fsyRyYvoJ4uxpU1AKbkncFSdX1g+4fS/BDamjx7ZHFJbqoB9Ni/' +
  '1wWzs6Q+MJc3DLVOf8VstY1mHyqiXY3/4sVpcoau+bUt5WhIpF4u+PaqBHT8O4c+n238BlBLAwQKAAAAAABmuvdcAAAAAAAAAAAA' +
  'AAAABgAAAF9yZWxzL1BLAwQUAAAACABmuvdcm/036q0AAAApAQAACwAAAF9yZWxzLy5yZWxzjc87DsIwDAbgq0TeaVoGhFDTLgip' +
  'KyoHsBI3rWgeSsKjtycDA0UMjLZ/f5br9mlmdqcQJ2cFVEUJjKx0arJawKU/bfbAYkKrcHaWBCwUoW3qM82Y8kocJx9ZNmwUMKbk' +
  'D5xHOZLBWDhPNk8GFwymXAbNPcorauLbstzx8GnA2mSdEhA6VQHrF0//2G4YJklHJ2+GbPpx4iuRZQyakoCHC4qrd7vILPCm5qsX' +
  'mxdQSwMECgAAAAAAZrr3XAAAAAAAAAAAAAAAAAUAAAB3b3JkL1BLAwQUAAAACABmuvdcnfORF5cAAADLAAAAEQAAAHdvcmQvZG9j' +
  'dW1lbnQueG1sRY5BDsIgEEWvQmZvqS6MaUq78wR6AARsScoMYdDa2wt14eb9/Mzk5ffjJyzi7RJ7QgXHpgXh0JD1OCm4366HCwjO' +
  'Gq1eCJ2CzTGMQ792lswrOMyiCJC7VcGcc+ykZDO7oLmh6LDcnpSCzqWmSa6UbExkHHPxh0We2vYsg/YIVfkgu9WMFakiD7PvZc3K' +
  'tDPu/P3K/47hC1BLAQIeAxQAAAAIAGa691yWsN0u5AAAAHUBAAATAAAAAAAAAAEAAACkgQAAAABbQ29udGVudF9UeXBlc10ueG1s' +
  'UEsBAh4DCgAAAAAAZrr3XAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAQAO1BFQEAAF9yZWxzL1BLAQIeAxQAAAAIAGa691yb/TfqrQAA' +
  'ACkBAAALAAAAAAAAAAEAAACkgTkBAABfcmVscy8ucmVsc1BLAQIeAwoAAAAAAGa691wAAAAAAAAAAAAAAAAFAAAAAAAAAAAAEADt' +
  'QQ8CAAB3b3JkL1BLAQIeAxQAAAAIAGa691yd85EXlwAAAMsAAAARAAAAAAAAAAEAAACkgTICAAB3b3JkL2RvY3VtZW50LnhtbFBL' +
  'BQYAAAAABQAFACABAAD4AgAAAAA=';

const PDF_BYTES = bytes('%PDF-1.7\n');
// A bare zip with no OOXML markers — file-type reports 'application/zip'.
const ZIP_BYTES = bytes('PK\x03\x04');
// A genuine docx (see REAL_DOCX_BASE64).
const DOCX_BYTES = new Uint8Array(Buffer.from(REAL_DOCX_BASE64, 'base64'));
const CFB_BYTES = bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const EXE_BYTES = bytes('MZ');
const RTF_BYTES = bytes('{\\rtf1\\ansi\\deff0 hello resume}');
const TEXT_BYTES = bytes('just a plain text resume, promise');

describe('validateResumeUpload', () => {
  type Case = {
    name: string;
    firstBytes: Uint8Array;
    declaredMime: string;
    filename: string;
    size?: number;
    expected: { ok: true } | { ok: false; reason: string };
  };

  const cases: Case[] = [
    // ── Accepted: PDF and positively-verified DOCX only ──────────────────────
    {
      name: 'accepts a genuine PDF declared as PDF',
      firstBytes: PDF_BYTES,
      declaredMime: PDF_MIME,
      filename: 'resume.pdf',
      expected: { ok: true },
    },
    {
      name: 'accepts a real docx (word/ entry) declared docx and named .docx',
      firstBytes: DOCX_BYTES,
      declaredMime: DOCX_MIME,
      filename: 'resume.docx',
      expected: { ok: true },
    },
    {
      name: 'docx extension check is case-insensitive',
      firstBytes: DOCX_BYTES,
      declaredMime: DOCX_MIME,
      filename: 'RESUME.DOCX',
      expected: { ok: true },
    },
    {
      name: 'accepts a file exactly at the size cap',
      firstBytes: PDF_BYTES,
      declaredMime: PDF_MIME,
      filename: 'resume.pdf',
      size: MAX_RESUME_BYTES,
      expected: { ok: true },
    },

    // ── The #5 holes, now closed ─────────────────────────────────────────────
    {
      // Previously accepted via the docx fallback — the "any zip as docx" hole.
      name: 'rejects a bare zip declared docx and named .docx (no OOXML markers)',
      firstBytes: ZIP_BYTES,
      declaredMime: DOCX_MIME,
      filename: 'resume.docx',
      expected: { ok: false, reason: 'content-mismatch' },
    },
    {
      // Previously accepted as a legacy plain-text .doc — the arbitrary-bytes
      // hole. .doc is no longer a declarable type, so it stops at the allow list.
      name: 'rejects plain text declared as legacy .doc',
      firstBytes: TEXT_BYTES,
      declaredMime: DOC_MIME,
      filename: 'resume.doc',
      expected: { ok: false, reason: 'declared-type-not-allowed' },
    },
    {
      name: 'rejects an RTF body declared as legacy .doc',
      firstBytes: RTF_BYTES,
      declaredMime: DOC_MIME,
      filename: 'resume.doc',
      expected: { ok: false, reason: 'declared-type-not-allowed' },
    },
    {
      name: 'rejects legacy CFB .doc content declared as .doc',
      firstBytes: CFB_BYTES,
      declaredMime: DOC_MIME,
      filename: 'resume.doc',
      expected: { ok: false, reason: 'declared-type-not-allowed' },
    },

    // ── Content / declaration disagreements ──────────────────────────────────
    {
      name: 'rejects a real docx declared as PDF',
      firstBytes: DOCX_BYTES,
      declaredMime: PDF_MIME,
      filename: 'resume.pdf',
      expected: { ok: false, reason: 'content-mismatch' },
    },
    {
      name: 'rejects a real docx named .doc (extension disagrees)',
      firstBytes: DOCX_BYTES,
      declaredMime: DOCX_MIME,
      filename: 'resume.doc',
      expected: { ok: false, reason: 'content-mismatch' },
    },
    {
      name: 'rejects an RTF body declared as docx',
      firstBytes: RTF_BYTES,
      declaredMime: DOCX_MIME,
      filename: 'resume.docx',
      expected: { ok: false, reason: 'content-mismatch' },
    },
    {
      name: 'rejects CFB content declared as docx',
      firstBytes: CFB_BYTES,
      declaredMime: DOCX_MIME,
      filename: 'resume.docx',
      expected: { ok: false, reason: 'content-mismatch' },
    },
    {
      name: 'rejects an exe wearing a .pdf name and PDF declaration',
      firstBytes: EXE_BYTES,
      declaredMime: PDF_MIME,
      filename: 'resume.pdf',
      expected: { ok: false, reason: 'content-mismatch' },
    },
    {
      name: 'rejects a PDF body declared as docx',
      firstBytes: PDF_BYTES,
      declaredMime: DOCX_MIME,
      filename: 'resume.docx',
      expected: { ok: false, reason: 'content-mismatch' },
    },
    {
      name: 'rejects a bare zip declared as PDF',
      firstBytes: ZIP_BYTES,
      declaredMime: PDF_MIME,
      filename: 'resume.pdf',
      expected: { ok: false, reason: 'content-mismatch' },
    },

    // ── Unrecognised content ─────────────────────────────────────────────────
    {
      name: 'rejects plain text with no signature declared as PDF',
      firstBytes: TEXT_BYTES,
      declaredMime: PDF_MIME,
      filename: 'resume.pdf',
      expected: { ok: false, reason: 'unrecognized-content' },
    },
    {
      name: 'rejects an empty file',
      firstBytes: new Uint8Array(0),
      declaredMime: PDF_MIME,
      filename: 'resume.pdf',
      expected: { ok: false, reason: 'unrecognized-content' },
    },

    // ── Size + declared-type gates ───────────────────────────────────────────
    {
      name: 'rejects an oversize file before sniffing content',
      firstBytes: PDF_BYTES,
      declaredMime: PDF_MIME,
      filename: 'resume.pdf',
      size: MAX_RESUME_BYTES + 1,
      expected: { ok: false, reason: 'too-large' },
    },
    {
      name: 'size cap is checked before the declared-type gate',
      firstBytes: TEXT_BYTES,
      declaredMime: DOC_MIME,
      filename: 'resume.doc',
      size: MAX_RESUME_BYTES + 1,
      expected: { ok: false, reason: 'too-large' },
    },
    {
      name: 'rejects a declared type outside the resume allow list',
      firstBytes: PDF_BYTES,
      declaredMime: 'text/html',
      filename: 'resume.pdf',
      expected: { ok: false, reason: 'declared-type-not-allowed' },
    },
    {
      name: 'rejects an empty declared type',
      firstBytes: PDF_BYTES,
      declaredMime: '',
      filename: 'resume.pdf',
      expected: { ok: false, reason: 'declared-type-not-allowed' },
    },
  ];

  it.each(cases)('$name', async ({ firstBytes, declaredMime, filename, size, expected }) => {
    const result = await validateResumeUpload({
      firstBytes,
      declaredMime,
      filename,
      size: size ?? firstBytes.length,
    });
    expect(result).toEqual(expected);
  });
});

describe('readFirstBytes', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'resume-validation-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns the whole file when it is smaller than the sniff window', async () => {
    const path = join(dir, 'small.pdf');
    await writeFile(path, Buffer.from('%PDF-1.7 tiny'));
    const read = await readFirstBytes(path);
    expect(Buffer.from(read).toString()).toBe('%PDF-1.7 tiny');
  });

  it('caps a large file at the sniff window', async () => {
    const path = join(dir, 'large.bin');
    await writeFile(path, Buffer.alloc(RESUME_SNIFF_BYTES * 2, 0x41));
    const read = await readFirstBytes(path);
    expect(read.length).toBe(RESUME_SNIFF_BYTES);
  });

  it('feeds enough of a real-shaped PDF for validation to pass end-to-end', async () => {
    const path = join(dir, 'resume.pdf');
    await writeFile(path, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64)]));
    const result = await validateResumeUpload({
      firstBytes: await readFirstBytes(path),
      declaredMime: PDF_MIME,
      filename: 'resume.pdf',
      size: 73,
    });
    expect(result).toEqual({ ok: true });
  });
});
