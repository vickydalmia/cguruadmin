// The document-service actions that constitute a WRITE. Single source of
// truth for the two gates that must agree: the document-write middleware's
// entry gate (src/register/document-write-middleware.ts) and computeScope's
// action filter (src/isr-outbox/scopes.ts). If one set gained an action the
// other lacked, a write would pass the middleware but produce no invalidation
// scope — silently, with no error. Import this everywhere; never re-declare.
export const DOCUMENT_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'create',
  'clone',
  'update',
  'delete',
  'publish',
  'unpublish',
  'discardDraft',
]);
