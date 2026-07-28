import { errors } from '@strapi/utils';

import { isIdentityUid } from './identity-validation';

const FIELD_LIMITS = {
  metaTitle: 70,
  metaDescription: 170,
  ogTitle: 95,
  ogDescription: 200,
  ogImageAlt: 125,
} as const;

type Problem = { path: string[]; message: string };

function isValidCanonicalPath(value: string): boolean {
  return (
    value.startsWith('/')
    && !value.startsWith('//')
    && !value.includes('?')
    && !value.includes('#')
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f<>]/u.test(value)
  );
}

/**
 * Validates the hidden entity Deal-page SEO component when an internal API,
 * import, or future settings screen writes it. Ordinary entity saves omit the
 * component and therefore remain untouched.
 */
export function validateEntityDealPageSeo(
  uid: string,
  data: unknown,
): void {
  if (!isIdentityUid(uid) || !data || typeof data !== 'object') return;
  if (!Object.prototype.hasOwnProperty.call(data, 'entityDealPageSeo')) return;

  const value = Reflect.get(data, 'entityDealPageSeo');
  if (value === null || value === undefined) return;

  const problems: Problem[] = [];
  if (typeof value !== 'object' || Array.isArray(value)) {
    problems.push({
      path: ['entityDealPageSeo'],
      message: 'Deal-page SEO settings must be an object or null.',
    });
  } else {
    const indexingEnabled = Reflect.get(value, 'indexingEnabled');
    if (
      indexingEnabled !== undefined
      && indexingEnabled !== null
      && typeof indexingEnabled !== 'boolean'
    ) {
      problems.push({
        path: ['entityDealPageSeo', 'indexingEnabled'],
        message: 'Indexing enabled must be true or false.',
      });
    }

    for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
      const fieldValue = Reflect.get(value, field);
      if (fieldValue === undefined || fieldValue === null) continue;
      if (typeof fieldValue !== 'string') {
        problems.push({
          path: ['entityDealPageSeo', field],
          message: `${field} must be text or null.`,
        });
      } else if (fieldValue.trim().length > limit) {
        problems.push({
          path: ['entityDealPageSeo', field],
          message: `${field} must be at most ${limit} characters.`,
        });
      }
    }

    const canonicalUrl = Reflect.get(value, 'canonicalUrl');
    if (
      canonicalUrl !== undefined
      && canonicalUrl !== null
      && (
        typeof canonicalUrl !== 'string'
        || (canonicalUrl.trim() !== ''
          && !isValidCanonicalPath(canonicalUrl.trim()))
      )
    ) {
      problems.push({
        path: ['entityDealPageSeo', 'canonicalUrl'],
        message:
          'Canonical URL must be a root-relative path without a query, fragment, backslash, or markup.',
      });
    }
  }

  if (!problems.length) return;

  throw new errors.ValidationError(
    `Deal-page SEO settings contain ${problems.length} validation ${
      problems.length === 1 ? 'problem' : 'problems'
    }.`,
    {
      errors: problems.map((problem) => ({
        path: problem.path,
        message: problem.message,
        name: 'ValidationError',
      })),
      problems: problems.map(
        (problem) => `${problem.path.join('.')}: ${problem.message}`,
      ),
    },
  );
}
