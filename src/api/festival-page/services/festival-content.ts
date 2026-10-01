export const FESTIVAL_POPULATE = {
  countdown: true,
  hero: { populate: { desktopImage: true } },
  seo: { populate: { ogImage: true } },
} as const;

/** Activation is explicit and independent of optional section content. */
export function festivalTemplateEnabled(row: { enabled?: boolean | null } | null): boolean {
  return row?.enabled === true;
}
