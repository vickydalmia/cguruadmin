import { describe, expect, it } from 'vitest';
import { errors } from '@strapi/utils';
import { ProblemCollector, toValidationError, type Problem } from './problems';

const validationError = (problems: Problem[]) => toValidationError(problems);

const details = (error: unknown) =>
  (error as { details: { errors: Problem[]; problems: string[] } }).details;

describe('toValidationError', () => {
  it('reproduces the single-problem message the validators threw before', () => {
    // Byte-identical to text-field-validation.ts's throwProblems, which is the
    // block this function replaces. If this ever drifts, editors see a
    // different toast for an unchanged rule.
    const error = toValidationError([
      { path: ['logoAlt'], message: 'Logo alt text is required and cannot be blank.' },
    ]);

    expect(error.message).toBe(
      'This entry has 1 problem (the fields are highlighted in the form):\n' +
        '• logoAlt: Logo alt text is required and cannot be blank.',
    );
  });

  it('pluralises and bullets every problem', () => {
    const error = toValidationError([
      { path: ['slug'], message: 'Bad slug.' },
      { path: ['seo', 'metaTitle'], message: 'Too long.' },
    ]);

    expect(error.message).toBe(
      'This entry has 2 problems (the fields are highlighted in the form):\n' +
        '• slug: Bad slug.\n' +
        '• seo.metaTitle: Too long.',
    );
  });

  it('carries details.errors[].path so the admin can highlight the field', () => {
    const error = toValidationError([
      { path: ['newlyAdded', 'items', 1, 'cardImage'], message: 'Wrong size.' },
    ]);

    expect(details(error).errors).toEqual([
      {
        path: ['newlyAdded', 'items', 1, 'cardImage'],
        message: 'Wrong size.',
        name: 'ValidationError',
      },
    ]);
    expect(details(error).problems).toEqual([
      'newlyAdded.items.1.cardImage: Wrong size.',
    ]);
  });

  it('omits the path prefix for a problem with no field', () => {
    const error = toValidationError([{ path: [], message: 'Something is wrong.' }]);

    expect(error.message).toContain('• Something is wrong.');
    expect(details(error).problems).toEqual(['Something is wrong.']);
  });
});

describe('ProblemCollector', () => {
  it('is a no-op when nothing found a problem', async () => {
    const collector = new ProblemCollector();
    await collector.run(() => undefined);
    await collector.run(async () => undefined);

    expect(collector.length).toBe(0);
    expect(() => collector.throwIfAny()).not.toThrow();
  });

  it('merges problems from every validator instead of stopping at the first', async () => {
    // The whole point: before this, a slug problem hid the blank-field problem.
    const collector = new ProblemCollector();

    await collector.run(() => {
      throw validationError([
        { path: ['slug'], message: 'Slug may contain lowercase letters only.' },
      ]);
    });
    await collector.run(() => undefined);
    await collector.run(() => {
      throw validationError([
        { path: ['logoAlt'], message: 'Logo alt text is required.' },
        { path: ['seo', 'metaTitle'], message: 'SEO title is required.' },
      ]);
    });

    expect(collector.length).toBe(3);
    expect(() => collector.throwIfAny()).toThrow(errors.ValidationError);

    try {
      collector.throwIfAny();
    } catch (error) {
      expect(details(error).errors.map((e) => e.path)).toEqual([
        ['slug'],
        ['logoAlt'],
        ['seo', 'metaTitle'],
      ]);
      expect((error as Error).message).toContain('has 3 problems');
    }
  });

  it('keeps validator order in the merged list', async () => {
    const collector = new ProblemCollector();
    for (const field of ['a', 'b', 'c']) {
      await collector.run(() => {
        throw validationError([{ path: [field], message: `${field} is wrong.` }]);
      });
    }

    expect(collector.problems.map((p) => p.path[0])).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates the same field flagged by two validators', async () => {
    const collector = new ProblemCollector();
    const duplicate = () => {
      throw validationError([
        { path: ['seo', 'metaTitle'], message: 'SEO title is required.' },
      ]);
    };

    await collector.run(duplicate);
    await collector.run(duplicate);
    await collector.run(() => {
      throw validationError([
        { path: ['seo', 'metaTitle'], message: 'SEO title is too long.' },
      ]);
    });

    expect(collector.problems).toEqual([
      { path: ['seo', 'metaTitle'], message: 'SEO title is required.' },
      { path: ['seo', 'metaTitle'], message: 'SEO title is too long.' },
    ]);
    expect(collector.length).toBe(2);

    try {
      collector.throwIfAny();
      throw new Error('expected throwIfAny to throw');
    } catch (error) {
      // Same path + same message collapses; same path + different message stays.
      expect(details(error).problems).toEqual([
        'seo.metaTitle: SEO title is required.',
        'seo.metaTitle: SEO title is too long.',
      ]);
    }
  });

  it('rethrows a non-ValidationError untouched so real bugs stay 500s', async () => {
    const collector = new ProblemCollector();
    const bug = new TypeError("Cannot read properties of undefined (reading 'slug')");

    await expect(
      collector.run(() => {
        throw bug;
      }),
    ).rejects.toBe(bug);

    expect(collector.length).toBe(0);
  });

  it('rethrows a rejected promise that is not a ValidationError', async () => {
    const collector = new ProblemCollector();
    const failure = new Error('database is down');

    await expect(collector.run(async () => Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });

  it('degrades a ValidationError with no details.errors to one path-less problem', async () => {
    const collector = new ProblemCollector();
    await collector.run(() => {
      throw new errors.ValidationError('Something core rejected.');
    });

    expect(collector.problems).toEqual([
      { path: [], message: 'Something core rejected.' },
    ]);
  });

  it('degrades a ValidationError whose details.errors is empty', async () => {
    const collector = new ProblemCollector();
    await collector.run(() => {
      throw new errors.ValidationError('Empty details.', { errors: [] });
    });

    expect(collector.problems).toEqual([{ path: [], message: 'Empty details.' }]);
  });

  it('falls back to the outer message when a detail entry has no message', async () => {
    const collector = new ProblemCollector();
    await collector.run(() => {
      throw new errors.ValidationError('Outer message.', {
        errors: [{ path: ['slug'] }],
      });
    });

    expect(collector.problems).toEqual([
      { path: ['slug'], message: 'Outer message.' },
    ]);
  });
});
