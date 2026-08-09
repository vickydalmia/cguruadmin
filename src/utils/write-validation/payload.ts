/**
 * Resolve the payload a validator should judge, in one place.
 *
 * A CLONE may carry no `data` at all while Strapi still deep-copies every
 * source field and relation — so a clone's missing payload normalizes to an
 * empty object and the validator judges the inherited state instead of
 * skipping it (hasOwn throws on null/undefined, so this must happen before
 * any field probe). Every other action with a non-object payload has nothing
 * to validate: the caller must return early on `null`.
 *
 * This rule previously lived as a copy-pasted idiom in three validators; a
 * validator that gains clone support must call THIS, not re-derive the gate.
 */
export function resolveWritePayload(
  action: string,
  data: unknown,
): object | null {
  if (data && typeof data === 'object') return data;
  return action === 'clone' ? ({} as object) : null;
}
