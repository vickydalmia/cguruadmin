import { errors } from '@strapi/utils';

import { CANONICAL_PATH_RULE, isValidCanonicalPath } from './canonical-path';
import { isIdentityUid } from './identity-validation';

const FIELD_LIMITS = {
  metaTitle: 70,
  metaDescription: 170,
  ogTitle: 95,
  ogDescription: 200,
  ogImageAlt: 125,
} as const;

// These render into <title>, <meta content> and Open Graph tags. Angle
// brackets have no legitimate use in any of them, and the values reach a
// renderer outside this repository, so reject them here rather than relying
// on downstream escaping.
const MARKUP = /[<>]/u;

function isPositiveId(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  );
}

/** A media relation payload: an id, or an object carrying one. */
export function isMediaRef(value: unknown): boolean {
  if (isPositiveId(value)) return true;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return isPositiveId(Reflect.get(value, 'id'));
  }
  return false;
}

type Problem = { path: string[]; message: string };


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
      } else if (MARKUP.test(fieldValue)) {
        problems.push({
          path: ['entityDealPageSeo', field],
          message: `${field} must not contain < or >.`,
        });
      }
    }

    // ogImage is a media relation. It was the one allow-listed field with no
    // validation on either write path, so anything that arrived went straight
    // into the document.
    const ogImage = Reflect.get(value, 'ogImage');
    if (ogImage !== undefined && ogImage !== null && !isMediaRef(ogImage)) {
      problems.push({
        path: ['entityDealPageSeo', 'ogImage'],
        message:
          'ogImage must be a media id, an object with a numeric id, or null.',
      });
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
        message: `Canonical URL ${CANONICAL_PATH_RULE}.`,
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
