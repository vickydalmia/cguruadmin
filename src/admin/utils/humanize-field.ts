// The one de-camel-casing helper for editor-facing field names. Two casing
// contracts share the same core so the split rule cannot drift between them:
// - humanizeFieldLower: 'cardImage' -> 'card image' — path continuations
//   rendered after a section-label prefix (error locations in
//   ValidationProblemsPanel via form-errors.ts).
// - humanizeField: 'websiteUrl' -> 'Website url' — standalone labels
//   (the pending-required "Needs attention" list).

export const humanizeFieldLower = (name: string): string =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

export function humanizeField(name: string): string {
  const spaced = humanizeFieldLower(name);
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
