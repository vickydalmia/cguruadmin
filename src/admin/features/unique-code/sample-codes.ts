// The downloadable SAMPLE CSV for the bulk unique-code import, written to
// demonstrate the parser's real tolerances. parse-codes.test.ts runs
// SAMPLE_CODES_CSV through parseCodesFile and pins the result, so the sample
// can never drift from the parser it documents.

/** File name offered when an editor downloads the sample. */
export const SAMPLE_CODES_FILE_NAME = 'unique-codes-sample.csv';

/**
 * A ready-to-edit CSV an editor can download, fill in, and upload back.
 *
 * It is written to DEMONSTRATE the parser's real tolerances rather than to show
 * a minimal happy path, because every one of these is a question editors
 * actually ask:
 *
 *   - a `code` header row is detected and dropped;
 *   - extra spreadsheet columns after the first are ignored;
 *   - a quoted field is unwrapped, so Excel's quoting is safe;
 *   - blank lines are skipped;
 *   - surrounding whitespace is trimmed.
 *
 * `parse-codes.test.ts` runs this exact string through `parseCodesFile` and
 * pins the result, so the sample can never drift from the parser it documents.
 */
export const SAMPLE_CODES_CSV = [
  'code,notes (this column is ignored)',
  'WELCOME-A1B2C3,first code',
  'WELCOME-D4E5F6,extra columns are optional',
  '"WELCOME-G7H8I9",quoted values are unwrapped',
  '',
  '  WELCOME-J1K2L3  ,surrounding spaces are trimmed',
  'WELCOME-M4N5O6',
  '',
].join('\r\n');

/** The codes SAMPLE_CODES_CSV is expected to yield, in order. */
export const SAMPLE_CODES_EXPECTED = [
  'WELCOME-A1B2C3',
  'WELCOME-D4E5F6',
  'WELCOME-G7H8I9',
  'WELCOME-J1K2L3',
  'WELCOME-M4N5O6',
] as const;
