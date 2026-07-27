import { errors } from '@strapi/utils';

/**
 * The shared vocabulary for editor-facing write validation.
 *
 * WHY THIS EXISTS. Every validator in src/utils already accumulates ALL of its
 * own problems and throws them in one go, in an identical shape. What it could
 * not do is see the other eleven validators' problems, because the document
 * middleware awaited them in sequence and the first throw aborted the request.
 * An entry with a bad slug (changed-field-validation) and a blank required
 * field (text-field-validation) reported only the slug on the first save, only
 * the blank field on the second — the whack-a-mole an editor experiences.
 *
 * ProblemCollector fixes that at the middleware level, not the rule level: it
 * runs each validator, harvests its ValidationError instead of letting it
 * escape, and throws ONCE with the union. No rule, message or path changes.
 */

/**
 * One editor-facing defect, addressed at a form path.
 *
 * `path` is the array the admin edit view maps onto an inline field error —
 * `['slug']`, `['seo', 'metaTitle']`, or with indices for repeatables,
 * `['newlyAdded', 'items', 1, 'cardImage']`.
 */
export type Problem = { path: (string | number)[]; message: string };

/** Shape of a single entry inside a ValidationError's `details.errors`. */
type DetailError = {
  path: (string | number)[];
  message: string;
  name: string;
};

const isValidationError = (error: unknown): error is errors.ValidationError =>
  error instanceof errors.ValidationError;

/** `['seo','metaTitle']` -> `'seo.metaTitle'`, the form of every summary line. */
const describe = (problem: Problem): string =>
  problem.path.length
    ? `${problem.path.join('.')}: ${problem.message}`
    : problem.message;

/**
 * The canonical editor-facing throw, kept byte-identical to the block that was
 * copy-pasted across nine validators (the original lives in
 * text-field-validation.ts's `throwProblems`). A one-problem list produces
 * exactly the message those validators produced before, so no consumer —
 * admin, REST client or test — can tell the difference.
 *
 * `details.errors[].path` is what the admin turns into an inline red field
 * error and what opens the offending repeatable row; `details.problems` is the
 * flat string form kept for non-admin API consumers.
 */
export function toValidationError(
  problems: readonly Problem[],
): errors.ValidationError {
  const noun = problems.length === 1 ? 'problem' : 'problems';
  return new errors.ValidationError(
    `This entry has ${problems.length} ${noun} (the fields are highlighted ` +
      `in the form):\n• ${problems.map(describe).join('\n• ')}`,
    {
      errors: problems.map((problem) => ({
        path: problem.path,
        message: problem.message,
        name: 'ValidationError',
      })),
      problems: problems.map(describe),
    },
  );
}

/**
 * Read the problems back out of a thrown ValidationError.
 *
 * Validators are the only producers, and they all populate `details.errors`.
 * The fallback exists so a ValidationError raised from somewhere else — Strapi
 * core, a future validator, a plugin — still contributes its message rather
 * than being dropped on the floor. A path-less problem renders as a bare
 * sentence in the summary and simply highlights no field.
 */
function problemsFrom(error: errors.ValidationError): Problem[] {
  const details = (error as { details?: { errors?: unknown } }).details;
  const entries = details?.errors;

  if (!Array.isArray(entries) || entries.length === 0) {
    return [{ path: [], message: error.message }];
  }

  return entries.map((entry) => {
    const detail = entry as Partial<DetailError>;
    return {
      path: Array.isArray(detail.path) ? detail.path : [],
      message:
        typeof detail.message === 'string' ? detail.message : error.message,
    };
  });
}

/**
 * Runs validators and merges everything they find into one throw.
 *
 * NOT a general-purpose error swallower. Only `errors.ValidationError` is
 * harvested — an editor-facing "you must fix this" verdict. Anything else (a
 * TypeError from a genuine bug, a database failure) propagates untouched, so it
 * still surfaces as the 500 it always was rather than being quietly reported as
 * a field problem.
 */
export class ProblemCollector {
  private readonly collected: Problem[] = [];

  private uniqueProblems(): Problem[] {
    const seen = new Set<string>();
    return this.collected.filter((problem) => {
      const key = `${problem.path.join('.')}|${problem.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Run one validator. Returns normally whether or not it found problems, so
   * the caller can keep going down the list.
   */
  async run(step: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await step();
    } catch (error) {
      if (!isValidationError(error)) throw error;
      this.collected.push(...problemsFrom(error));
    }
  }

  get problems(): readonly Problem[] {
    return this.uniqueProblems();
  }

  get length(): number {
    return this.uniqueProblems().length;
  }

  /**
   * Throw everything collected so far as a single ValidationError, or return
   * quietly if nothing was found.
   *
   * De-duplicated on path + message: two validators can legitimately flag the
   * same field (a blank SEO title is both "required" to one rule table and
   * "too short" to another), and listing it twice reads as a bug.
   */
  throwIfAny(): void {
    if (this.collected.length === 0) return;

    throw toValidationError(this.uniqueProblems());
  }
}
