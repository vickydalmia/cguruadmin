// A single type has exactly one document, and the Content Manager edit view
// exposes no documentId for it (the PanelComponent prop is undefined there,
// and the admin URL is /single-types/<uid> with no id segment). Lock keys for
// single types therefore use this fixed pseudo document id — on BOTH sides:
// the RecordLockPanel acquire call and the enforcement middleware in
// src/index.ts must agree or single types silently go unguarded.
export const SINGLE_TYPE_LOCK_DOCUMENT_ID = 'single';
