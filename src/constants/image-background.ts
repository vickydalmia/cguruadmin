export const IMAGE_BACKGROUND_FALLBACK = '#F1F5F9';

const IMAGE_BACKGROUND_PATTERN = /^#[0-9A-F]{6}$/u;

export function normaliseImageBackgroundColour(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const colour = value.trim().toUpperCase();
  return IMAGE_BACKGROUND_PATTERN.test(colour) ? colour : null;
}
