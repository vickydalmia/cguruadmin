import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

/**
 * Write-time uniqueness for job slugs.
 *
 * The job `slug` attribute is a plain `string` (the `uid` type — whose
 * entity-validator enforced uniqueness implicitly — was dropped so the admin
 * stops offering slug regeneration), and this repo deliberately adds no DB
 * unique indexes (see identity-validation.ts). So this check is the only
 * duplicate guard, and it matters because both slug consumers take the FIRST
 * row matching a slug: the /careers/<slug>/ page
 * (api/career-page/controllers/custom.ts) and the application submit endpoint
 * public careers routes resolve a job by slug — a duplicate would silently
 * route readers and applications to whichever row sorts first.
 *
 * Same grandfathering rule as identity-validation: only a payload that
 * actually carries `slug` pays for the read, so partial updates never block
 * on a value their author never touched. Clone is the exception — Strapi
 * merges the omitted slug from the source after middleware, which makes an
 * un-edited clone a guaranteed duplicate, so the inherited slug is checked
 * (and rejected) as a new document. Runs in LOCKED_STEPS under the 'job'
 * advisory-lock domain so two concurrent saves cannot both pass on the same
 * committed snapshot.
 */

export const JOB_UID = 'api::job.job';

export async function validateJobSlug(
  strapi: Core.Strapi,
  uid: string,
  action: string,
  data: unknown,
  documentId?: string,
): Promise<void> {
  if (uid !== JOB_UID) return;

  const isClone = action === 'clone';
  const slugTouched =
    !!data &&
    typeof data === 'object' &&
    Object.prototype.hasOwnProperty.call(data, 'slug');
  if (!isClone && !slugTouched) return;

  let slug: unknown = slugTouched ? Reflect.get(data as object, 'slug') : undefined;
  // `undefined` — whether from an omitted key or an explicit `slug: undefined`
  // own property — is stripped by Strapi and merged from the source after
  // middleware, so both clone shapes inherit the source slug and must be
  // checked against it. Other non-string values (null, numbers) are genuinely
  // provided and left to the schema's required/regex validation.
  if (isClone && slug === undefined && documentId) {
    const source: unknown = await strapi.documents(JOB_UID).findOne({
      documentId,
      fields: ['slug'],
    });
    // Source missing: let Strapi report its own not-found error.
    if (!source || typeof source !== 'object') return;
    slug = Reflect.get(source, 'slug');
  }
  // Blank slugs are the schema `required` rule's problem, not a collision.
  if (typeof slug !== 'string' || !slug.trim()) return;
  const incoming = slug.trim();

  // Updates replace their own row and therefore exclude it; a clone leaves
  // its source in place, so the source participates in the check.
  const excludeDocumentId = action === 'update' ? documentId : undefined;
  const collision = await strapi.documents(JOB_UID).findFirst({
    filters: {
      // $eqi: the schema regex forces lowercase on new writes, but a legacy
      // uppercase row must still collide with its lowercase twin.
      slug: { $eqi: incoming },
      ...(excludeDocumentId ? { documentId: { $ne: excludeDocumentId } } : {}),
    },
    fields: ['documentId', 'slug', 'title'],
  });
  if (!collision) return;

  const message =
    `Slug "${incoming}" is already used by the job ` +
    `"${collision.title ?? collision.slug}". Job slugs must be unique: ` +
    `/careers/${collision.slug}/ and the application form both look up jobs ` +
    `by slug and would silently pick one of the two rows. Choose a different slug.`;
  throw new errors.ValidationError(message, {
    // The admin edit view maps details.errors[].path to an inline error on
    // that exact field (same mechanism as the identity checks).
    errors: [{ path: ['slug'], message, name: 'ValidationError' }],
    problems: [`slug: ${message}`],
  });
}
