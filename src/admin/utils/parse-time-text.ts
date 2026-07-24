/**
 * Pure helpers for the global `datetime` input override
 * (../components/DateTimeInput.tsx). Row 62.
 *
 * WHAT ACTUALLY HAPPENS (traced in
 * node_modules/@strapi/design-system/dist/index.mjs — the TimePicker at the
 * `vf` binding and the DateTimePicker at `Xm`):
 *
 * The design-system TimePicker is a free-text Combobox. It restricts typing
 * with `isPrintableCharacter = (i) => !!i.match(/^[^a-zA-Z]*$/)`, i.e. it
 * blocks letters but ALLOWS `-`, `.`, `+`, spaces and digits. On blur it runs:
 *
 *     b = (C) => {
 *       const [A, S] = C.split(f);              // f = locale time separator
 *       if (!A && !S) return;                   // empty -> bail out safely
 *       const M = Number(A ?? "0"), z = Number(S ?? "0");
 *       if (!(M > 23 || z > 59))
 *         return d.format(new Date(0, 0, 0, M, z));   // <-- throws
 *     }
 *
 * Two separate defects fall out of that:
 *
 *  1. A BARE NUMBER is silently accepted, not rejected: "7" splits to
 *     ["7"], so the minute side is `undefined`, `?? "0"` makes it 0, and the
 *     box commits 07:00. Surprising, but not a crash — and coercing a bare
 *     hour to o'clock is defensible, so this is left alone.
 *
 *  2. Anything whose numeric part is NOT FINITE crashes the admin. `Number("-")`,
 *     `Number(".")`, `Number("+")` and `Number("1-2")` are all NaN. NaN fails
 *     BOTH range guards (`NaN > 23` is false), so execution reaches
 *     `new Date(0, 0, 0, NaN, 0)` — an Invalid Date — and
 *     `Intl.DateTimeFormat.prototype.format` throws
 *     `RangeError: Invalid time value`. That throw happens inside a React
 *     onBlur handler, where error boundaries do NOT catch it, so it escapes to
 *     window and the edit form is left in a broken state. Typing a single `-`
 *     into the time box and clicking away is enough.
 *
 * There is a third crash on the render path: DateTimePicker's internal
 * `ei = (i, e) => { const t = i.toISOString(); ... }` calls `toISOString()` on
 * whatever `value` it is handed. A stored garbage datetime string becomes an
 * Invalid Date, and `toISOString()` on an Invalid Date throws the same
 * RangeError during render. `toSafeDate` below is the guard for that one.
 *
 * These functions are deliberately dependency-free and DOM-free so they can be
 * unit tested; vitest collects `src/ **∕*.test.ts` only, never `.tsx`.
 */

/** The separator the design system derives from the active locale, e.g. ":". */
export const DEFAULT_TIME_SEPARATOR = ':';

/**
 * A `Date` safe to hand to DateTimePicker, or undefined.
 *
 * Anything that does not parse to a finite instant — a malformed stored string,
 * an already-Invalid Date, null, a number — becomes `undefined`, which the
 * picker renders as an empty field. That is the correct degradation: an editor
 * sees a blank date box they can fill in, rather than a crashed form.
 */
export function toSafeDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

/**
 * ISO string for a picker value, or null to clear the field.
 *
 * Mirrors `toSafeDate`'s tolerance on the way back out so the component never
 * calls `.toISOString()` on an Invalid Date — the same RangeError, just on the
 * write path instead of the render path.
 */
export function toIsoStringOrNull(value: unknown): string | null {
  const safe = toSafeDate(value);
  return safe ? safe.toISOString() : null;
}

/**
 * Would this raw input text crash the design-system TimePicker's blur handler?
 *
 * Reimplements that handler's arithmetic exactly (see the module comment) and
 * reports only the inputs that reach the throwing `format(...)` call. It is a
 * deliberately NARROW predicate:
 *
 *  - `""` and `":"` are safe — the picker's own `!hour && !minute` guard bails
 *    out first and restores the committed value.
 *  - `"99"` and `"5:99"` are safe — the picker's range guard rejects them and
 *    restores the committed value.
 *  - `"7"` is safe — it commits 07:00 (defect 1 above, intentionally not
 *    treated as a crash).
 *
 * so the caller sanitises the smallest possible set of keystrokes and leaves
 * every already-working input untouched.
 *
 * `separators` accepts more than one because the separator is locale-derived
 * (most locales use ":", some use "."). Text unsafe under ANY candidate is
 * reported unsafe: a false positive merely reverts the box to its committed
 * value, while a false negative crashes the form.
 */
export function isUnsafeTimeText(
  value: unknown,
  separators: readonly string[] = [DEFAULT_TIME_SEPARATOR],
): boolean {
  if (typeof value !== 'string') return false;

  const candidates = separators.filter((separator) => separator.length > 0);
  if (!candidates.length) return false;

  return candidates.some((separator) => {
    const parts = value.split(separator);
    const hourPart = parts[0] ?? '';
    const minutePart = parts[1];

    // The picker returns early here, so nothing is formatted and nothing throws.
    if (!hourPart && !minutePart) return false;

    const hour = Number(hourPart);
    const minute = Number(minutePart ?? '0');

    // Out of range: rejected by the picker's own guard before it formats.
    // NaN comparisons are false, so a NaN never takes this branch — which is
    // precisely why it slips through to the crash.
    if (hour > 23 || minute > 59) return false;

    // `Number("")` is 0 and `Number("  ")` is 0, so only genuinely
    // unparseable text (and ±Infinity) lands here.
    return !Number.isFinite(hour) || !Number.isFinite(minute);
  });
}

/**
 * The time separator the design system will use, derived the same way it does:
 * the literal part of an hour/minute `Intl.DateTimeFormat`. Falls back to ":"
 * if Intl is unavailable or reports no literal, so the caller always has at
 * least one usable candidate.
 */
export function timeSeparatorsFor(locale?: string): string[] {
  const separators = new Set<string>([DEFAULT_TIME_SEPARATOR]);

  try {
    const parts = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(0));

    const literal = parts.find((part) => part.type === 'literal')?.value;
    if (literal) separators.add(literal);
  } catch {
    // Locale unsupported by the runtime — the ":" default already covers it.
  }

  return [...separators];
}
