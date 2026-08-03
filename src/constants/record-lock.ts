// A single type has exactly one document, and the Content Manager edit view
// exposes no documentId for it (the PanelComponent prop is undefined there,
// and the admin URL is /single-types/<uid> with no id segment). Lock keys for
// single types therefore use this fixed pseudo document id — resolved in
// EXACTLY ONE place, the record-lock service (callers omit documentId for
// single types), so the panel and the enforcement middleware cannot drift
// onto different keys.
export const SINGLE_TYPE_LOCK_DOCUMENT_ID = 'single';

// Added by the admin fetch interceptor to every Content Manager write. The
// document middleware verifies this exact per-tab lease instead of trusting
// adminUserId alone (the same admin may have a stale copy open in two tabs).
export const RECORD_LOCK_LEASE_HEADER = 'x-cguru-record-lock-lease';
