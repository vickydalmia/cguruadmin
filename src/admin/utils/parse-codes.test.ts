import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHUNK_SIZE,
  MAX_IMPORT_REQUEST_BYTES,
  MAX_CODES_PER_UPLOAD,
  MAX_CODE_LENGTH,
  chunkCodes,
  extractCode,
  importRequestByteLength,
  parseCodesFile,
  reduceImportCompletion,
  summariseImport,
  uploadBlocker,
} from './parse-codes';

describe('extractCode', () => {
  it('returns a plain line untouched', () => {
    expect(extractCode('SAVE20')).toBe('SAVE20');
  });

  it('trims surrounding whitespace', () => {
    expect(extractCode('  SAVE20\t')).toBe('SAVE20');
  });

  it.each([
    ['SAVE20,2026-01-01', 'SAVE20'],
    ['SAVE20;batch-a', 'SAVE20'],
    ['SAVE20\tbatch-a', 'SAVE20'],
    ['SAVE20, 2026-01-01, batch-a', 'SAVE20'],
  ])('takes the first field of %j', (line, expected) => {
    expect(extractCode(line)).toBe(expected);
  });

  it('unwraps a quoted spreadsheet field', () => {
    expect(extractCode('"SAVE20"')).toBe('SAVE20');
    expect(extractCode('"SAVE20",2026-01-01')).toBe('SAVE20');
  });

  it('keeps a comma that was quoted, and unescapes doubled quotes', () => {
    expect(extractCode('"SAVE,20",next')).toBe('SAVE,20');
    expect(extractCode('"SA""VE"')).toBe('SA"VE');
  });

  it('returns empty for a blank line', () => {
    expect(extractCode('')).toBe('');
    expect(extractCode('   ')).toBe('');
  });
});

describe('parseCodesFile', () => {
  it('parses one code per line', () => {
    const parsed = parseCodesFile('SAVE20\nSAVE30\nSAVE40');
    expect(parsed.codes).toEqual(['SAVE20', 'SAVE30', 'SAVE40']);
    expect(parsed.total).toBe(3);
    expect(parsed.duplicates).toBe(0);
    expect(parsed.invalid).toEqual([]);
  });

  it.each([
    ['CRLF', 'SAVE20\r\nSAVE30'],
    ['LF', 'SAVE20\nSAVE30'],
    ['CR', 'SAVE20\rSAVE30'],
  ])('handles %s line endings', (_name, text) => {
    expect(parseCodesFile(text).codes).toEqual(['SAVE20', 'SAVE30']);
  });

  it('ignores blank lines entirely rather than counting them', () => {
    const parsed = parseCodesFile('SAVE20\n\n   \n\nSAVE30\n');
    expect(parsed.codes).toEqual(['SAVE20', 'SAVE30']);
    expect(parsed.total).toBe(2);
  });

  it.each(['code', 'Coupon Code', 'UNIQUE CODES', 'promo code'])(
    'drops the header line %j',
    (header) => {
      const parsed = parseCodesFile(`${header}\nSAVE20`);
      expect(parsed.headerSkipped).toBe(true);
      expect(parsed.codes).toEqual(['SAVE20']);
      expect(parsed.total).toBe(1);
    },
  );

  it('only treats line 1 as a header', () => {
    const parsed = parseCodesFile('SAVE20\ncode');
    expect(parsed.headerSkipped).toBe(false);
    expect(parsed.codes).toEqual(['SAVE20', 'code']);
  });

  it.each([1, 2, 3])(
    'still drops the header after %i leading blank line(s)',
    (blanks) => {
      const parsed = parseCodesFile(`${'\n'.repeat(blanks)}code\nSAVE20\nSAVE30`);
      expect(parsed.headerSkipped).toBe(true);
      expect(parsed.codes).toEqual(['SAVE20', 'SAVE30']);
      expect(parsed.total).toBe(2);
    },
  );

  it('drops a header after a whitespace-only leading line', () => {
    const parsed = parseCodesFile('   \t\ncoupon code\nSAVE20');
    expect(parsed.headerSkipped).toBe(true);
    expect(parsed.codes).toEqual(['SAVE20']);
  });

  it('leaves a headerless file with leading blank lines untouched', () => {
    const parsed = parseCodesFile('\n\nSAVE20\nSAVE30');
    expect(parsed.headerSkipped).toBe(false);
    expect(parsed.codes).toEqual(['SAVE20', 'SAVE30']);
    expect(parsed.total).toBe(2);
  });

  it('does not treat a header label past the first content line as a header', () => {
    const parsed = parseCodesFile('\nSAVE20\ncode');
    expect(parsed.headerSkipped).toBe(false);
    expect(parsed.codes).toEqual(['SAVE20', 'code']);
  });

  it('drops a header from a multi-column CSV', () => {
    const parsed = parseCodesFile('code,expires\nSAVE20,2026-01-01\nSAVE30,2026-02-01');
    expect(parsed.headerSkipped).toBe(true);
    expect(parsed.codes).toEqual(['SAVE20', 'SAVE30']);
  });

  it('counts within-file duplicates as skipped, keeping first-seen order', () => {
    const parsed = parseCodesFile('SAVE20\nSAVE30\nSAVE20\nSAVE20');
    expect(parsed.codes).toEqual(['SAVE20', 'SAVE30']);
    expect(parsed.total).toBe(4);
    expect(parsed.duplicates).toBe(2);
  });

  it('treats codes differing only by case as DIFFERENT codes', () => {
    // Merchant stock routinely contains both; folding case would destroy it.
    const parsed = parseCodesFile('save20\nSAVE20');
    expect(parsed.codes).toEqual(['save20', 'SAVE20']);
    expect(parsed.duplicates).toBe(0);
  });

  it('rejects an over-long code with its line number', () => {
    const long = 'A'.repeat(MAX_CODE_LENGTH + 1);
    const parsed = parseCodesFile(`SAVE20\n${long}`);
    expect(parsed.codes).toEqual(['SAVE20']);
    expect(parsed.invalid).toEqual([
      { line: 2, value: long, reason: 'too-long' },
    ]);
  });

  it('accepts a code exactly at the column limit', () => {
    const exact = 'A'.repeat(MAX_CODE_LENGTH);
    expect(parseCodesFile(exact).codes).toEqual([exact]);
  });

  it('rejects a code carrying control characters', () => {
    const parsed = parseCodesFile('SAVE20\nSAVE\u000030');
    expect(parsed.codes).toEqual(['SAVE20']);
    expect(parsed.invalid[0]).toMatchObject({
      line: 2,
      reason: 'control-characters',
    });
  });

  it('returns an empty result for an empty file', () => {
    expect(parseCodesFile('')).toEqual({
      codes: [],
      total: 0,
      duplicates: 0,
      invalid: [],
      headerSkipped: false,
    });
  });

  it('reports every dropped code so counts reconcile', () => {
    const parsed = parseCodesFile(
      ['code', 'SAVE20', 'SAVE20', 'A'.repeat(300), 'SAVE30'].join('\n'),
    );
    expect(parsed.total).toBe(4);
    expect(parsed.codes.length + parsed.duplicates + parsed.invalid.length).toBe(
      parsed.total,
    );
  });
});

describe('chunkCodes', () => {
  it('returns no chunks for an empty list, so nothing is posted', () => {
    expect(chunkCodes([])).toEqual([]);
  });

  it('keeps a small list in one chunk', () => {
    expect(chunkCodes(['a', 'b'], 10)).toEqual([['a', 'b']]);
  });

  it('splits on the boundary without dropping or repeating codes', () => {
    expect(chunkCodes(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  it('splits a 20k-code import into request-sized batches', () => {
    const codes = Array.from({ length: 20_000 }, (_, i) => `CODE-${i}`);
    const chunks = chunkCodes(codes);

    expect(chunks).toHaveLength(20_000 / DEFAULT_CHUNK_SIZE);
    expect(chunks.flat()).toEqual(codes);
    expect(Math.max(...chunks.map((c) => c.length))).toBe(DEFAULT_CHUNK_SIZE);
  });

  it('keeps the worst-case chunk under the 1 MB koa jsonLimit', () => {
    const codes = Array.from({ length: DEFAULT_CHUNK_SIZE }, () =>
      'A'.repeat(MAX_CODE_LENGTH),
    );
    const poolDocumentId = 'x'.repeat(32);
    const chunks = chunkCodes(codes, DEFAULT_CHUNK_SIZE, { poolDocumentId });

    expect(chunks).toHaveLength(1);
    expect(importRequestByteLength(poolDocumentId, chunks[0])).toBeLessThan(
      MAX_IMPORT_REQUEST_BYTES,
    );
  });

  it('splits multibyte codes by serialized UTF-8 bytes before Koa rejects them', () => {
    const poolDocumentId = 'x'.repeat(32);
    const codes = Array.from(
      { length: DEFAULT_CHUNK_SIZE },
      (_, index) =>
        `${'क'.repeat(MAX_CODE_LENGTH - 4)}${String(index).padStart(4, '0')}`,
    );

    expect(importRequestByteLength(poolDocumentId, codes)).toBeGreaterThan(
      1_000_000,
    );

    const chunks = chunkCodes(codes, DEFAULT_CHUNK_SIZE, { poolDocumentId });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(codes);
    for (const chunk of chunks) {
      expect(importRequestByteLength(poolDocumentId, chunk)).toBeLessThanOrEqual(
        MAX_IMPORT_REQUEST_BYTES,
      );
    }
  });

  it.each([0, -5, 0.4])('coerces a nonsense chunk size %j to at least 1', (size) => {
    expect(chunkCodes(['a', 'b'], size)).toEqual([['a'], ['b']]);
  });
});

describe('summariseImport', () => {
  const parsed = parseCodesFile('SAVE20\nSAVE20\nSAVE30\nSAVE40');

  it('sums the imported counts the server reported', () => {
    expect(
      summariseImport(parsed, [
        { count: 2, imported: 2 },
        { count: 1, imported: 1 },
      ]),
    ).toEqual({ imported: 3, skipped: 1, failed: 0, errors: [] });
  });

  it('includes rows the server skipped because they already exist', () => {
    expect(
      summariseImport(parsed, [
        { count: 2, imported: 1, skipped: 1 },
        { count: 1, imported: 0, skipped: 1 },
      ]),
    ).toEqual({ imported: 1, skipped: 3, failed: 0, errors: [] });
  });

  it('counts a failed chunk as failed, not imported', () => {
    expect(
      summariseImport(parsed, [
        { count: 2, imported: 2 },
        { count: 1, error: 'HTTP 500' },
      ]),
    ).toEqual({
      imported: 2,
      skipped: 1,
      failed: 1,
      errors: ['HTTP 500'],
    });
  });

  it('reports skipped from the parse even when nothing was uploaded', () => {
    expect(summariseImport(parsed, []).skipped).toBe(1);
  });

  it('treats a chunk that reported no count as importing nothing', () => {
    expect(summariseImport(parsed, [{ count: 5 }]).imported).toBe(0);
  });
});

describe('reduceImportCompletion', () => {
  const parsed = parseCodesFile('SAVE20\nSAVE30\nSAVE40');

  it('clears parsed file state after every chunk succeeds', () => {
    expect(
      reduceImportCompletion(parsed, 'codes.csv', [
        {
          count: 3,
          codes: ['SAVE20', 'SAVE30', 'SAVE40'],
          imported: 3,
          skipped: 0,
        },
      ]),
    ).toMatchObject({
      parsed: null,
      fileName: null,
      summary: { imported: 3, skipped: 0, failed: 0 },
    });
  });

  it('retains exactly failed batches for retry without resubmitting successes', () => {
    const completion = reduceImportCompletion(parsed, 'codes.csv', [
      {
        count: 2,
        codes: ['SAVE20', 'SAVE30'],
        imported: 1,
        skipped: 1,
      },
      {
        count: 1,
        codes: ['SAVE40'],
        error: 'HTTP 500',
      },
    ]);

    expect(completion.parsed).toEqual({
      codes: ['SAVE40'],
      total: 1,
      duplicates: 0,
      invalid: [],
      headerSkipped: false,
    });
    expect(completion.fileName).toBe('codes.csv');
    expect(completion.summary).toEqual({
      imported: 1,
      skipped: 1,
      failed: 1,
      errors: ['HTTP 500'],
    });
  });
});

describe('uploadBlocker', () => {
  it('blocks a file with no usable codes', () => {
    expect(uploadBlocker(parseCodesFile('code\n\n  \n'))).toBe(
      'No usable codes found in this file.',
    );
  });

  it('allows a normal file', () => {
    expect(uploadBlocker(parseCodesFile('SAVE20'))).toBeNull();
  });

  it('blocks a file past the per-file ceiling before any request is sent', () => {
    const parsed = {
      ...parseCodesFile('SAVE20'),
      codes: Array.from({ length: MAX_CODES_PER_UPLOAD + 1 }, (_, i) => `C${i}`),
    };
    expect(uploadBlocker(parsed)).toContain('at most');
  });
});
