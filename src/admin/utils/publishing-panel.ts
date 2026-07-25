/**
 * Pure logic behind the Publishing side panel
 * (src/admin/components/PublishingPanel.tsx).
 *
 * The panel presents an offer's lifecycle as two INDEPENDENT questions —
 * when does it start, and when does it end — rather than one three-way status
 * picker. That split is not cosmetic: `scheduledAt` and `expiresAt` are
 * orthogonal, and the most common promo shape ("goes live Friday, ends
 * Sunday") sets both. A single Published/Scheduled/Expired selector cannot
 * express it.
 *
 * Status itself stays DERIVED and read-only here, exactly as the server treats
 * it (src/utils/offer-lifecycle-validation.ts). The panel shows what the dates
 * imply; it never lets an editor assert a status the dates contradict — which
 * the 5-minute cron would overwrite within minutes anyway.
 */

export type StartMode = 'now' | 'later';
export type EndMode = 'never' | 'date';

const hasValue = (value: unknown): boolean =>
  value !== null && value !== undefined && value !== '';

/**
 * The radio positions implied by a freshly-loaded document. Seeds the panel's
 * local UI state — which then drives the value, not the other way round.
 *
 * WHY THE RADIO CANNOT BE DERIVED FROM THE VALUE ON EVERY RENDER: picking
 * "Schedule for later" has to reveal an EMPTY date box for the editor to fill.
 * If the radio re-derived itself from `scheduledAt` each render it would read
 * that empty value as "no schedule" and snap straight back to "Immediately",
 * making the option impossible to select. So the radio is local state, seeded
 * once per document by this function.
 */
export function seedModes(values: {
  scheduledAt?: unknown;
  expiresAt?: unknown;
}): { start: StartMode; end: EndMode } {
  return {
    start: hasValue(values.scheduledAt) ? 'later' : 'now',
    end: hasValue(values.expiresAt) ? 'date' : 'never',
  };
}

/**
 * The field writes a radio change implies. Switching AWAY from a date clears
 * it, so "Publish immediately" really does clear a stale schedule rather than
 * leaving an invisible value behind to fail validation on save. Switching TO a
 * date writes nothing — the editor fills the revealed picker themselves, and a
 * blank one is what tells them it still needs a value.
 */
export function fieldWriteForStartMode(mode: StartMode): { scheduledAt: null } | null {
  return mode === 'now' ? { scheduledAt: null } : null;
}

export function fieldWriteForEndMode(mode: EndMode): { expiresAt: null } | null {
  return mode === 'never' ? { expiresAt: null } : null;
}

/**
 * Whether the panel should warn that a revealed picker is still empty. The
 * server rejects the save anyway; saying so up front beats a round trip.
 */
export function pendingDateFields(
  modes: { start: StartMode; end: EndMode },
  values: { scheduledAt?: unknown; expiresAt?: unknown },
): string[] {
  const pending: string[] = [];
  if (modes.start === 'later' && !hasValue(values.scheduledAt)) {
    pending.push('Goes live');
  }
  if (modes.end === 'date' && !hasValue(values.expiresAt)) {
    pending.push('Ends');
  }
  return pending;
}

/** Design-system Status variant for each derived lifecycle state. */
export const STATUS_VARIANT: Record<string, 'success' | 'secondary' | 'danger'> = {
  published: 'success',
  scheduled: 'secondary',
  expired: 'danger',
};

export const STATUS_LABEL: Record<string, string> = {
  published: 'Published',
  scheduled: 'Scheduled',
  expired: 'Expired',
};
