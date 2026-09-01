// Validation of the storefront's deployment catalogue-sync body
// (POST /api/ui-dictionary/catalogue). Pure; the controller maps a failure
// to a 400 with the problem list.
import { z } from 'zod';
import {
  isPluralCategory,
  MAX_BODY_BYTES,
  MAX_CATALOGUE_KEYS,
  MAX_DESCRIPTION_LENGTH,
  MAX_KEY_LENGTH,
  MAX_TEXT_LENGTH,
  UI_DICTIONARY_KEY_PATTERN,
} from './constants';
import type { CatalogueSyncInput } from './types';

const keySchema = z
  .string()
  .max(MAX_KEY_LENGTH)
  .regex(
    UI_DICTIONARY_KEY_PATTERN,
    'key must be dotted lower-camel segments, e.g. offers.showDetails',
  );

const entrySchema = z.object({
  text: z
    .string()
    .min(1)
    .max(MAX_TEXT_LENGTH)
    .refine((value) => value.trim().length > 0, 'text must not be blank'),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  maxLength: z.number().int().positive().optional(),
  pluralOf: keySchema.optional(),
});

export const catalogueBodySchema = z
  .object({
    version: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'version must be a lowercase sha256 hex digest'),
    entries: z.record(keySchema, entrySchema),
  })
  .superRefine((body, context) => {
    const keys = Object.keys(body.entries);
    if (keys.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries'],
        message: 'entries must not be empty',
      });
    }
    if (keys.length > MAX_CATALOGUE_KEYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entries'],
        message: `entries must not exceed ${MAX_CATALOGUE_KEYS} keys`,
      });
    }
    for (const key of keys) {
      const pluralOf = body.entries[key].pluralOf;
      if (pluralOf === undefined) continue;
      const prefix = `${pluralOf}.`;
      const category = key.startsWith(prefix) ? key.slice(prefix.length) : '';
      if (!category || !isPluralCategory(category)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', key, 'pluralOf'],
          message:
            'a plural form key must be `<pluralOf>.<category>` with a CLDR category',
        });
        continue;
      }
      if (body.entries[`${pluralOf}.other`] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', key, 'pluralOf'],
          message: `plural base ${pluralOf} must push its \`other\` form`,
        });
      }
    }
  });

export type CatalogueProblem = { path: string; message: string };

export type CatalogueParseResult =
  | { ok: true; value: CatalogueSyncInput }
  | { ok: false; problems: CatalogueProblem[] };

const MAX_REPORTED_PROBLEMS = 50;

export function parseCatalogueBody(body: unknown): CatalogueParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, problems: [{ path: '', message: 'body must be an object' }] };
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
    return {
      ok: false,
      problems: [{ path: '', message: `body must not exceed ${MAX_BODY_BYTES} bytes` }],
    };
  }
  const result = catalogueBodySchema.safeParse(body);
  if (result.success) {
    // The repo compiles with strict:false, under which zod's inferred output
    // marks every property optional; the schema itself guarantees the shape.
    return { ok: true, value: result.data as CatalogueSyncInput };
  }
  return {
    ok: false,
    problems: result.error.issues.slice(0, MAX_REPORTED_PROBLEMS).map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}
